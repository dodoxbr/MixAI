import { afterEach, describe, expect, it } from 'vitest';
import {
  DBToFaderValue,
  frequencyToFaderValue,
  qToFaderValue,
  eqGainDBToFaderValue,
} from 'soundcraft-ui-connection';
import { createApp } from '../src/core/app.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { applyStateEvent } from '../src/core/state.js';
import { ActionLog } from '../src/core/log.js';
import { fixtureChannels } from './helpers.js';
import { parseConfig } from '../src/core/config.js';
import { loadConfig } from '../src/core/config.js';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import type { ParamKey } from '../src/core/revisions.js';
import {
  createFakeUi,
  stateMessages,
  waitFor,
} from './support/fake-ui-socket.js';

const required: ParamKey[] = [
  'ch.2.main.level',
  'ch.2.main.mute',
  'ch.2.aux.1.level',
  'ch.2.aux.1.mute',
  'master.level',
];
const bridges: Ui16RealBridge[] = [];
function setup(extra: Record<string, unknown> = {}) {
  const fake = createFakeUi({
    initialState: () => stateMessages({ channels: [2], aux: [1] }),
  });
  const bridge = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: required,
    watchedKeys: [...required, 'ch.2.eq.hpf.slope'],
    webSocketCtor: fake.Ctor,
    reconnectBaseMs: 5,
    reconnectMaxDelayMs: 10,
    ...extra,
  });
  bridges.push(bridge);
  return { fake, bridge };
}
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.disconnect()));
});
describe('Ui16 read bridge (synthetic protocol, no network)', () => {
  it('factory cannot enable physical writes by passing readOnly false', async () => {
    const config = loadConfig({}, ['node', 'test', '--real']);
    config.logDir = null;
    const app = await createApp(config, { readOnly: false });
    expect(app.mixer).toBeInstanceOf(Ui16RealBridge);
    await expect(app.mixer.write('ch.2.aux.1.level', -19)).rejects.toThrow(
      'BRIDGE_PHYSICAL_WRITE_UNVALIDATED',
    );
    expect(app.mixer.link()).toBe('DISCONNECTED');
    await app.mixer.disconnect();
  });
  it('observes fader/AUX/mute, optional EQ/HPF and reported identity, never promotes slope', async () => {
    const { bridge: b, fake: f } = setup();
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    expect(b.identity().verification).toBe('unconfirmed');
    expect(b.reading('ch.2.aux.1.level')).toMatchObject({
      state: 'confirmed',
      source: 'device_stream',
      hardwareValidation: 'pending',
    });
    expect(b.reading('ch.2.eq.b1.freq').state).toBe('pending');
    f.last().deliver(
      'SETS^model^ui16',
      `SETD^i.1.eq.b1.freq^${frequencyToFaderValue(1000)}`,
      `SETD^i.1.eq.b1.q^${qToFaderValue(1)}`,
      `SETD^i.1.eq.b1.gain^${eqGainDBToFaderValue(-3)}`,
      `SETD^i.1.eq.hpf.freq^${frequencyToFaderValue(80)}`,
      'SETD^i.1.eq.bypass^1',
      'SETD^i.1.mute^1',
    );
    expect(b.identity().verification).toBe('device_reported_not_authenticated');
    expect(b.read('ch.2.eq.b1.freq')).toEqual({ known: true, value: 1000 });
    expect(b.read('ch.2.eq.b1.q')).toEqual({ known: true, value: 1 });
    expect(b.read('ch.2.eq.b1.gain')).toEqual({ known: true, value: -3 });
    expect(b.read('ch.2.eq.hpf.freq')).toEqual({ known: true, value: 80 });
    expect(b.read('ch.2.eq.bypass')).toEqual({ known: true, value: true });
    expect(b.read('ch.2.main.mute')).toEqual({ known: true, value: true });
    expect(b.reading('ch.2.eq.hpf.slope')).toMatchObject({
      state: 'unavailable',
      reason: 'unsupported',
    });
    expect(f.sockets.flatMap((s) => s.commands())).toEqual([]);
  });
  it('external and duplicate changes update state without writing or touching master', async () => {
    const { bridge: b, fake: f } = setup();
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    const master = b.read('master.level');
    const seen: ParamKey[] = [];
    b.onParamChange((k) => seen.push(k));
    f.last().deliver(
      `SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`,
      `SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`,
      `SETD^i.1.mix^${DBToFaderValue(-12)}`,
    );
    expect(b.read('ch.2.aux.1.level')).toEqual({ known: true, value: -19 });
    expect(seen.filter((k) => k === 'ch.2.aux.1.level')).toHaveLength(1);
    expect(b.read('master.level')).toEqual(master);
    expect(f.last().commands()).toEqual([]);
  });
  it('drops stale values, reconnects with a fresh generation and ignores retired frames', async () => {
    const { bridge: b, fake: f } = setup();
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    const old = f.last(),
      gen = b.supervisor.generation();
    old.drop();
    expect(b.reading('ch.2.aux.1.level').state).toBe('stale');
    expect(b.read('ch.2.aux.1.level')).toEqual({ known: false });
    await waitFor(
      () => b.supervisor.generation() > gen && b.link() === 'READY',
    );
    old.deliver('SETS^model^ui12', `SETD^i.1.aux.0.value^${DBToFaderValue(0)}`);
    expect(b.read('ch.2.aux.1.level')).toEqual({ known: true, value: -20 });
    expect(b.identity().reportedModel).toBe('unknown');
    expect(f.sockets.flatMap((s) => s.commands())).toEqual([]);
  });
  it('quarantines silent connections and requires fresh required frames, not a heartbeat', async () => {
    let now = 0;
    const { bridge: b, fake: f } = setup({
      clock: () => now,
      inboundSilenceMs: 20,
    });
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    f.last().deliver(`SETD^i.1.eq.b1.gain^${eqGainDBToFaderValue(-3)}`);
    expect(b.read('ch.2.eq.b1.gain')).toEqual({ known: true, value: -3 });
    now = 21;
    expect(b.link()).toBe('SYNCING');
    expect(b.reading('ch.2.main.level').state).toBe('stale');
    f.last().deliver('ALIVE');
    expect(b.read('ch.2.main.level')).toEqual({ known: false });
    f.last().deliver(`SETD^i.1.mix^${DBToFaderValue(-11)}`);
    expect(b.read('ch.2.main.level')).toEqual({ known: true, value: -11 });
    expect(b.link()).toBe('SYNCING');
    f.last().deliver(...stateMessages({ channels: [2], aux: [1] }));
    expect(b.link()).toBe('READY');
    expect(b.reading('ch.2.eq.b1.gain').state).toBe('stale');
    expect(b.read('ch.2.eq.b1.gain')).toEqual({ known: false });
    f.last().deliver(`SETD^i.1.eq.b1.gain^${eqGainDBToFaderValue(-3)}`);
    expect(b.read('ch.2.eq.b1.gain')).toEqual({ known: true, value: -3 });
  });
  it.each([
    'SETD^i.1.mix^NaN',
    'SETD^i.1.eq.b1.gain^9',
    'SETD^i.1.mute^0.5',
    'SETS^model^ui24',
  ])('seals invalid or mismatched input: %s', async (frame) => {
    const { bridge: b, fake: f } = setup();
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    f.last().deliver(frame);
    expect(b.link()).toBe('STOPPED');
    expect(b.read('ch.2.main.level')).toEqual({ known: false });
    await expect(b.connect()).rejects.toThrow('BRIDGE_SEALED');
  });
  it('blocks every physical write, snapshots and direct socket mutation', async () => {
    const { bridge: b, fake: f } = setup();
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    for (const key of [
      'ch.2.aux.1.level',
      'master.level',
      'ch.2.main.mute',
      'ch.2.eq.b1.gain',
    ] as ParamKey[])
      await expect(b.write(key, 0)).rejects.toThrow(
        'BRIDGE_PHYSICAL_WRITE_UNVALIDATED',
      );
    await expect(b.loadSnapshot('x', 'y')).rejects.toThrow(
      'BRIDGE_PHYSICAL_WRITE_UNVALIDATED',
    );
    f.last().send('3:::SETD^i.1.aux.0.value^0.5');
    expect(b.link()).toBe('STOPPED');
    expect(f.last().commands()).toEqual([]);
  });
  it('reports blocked physical attempts as not sent through the existing controller', async () => {
    const { bridge: b, fake: f } = setup();
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    const c = new MixController(
      b,
      parseConfig({}).safety,
      new ChannelMap(fixtureChannels(), b.capabilities()),
      new ActionLog(null),
    );
    const result = await c.setLevel({ channel: 2, aux: 1, deltaDB: 1 });
    expect(result.ok).toBe(false);
    expect(result.data?.changes).toMatchObject([
      { key: 'ch.2.aux.1.level', outcome: 'not_sent' },
    ]);
    expect(b.read('ch.2.aux.1.level')).toEqual({ known: true, value: -20 });
    expect(f.last().commands()).toEqual([]);
  });
  it('invalidates existing HTTP/WS state mirrors on silence, then demands a fresh snapshot', async () => {
    let now = 0;
    const { bridge: b, fake: f } = setup({
      clock: () => now,
      inboundSilenceMs: 20,
    });
    await b.connect();
    await waitFor(() => b.link() === 'READY');
    const c = new MixController(
      b,
      parseConfig({}).safety,
      new ChannelMap(fixtureChannels(), b.capabilities()),
      new ActionLog(null),
    );
    const mirror = c.state.snapshot(required);
    const outcomes: string[] = [];
    c.state.subscribe((event) => outcomes.push(applyStateEvent(mirror, event)));
    now = 21;
    await waitFor(() => mirror.available === false);
    expect(mirror.params['ch.2.aux.1.level']?.value).toEqual({
      status: 'unavailable',
    });
    expect(c.state.snapshot(required).available).toBe(false);
    f.last().deliver(...stateMessages({ channels: [2], aux: [1] }));
    await waitFor(() => outcomes.includes('gap'));
    expect(
      c.state.snapshot(required).params['ch.2.aux.1.level']?.value,
    ).toEqual({ status: 'known', value: -20 });
  });
});
