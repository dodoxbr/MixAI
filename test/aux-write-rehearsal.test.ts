import { describe, expect, it, vi } from 'vitest';
import {
  createAuxWriteRehearsal,
  type AuxRehearsalPermit,
} from '../src/mixer/aux-write-rehearsal.js';
import { MockMixer } from '../src/mixer/mock.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import { fixtureChannels } from './helpers.js';
import type { ParamKey, ParamValue } from '../src/core/revisions.js';
import type { WriteOutcome } from '../src/mixer/types.js';

const key: ParamKey = 'ch.2.aux.1.level';
function permit(
  overrides: Partial<AuxRehearsalPermit> = {},
): AuxRehearsalPermit {
  return {
    requestId: 'one',
    role: 'operator',
    humanConfirmed: true,
    channel: 2,
    aux: 1,
    fromDB: -20,
    toDB: -19,
    authorized: () => true,
    ...overrides,
  };
}
async function setup(sim = new MockMixer()) {
  await sim.connect();
  const rehearsal = createAuxWriteRehearsal(sim);
  const controller = new MixController(
    rehearsal.mixer,
    parseConfig({}).safety,
    new ChannelMap(fixtureChannels(), sim.capabilities()),
    new ActionLog(null),
  );
  return { sim, rehearsal, controller };
}
describe('controlled AUX rehearsal, simulated only', () => {
  it('requires explicit operator consent, restricts delta/scope, rejects REAL', async () => {
    expect(() => createAuxWriteRehearsal({ mode: 'real' } as never)).toThrow(
      'SIMULATION_ONLY',
    );
    const { sim, rehearsal: r } = await setup();
    for (const p of [
      permit({ role: 'musician' as never }),
      permit({ humanConfirmed: false as never }),
      permit({ toDB: -18 }),
      permit({ aux: 7 }),
      permit({ authorized: () => false }),
    ])
      expect(() => r.prepare(p)).toThrow();
    await expect(r.mixer.write(key, -19)).rejects.toThrow('NOT_AUTHORIZED');
    r.prepare(permit());
    await expect(r.mixer.write('master.level', -19)).rejects.toThrow(
      'STATE_CHANGED',
    );
    expect(sim.writes).toEqual([]);
    expect(() => r.prepare(permit())).toThrow('INVALID_PERMIT');
  });
  it('reads after write, retains existing controller policies and undo, never touches master', async () => {
    const { sim, rehearsal: r, controller: c } = await setup();
    const master = sim.read('master.level');
    r.prepare(permit());
    expect((await c.setLevel({ channel: 2, aux: 1, deltaDB: 1 })).ok).toBe(
      true,
    );
    expect(sim.read(key)).toEqual({ known: true, value: -19 });
    r.prepare(permit({ requestId: 'undo', fromDB: -19, toDB: -20 }));
    expect((await c.undo()).ok).toBe(true);
    expect(sim.read(key)).toEqual({ known: true, value: -20 });
    expect(sim.read('master.level')).toEqual(master);
    expect(sim.writes).toEqual([`${key}=-19`, `${key}=-20`]);
  });
  it('does not grant replay or accept changed/revoked sessions', async () => {
    const { sim, rehearsal: r } = await setup();
    let active = true;
    r.prepare(permit({ authorized: () => active }));
    active = false;
    await expect(r.mixer.write(key, -19)).rejects.toThrow('NOT_AUTHORIZED');
    r.prepare(permit({ requestId: 'two' }));
    sim.simulateExternalChange(key, -22);
    await expect(r.mixer.write(key, -19)).rejects.toThrow('STATE_CHANGED');
    await expect(r.mixer.write(key, -19)).rejects.toThrow('NOT_AUTHORIZED');
    expect(sim.writes).toEqual([]);
  });
  it.each(['different', 'disconnect', 'revoked'] as const)(
    'returns uncertainty on %s during write, without retry',
    async (failure) => {
      let active = true;
      class Interleaved extends MockMixer {
        override async write(
          k: ParamKey,
          v: ParamValue,
        ): Promise<WriteOutcome> {
          const outcome = await super.write(k, v);
          if (failure === 'different') this.simulateExternalChange(k, -22);
          if (failure === 'disconnect') this.simulateDrop();
          if (failure === 'revoked') active = false;
          return outcome;
        }
      }
      const { sim, rehearsal: r } = await setup(new Interleaved());
      r.prepare(permit({ authorized: () => active }));
      await expect(r.mixer.write(key, -19)).rejects.toThrow('UNCERTAIN');
      await expect(r.mixer.write(key, -19)).rejects.toThrow('NOT_AUTHORIZED');
      expect(sim.writes).toHaveLength(1);
    },
  );
  it('serializes delayed operations without allowing a second permission or snapshot', async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => (release = resolve));
    class Delayed extends MockMixer {
      override async write(k: ParamKey, v: ParamValue) {
        await delayed;
        return super.write(k, v);
      }
    }
    const { sim, rehearsal: r } = await setup(new Delayed());
    r.prepare(permit());
    const first = r.mixer.write(key, -19);
    expect(() => r.prepare(permit({ requestId: 'two' }))).toThrow(
      'INVALID_PERMIT',
    );
    await expect(r.mixer.write(key, -19)).rejects.toThrow('NOT_AUTHORIZED');
    await expect(r.mixer.loadSnapshot('Pagode', 'Ensaio')).rejects.toThrow(
      'AUX_REHEARSAL_ONLY',
    );
    release();
    expect(await first).toBe('applied_simulated');
    expect(sim.writes).toHaveLength(1);
  });
  it('times out without replay; a late simulated completion remains uncertain', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => (release = resolve));
    class Delayed extends MockMixer {
      override async write(k: ParamKey, v: ParamValue) {
        await delayed;
        return super.write(k, v);
      }
    }
    try {
      const { sim, rehearsal: r } = await setup(new Delayed());
      r.prepare(permit());
      const result = expect(r.mixer.write(key, -19)).rejects.toThrow(
        'UNCERTAIN',
      );
      await vi.advanceTimersByTimeAsync(1000);
      await result;
      expect(() => r.prepare(permit({ requestId: 'no-retry' }))).toThrow(
        'INVALID_PERMIT',
      );
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(sim.writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('expires an unused human permit', async () => {
    vi.useFakeTimers();
    try {
      const { sim, rehearsal: r } = await setup();
      r.prepare(permit());
      await vi.advanceTimersByTimeAsync(15001);
      await expect(r.mixer.write(key, -19)).rejects.toThrow('NOT_AUTHORIZED');
      expect(sim.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('existing undo refuses to overwrite a later external change', async () => {
    const { sim, rehearsal: r, controller: c } = await setup();
    r.prepare(permit());
    expect((await c.setLevel({ channel: 2, aux: 1, deltaDB: 1 })).ok).toBe(
      true,
    );
    sim.simulateExternalChange(key, -22);
    r.prepare(permit({ requestId: 'undo', fromDB: -22, toDB: -23 }));
    await c.undo();
    expect(sim.read(key)).toEqual({ known: true, value: -22 });
    expect(sim.writes).toHaveLength(1);
    r.cancel();
  });
});
