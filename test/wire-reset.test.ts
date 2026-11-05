import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { parseConfig } from '../src/core/config.js';
import { MixController } from '../src/core/controller.js';
import { ActionLog } from '../src/core/log.js';
import { paramKey } from '../src/core/revisions.js';
import {
  applyStateEvent,
  decodeStateValue,
  encodeStateValue,
  parseEvent,
  parseSnapshot,
  serializeEvent,
  serializeSnapshot,
  type MixerStateSnapshot,
  type StateEvent,
} from '../src/core/state.js';
import { LabMixer } from '../src/mixer/lab.js';
import { MASTER } from '../src/mixer/types.js';
import { confirmed, fixtureChannels, setup } from './helpers.js';

const VOZ1 = paramKey.level(1, MASTER);
const VOZ2 = paramKey.level(2, MASTER);

async function openLab() {
  const file = join(mkdtempSync(join(tmpdir(), 'mixai-reset-')), 'lab.json');
  const mixer = new LabMixer({ file, saveDebounceMs: 0 });
  await mixer.connect();
  const controller = new MixController(mixer, parseConfig({}).safety, new ChannelMap(fixtureChannels(), mixer.capabilities()), new ActionLog(null));
  return { mixer, controller, file };
}

describe('transmissão JSON de snapshots e eventos (ajuste 1)', () => {
  it('valores: -∞ vira "-inf"; unknown e unavailable continuam distintos; round-trip exato', () => {
    const cases = [
      { status: 'known', value: -Infinity },
      { status: 'known', value: -10 },
      { status: 'known', value: true },
      { status: 'unknown' },
      { status: 'unavailable' },
    ] as const;
    for (const v of cases) {
      const wire = JSON.parse(JSON.stringify(encodeStateValue(v)));
      expect(decodeStateValue(wire)).toEqual(v);
    }
    expect(JSON.stringify(encodeStateValue({ status: 'known', value: -Infinity }))).toBe('{"status":"known","value":"-inf"}');
    // O erro que o ajuste evita: JSON puro transformaria -∞ em null.
    expect(JSON.stringify({ value: -Infinity })).toBe('{"value":null}');
  });

  it('valor corrompido na transmissão é recusado, nunca adivinhado', () => {
    expect(() => decodeStateValue({ status: 'known', value: null })).toThrow(/inválido/);
    expect(() => decodeStateValue({ status: 'known' })).toThrow(/inválido/);
    expect(() => decodeStateValue({ status: 'talvez' })).toThrow(/status inválido/);
    expect(() => parseEvent('{"type":"params","fromRevision":0,"revision":1,"changes":[{"key":"xx","value":{"status":"unknown"},"revision":1}]}')).toThrow(
      /chave inválida/,
    );
  });

  it('snapshot com -∞, unknown e unavailable sobrevive a JSON.stringify/parse', async () => {
    const { controller, mixer } = await setup();
    await mixer.setLevelDB(2, MASTER, -Infinity);
    mixer.simulateUnknown(paramKey.level(3, MASTER));
    const s = controller.state.snapshot();
    const text = serializeSnapshot(s);
    expect(text).toContain('"value":"-inf"');
    expect(text).not.toContain('"value":null');
    expect(parseSnapshot(text)).toEqual(s);

    mixer.simulateDrop();
    const off = controller.state.snapshot();
    const back = parseSnapshot(serializeSnapshot(off));
    expect(back.params[VOZ1]!.value).toEqual({ status: 'unavailable' });
    expect(back).toEqual(off);
  });

  it('cliente remoto: snapshot + eventos via JSON reproduz o servidor (inclusive -∞)', async () => {
    const { controller, mixer, clock } = await setup({ bulkMuteConfirmAbove: 10, maxActionsPerSecond: 100 });
    // Tudo que o "cliente" recebe passa por texto JSON, como numa conexão WebSocket.
    let mirror: MixerStateSnapshot = parseSnapshot(serializeSnapshot(controller.state.snapshot()));
    const wire: string[] = [];
    controller.state.subscribe((e) => wire.push(serializeEvent(e)));

    await confirmed((id) => controller.setLevel({ channel: 'voz 1', db: -100, confirmationId: id })); // → -∞ (passo grande, pede confirmação)
    mixer.simulateExternalChange(VOZ2, -Infinity);
    mixer.simulateUnknown(paramKey.level(3, MASTER));
    mixer.simulateExternalChange(paramKey.mute(4, MASTER), true);
    clock.tick(1000);
    await controller.setMute({ channels: ['voz 1', 'voz 2', 'voz 3'], muted: true });
    mixer.simulateDrop();
    mixer.simulateResync();

    for (const text of wire) {
      const ev: StateEvent = parseEvent(text);
      if (applyStateEvent(mirror, ev) === 'gap') mirror = parseSnapshot(serializeSnapshot(controller.state.snapshot()));
    }
    expect(wire.some((t) => t.includes('"-inf"'))).toBe(true);
    expect(wire.every((t) => !t.includes('"value":null'))).toBe(true);
    expect(mirror).toEqual(controller.state.snapshot());
    expect(mirror.params[VOZ1]!.value).toEqual({ status: 'known', value: -Infinity });
  });
});

describe('alterações em lote e reset do laboratório (ajuste 2)', () => {
  it('reset pelo controlador: um único evento com todas as revisões, clientes sincronizados', async () => {
    const { controller } = await openLab();
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    await controller.setMute({ channels: ['surdo'], muted: true });
    await (controller.mixer as LabMixer).write(paramKey.eqBand(2, 3, 'gain'), 4);

    let mirror = parseSnapshot(serializeSnapshot(controller.state.snapshot()));
    const events: StateEvent[] = [];
    controller.state.subscribe((e) => events.push(parseEvent(serializeEvent(e))));

    const r = await controller.resetLab();
    expect(r.code).toBe('OK');
    expect(r.data).toEqual({ changed: 3 });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('params');
    if (ev.type !== 'params') return;
    expect(ev.changes.map((c) => c.key).sort()).toEqual(['ch.2.eq.b3.gain', 'ch.6.main.mute', 'ch.1.main.level'].sort());
    expect(ev.changes.every((c) => c.actor === 'reset')).toBe(true);
    expect(ev.revision - ev.fromRevision).toBe(3);

    expect(applyStateEvent(mirror, ev)).toBe('applied');
    expect(mirror).toEqual(controller.state.snapshot());
    expect(mirror.params[VOZ1]!.value).toEqual({ status: 'known', value: -10 });
  });

  it('reset invalida o desfazer e as confirmações pendentes', async () => {
    const { controller } = await openLab();
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    const pending = await controller.setLevel({ channel: 'surdo', deltaDB: 10 });
    const snapAsk = await controller.loadSnapshot({ show: 'Laboratório', snapshot: 'Bar' });
    expect(pending.code).toBe('NEEDS_CONFIRMATION');

    await controller.resetLab();
    expect((await controller.undo()).message).toContain('nada para desfazer');
    // O surdo não mudou no reset, mas a pendência de snapshot depende do estado global.
    expect((await controller.loadSnapshot({ show: 'Laboratório', snapshot: 'Bar', confirmationId: snapAsk.pendingId })).code).toBe(
      'CONFIRMATION_STALE',
    );
  });

  it('pendência de um parâmetro alterado pelo reset fica obsoleta', async () => {
    const { controller } = await openLab();
    await controller.setLevel({ channel: 'surdo', db: -12 });
    const ask = await controller.setLevel({ channel: 'surdo', deltaDB: 10 });
    await controller.resetLab(); // surdo volta a -10
    const r = await controller.setLevel({ channel: 'surdo', deltaDB: 10, confirmationId: ask.pendingId });
    expect(r.code).toBe('CONFIRMATION_STALE');
  });

  it('reset chamado direto no LabMixer também mantém os clientes sincronizados', async () => {
    const { controller, mixer } = await openLab();
    await controller.setLevel({ channel: 'voz 2', db: -4 });
    const mirror = controller.state.snapshot();
    const outcomes: string[] = [];
    controller.state.subscribe((e) => outcomes.push(applyStateEvent(mirror, parseEvent(serializeEvent(e)))));
    const changed = mixer.resetToDefaults();
    expect(changed).toEqual([VOZ2]);
    expect(outcomes).toEqual(['applied']);
    expect(mirror).toEqual(controller.state.snapshot());
    expect(mirror.params[VOZ2]).toMatchObject({ value: { status: 'known', value: -10 }, actor: 'reset' });
  });

  it('reset sem nada para mudar não gera evento', async () => {
    const { controller } = await openLab();
    let n = 0;
    controller.state.subscribe(() => n++);
    expect((await controller.resetLab()).data).toEqual({ changed: 0 });
    expect(n).toBe(0);
  });

  it('reset persiste e é serializado com os outros comandos (fila)', async () => {
    const { controller, file } = await openLab();
    const [, r] = await Promise.all([controller.setLevel({ channel: 'voz 1', db: -8 }), controller.resetLab()]);
    expect(r.code).toBe('OK');
    expect(controller.mixer.read(VOZ1)).toEqual({ known: true, value: -10 });
    (controller.mixer as LabMixer).flush();
    const reopened = new LabMixer({ file });
    await reopened.connect();
    expect(reopened.read(VOZ1)).toEqual({ known: true, value: -10 });
  });

  it('fora do laboratório o reset é recusado', async () => {
    const { controller } = await setup();
    const r = await controller.resetLab();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID');
  });

  it('mudança em lote (ressincronização com vários valores) chega íntegra ao cliente', async () => {
    const { controller, mixer } = await setup();
    let mirror = parseSnapshot(serializeSnapshot(controller.state.snapshot()));
    controller.state.subscribe((e) => {
      if (applyStateEvent(mirror, parseEvent(serializeEvent(e))) === 'gap') mirror = parseSnapshot(serializeSnapshot(controller.state.snapshot()));
    });
    mixer.simulateDrop();
    mixer.simulateResync([
      [VOZ1, -Infinity],
      [VOZ2, -3],
      [paramKey.mute(5, MASTER), true],
    ]);
    expect(mirror).toEqual(controller.state.snapshot());
    expect(mirror.params[VOZ1]!.value).toEqual({ status: 'known', value: -Infinity });
    await confirmed((id) => controller.setMaster({ deltaDB: 1, confirmationId: id }));
    expect(mirror).toEqual(controller.state.snapshot());
  });
});
