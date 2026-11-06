import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ui16ReadOnlyObserver, type ObserverOptions } from '../src/mixer/readonly-observer.js';
import { exportObserverReport, MAX_OBSERVER_BYTES, ObserverReportSchema, parseObserverReport } from '../src/mixer/observer-report.js';
import { isObserverReadFrame, observerSocketGate, type ObserverSocketCtor } from '../src/mixer/readonly-socket.js';
import { RealMixer } from '../src/mixer/real.js';
import { ConnectionSupervisor } from '../src/mixer/connection-supervisor.js';
import { createFakeUi, stateMessages } from './support/fake-ui-socket.js';

const sessions: Ui16ReadOnlyObserver[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(0);
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Rede real proibida neste teste.'); } });
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function setup(complete = true, extra: Partial<ObserverOptions> = {}) {
  const fake = createFakeUi({ autoOpen: false });
  const session = new Ui16ReadOnlyObserver({ ip: 'private-fixture.invalid', source: 'fake_websocket', webSocketCtor: fake.Ctor,
    scope: { channels: [1], aux: [], master: false }, appVersion: '0.7.0',
    durationMs: 30_000, connectTimeoutMs: 200, syncTimeoutMs: 20, reconnectBaseMs: 10, reconnectMaxDelayMs: 20,
    recoveryTimeoutMs: 100, zombieWatchMs: 5, clock: () => Date.now(), ...extra } as ObserverOptions);
  sessions.push(session);
  const start = session.start();
  fake.last()?.open();
  if (complete) fake.last()?.deliver(...stateMessages({ channels: [1], aux: [] }));
  return { fake, session, start };
}
const params = (s: Ui16ReadOnlyObserver) => s.report().events.filter((e) => e.type === 'parameter');
const assertReadOnly = (fake: ReturnType<typeof createFakeUi>) => {
  expect(fake.sockets.flatMap((s) => s.commands())).toEqual([]);
  expect(fake.sockets.flatMap((s) => s.sent).every(isObserverReadFrame)).toBe(true);
};

it('observa sync/level/mute/−∞; usa rótulos lógicos, ignora EQ/nomes e não chama APIs de escrita', async () => {
  const write = vi.spyOn(RealMixer.prototype, 'write'), load = vi.spyOn(RealMixer.prototype, 'loadSnapshot');
  const dispatch = vi.spyOn(ConnectionSupervisor.prototype, 'write'), action = vi.spyOn(ConnectionSupervisor.prototype, 'withReadyUi');
  const { session, fake, start } = setup(); await start;
  expect(session.report().events.some((e) => e.type === 'snapshot' && e.complete)).toBe(true);
  fake.last()!.deliver('SETD^i.0.mute^1', 'SETD^i.0.mix^0', 'SETS^i.0.name^PIN_TOKEN_192.168.50.10', 'SETD^i.0.eq.b1.gain^3');
  expect(params(session).filter((e) => e.origin === 'external')).toHaveLength(2);
  expect(params(session).at(-1)!.sample.reading).toEqual({ state: 'observed', value: '-inf' });
  expect(session.report().scope.aux).toEqual([]);
  expect(session.report().excludedCapabilities).toContain('eq_hpf_simulated_only');
  expect(write).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
  await session.stop();
  const json = exportObserverReport(session.report(), 'json');
  expect(json).not.toMatch(/PIN_TOKEN|192\.168|private-fixture|\.name|appVersion.*secret/);
  expect(exportObserverReport(session.report(), 'markdown')).toContain('CH 1 · PA');
  expect(session.report().ended).toBe(true); assertReadOnly(fake);
});

it('snapshot incompleto não inventa zero; chegada fora de ordem e duplicada mantém origem resync', async () => {
  const { session, fake, start } = setup(false);
  fake.last()!.deliver('SETD^i.0.mute^0', 'SETD^i.0.mute^0');
  await vi.advanceTimersByTimeAsync(21); await start;
  const partial = session.report().events.filter((e) => e.type === 'snapshot').at(-1);
  expect(partial).toMatchObject({ type: 'snapshot', link: 'DEGRADED_READ_ONLY', complete: false });
  if (partial?.type === 'snapshot') expect(partial.samples[0]!.reading).toEqual({ state: 'unknown', reason: 'not_received' });
  // A biblioteca já filtra esta duplicata antes de chegar ao observador.
  expect(params(session)).toHaveLength(1);
  expect(session.report().counters.duplicatesSuppressed).toBe(0);
  fake.last()!.deliver('SETD^i.0.mix^0');
  const complete = session.report().events.filter((e) => e.type === 'snapshot').at(-1);
  expect(complete).toMatchObject({ link: 'READY', complete: true });
  expect(params(session).every((e) => e.origin === 'resync')).toBe(true);
  const count = params(session).length;
  fake.last()!.deliver('SETD^i.0.mix^0', 'SETD^i.0.mute^0');
  expect(params(session)).toHaveLength(count); assertReadOnly(fake);
});

it('três perdas/recuperações invalidam valores; gerações antigas e eventos tardios nunca voltam/replay', async () => {
  const { session, fake, start } = setup(); await start;
  for (let i = 0; i < 3; i++) {
    const old = fake.last()!; old.drop();
    const lost = session.report().events.filter((e) => e.type === 'snapshot').at(-1);
    if (lost?.type === 'snapshot') expect(lost.samples.every((s) => s.reading.state === 'unavailable')).toBe(true);
    const before = params(session).length;
    old.deliver('SETD^i.0.mute^1'); expect(params(session)).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(11);
    expect(fake.last()).not.toBe(old);
    fake.last()!.open(); fake.last()!.deliver(...stateMessages({ channels: [1], aux: [] }));
    old.deliver('SETD^i.0.mix^0'); expect(params(session).at(-1)!.origin).toBe('resync');
  }
  // Além do retry automático de 2 s e da vigia reduzida; não aparece socket zumbi.
  await vi.advanceTimersByTimeAsync(2600);
  expect(fake.sockets).toHaveLength(4); expect(fake.alive()).toHaveLength(1);
  assertReadOnly(fake); await session.stop();
  const evidence = exportObserverReport(session.report(), 'json');
  await vi.advanceTimersByTimeAsync(40_000);
  expect(exportObserverReport(session.report(), 'json')).toBe(evidence);
  expect(fake.sockets).toHaveLength(4); expect(fake.alive()).toHaveLength(0);
  expect(session.report().events.at(-1)).toMatchObject({ type: 'end', link: 'DISCONNECTED' });
});

it('a sessão fixa readOnly:true e bloqueia chamadas deliberadas à API também após reconectar (só no falso)', async () => {
  let captured: RealMixer | undefined;
  const original = RealMixer.prototype.connect;
  vi.spyOn(RealMixer.prototype, 'connect').mockImplementation(function (this: RealMixer) { captured = this; return original.call(this); });
  const { session, fake, start } = setup(); await start;
  const reject = async () => {
    await expect(captured!.write('ch.1.main.level', -1)).rejects.toThrow('F0_READ_ONLY');
    await expect(captured!.write('ch.1.main.mute', true)).rejects.toThrow('F0_READ_ONLY');
    await expect(captured!.loadSnapshot('redacted', 'redacted')).rejects.toThrow('F0_READ_ONLY');
    expect(() => captured!.supervisor.withReadyUi(() => { throw new Error('executou'); })).toThrow('F0_READ_ONLY');
  };
  await reject(); fake.last()!.drop(); await reject();
  await vi.advanceTimersByTimeAsync(11); fake.last()!.open(); fake.last()!.deliver(...stateMessages({ channels: [1], aux: [] }));
  await reject(); await vi.advanceTimersByTimeAsync(2600); assertReadOnly(fake);
  await session.stop(); expect((session as unknown as {write?: unknown}).write).toBeUndefined();
});

it('NaN recebido é desconhecido/inválido; encerra antes de a biblioteca normalizá-lo para zero', async () => {
  const { session, fake, start } = setup(false);
  fake.last()!.deliver('SETD^i.0.mix^NaN', 'SETD^i.0.mute^0');
  await expect(start).rejects.toThrow('F0C_CONNECT_FAILED'); await session.done;
  expect(params(session).some((e) => e.sample.reading.state === 'unknown' && e.sample.reading.reason === 'invalid_value')).toBe(true);
  expect(session.report().stopReason).toBe('invalid_sample');
  expect(session.report().events.some((e) => e.type === 'snapshot' && e.complete)).toBe(false);
  assertReadOnly(fake);
});

it('tempos relativos monotônicos, durações e limites encerram sem deixar retries', async () => {
  let time = 100;
  const { session, fake, start } = setup(true, { clock: () => time, durationMs: 50 }); await start;
  time = 110; fake.last()!.deliver('SETD^i.0.mute^1');
  time = 90; fake.last()!.deliver('SETD^i.0.mute^0');
  await vi.advanceTimersByTimeAsync(51); await session.done;
  expect(session.report().stopReason).toBe('duration');
  const ts = session.report().events.map((e) => e.elapsedMs);
  expect(ts).toEqual([...ts].sort((a, b) => a - b));
  expect(fake.alive()).toHaveLength(0); assertReadOnly(fake);
});

it('a janela de recuperação não reinicia a cada tentativa fracassada', async () => {
  const { session, fake, start } = setup(true, { connectTimeoutMs: 10, recoveryTimeoutMs: 50 }); await start;
  fake.last()!.drop();
  await vi.advanceTimersByTimeAsync(51); await session.done;
  expect(session.report().stopReason).toBe('recovery_timeout');
  expect(fake.alive()).toHaveLength(0); assertReadOnly(fake);
});

it('orçamento de eventos reserva end e impede crescimento ilimitado', async () => {
  const { session, fake, start } = setup(true, { maxEvents: 8 }); await start;
  for (let i = 0; i < 20; i++) fake.last()!.deliver(`SETD^i.0.mute^${i % 2}`);
  await session.done;
  expect(session.report().events.length).toBeLessThanOrEqual(8);
  expect(session.report().stopReason).toBe('event_limit');
  expect(session.report().events.at(-1)!.type).toBe('end'); assertReadOnly(fake);
});

it('snapshots grandes também respeitam orçamento em bytes e não só quantidade', async () => {
  const channels = Array.from({ length: 12 }, (_, i) => i + 1), aux = [1,2,3,4,5,6];
  const { session, fake, start } = setup(false, { scope: { channels, aux, master: true }, maxEvents: 2000 });
  fake.last()!.deliver(...stateMessages({ channels, aux })); await start;
  for (let i = 0; i < 2500; i++) fake.last()!.deliver(`SETD^i.0.mute^${i % 2}`);
  await session.done;
  const report = session.report();
  expect(report.stopReason).toBe('event_limit'); expect(report.events.length).toBeLessThan(2000);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(MAX_OBSERVER_BYTES); assertReadOnly(fake);
});

it('exportação é estrita: sem extras, adulteração de contadores ou origem não declarada', async () => {
  const { session, fake, start } = setup(); await start; await session.stop();
  const report = session.report();
  expect(ObserverReportSchema.safeParse(report).success).toBe(true);
  const copy = JSON.parse(exportObserverReport(report, 'json'));
  copy.ip = 'TOKEN_SECRET'; expect(() => parseObserverReport(copy)).toThrow(/^F0C_INVALID_REPORT$/);
  delete copy.ip; copy.counters.parameter++; expect(() => parseObserverReport(copy)).toThrow('F0C_INVALID_REPORT');
  const invalidation = structuredClone(report);
  const snapshot = invalidation.events.find((e) => e.type === 'snapshot');
  if (snapshot?.type === 'snapshot') snapshot.link = 'LOST';
  expect(() => parseObserverReport(invalidation)).toThrow('F0C_INVALID_REPORT');
  const modified = session.report(); modified.events.length = 0;
  expect(session.report().events.length).toBeGreaterThan(0);
  expect(exportObserverReport(report, 'markdown')).not.toContain('private-fixture'); assertReadOnly(fake);
});

it('limites/gates inválidos falham antes de construir socket; saída que falha encerra sem retries', async () => {
  expect(() => new Ui16ReadOnlyObserver({ source: 'fake_websocket', webSocketCtor: undefined, ip: 'fake', appVersion: '0.7.0', scope: {channels:[1],aux:[],master:false} })).toThrow('F0C_SOCKET_REQUIRED');
  expect(() => new Ui16ReadOnlyObserver({ source: 'manual_device_stream', ip:'192.168.50.10', ethernetConfirmed: false, audioDisconnected: true,
    appVersion: '0.7.0', scope: {channels:[1],aux:[],master:false} } as unknown as ObserverOptions)).toThrow('F0C_MANUAL_GATE_REQUIRED');
  const { session, fake, start } = setup(true, { onEvent: () => { throw new Error('TOKEN_SECRET'); } });
  await expect(start).rejects.toThrow('F0C_CONNECT_FAILED'); await session.done;
  expect(session.report().stopReason).toBe('output_error');
  expect(exportObserverReport(session.report(), 'json')).not.toContain('TOKEN_SECRET'); assertReadOnly(fake);
});

describe('transporte F0C fail-closed', () => {
  it.each(['3:::SETD^i.0.mix^1', '3:::SETS^i.0.name^secret', '3:::LOADSNAPSHOT^x^y', '3:::SAVESNAPSHOT^x^y',
    '3:::MEDIA_PLAY', '3:::UNKNOWN', '3:::SHOWLIST\nSETD^i.0.mix^1', '3:::CUELIST^x^SETD', new Uint8Array([1]),
    '3:::SNAPSHOTLIST^x\u2028SETD', '3:::MEDIA_GET_PLIST_TRACKS^x\r\nSAVE'])('nega frame %j e sela todas as gerações', (frame) => {
    const fake = createFakeUi({ autoOpen: false }), blocked = vi.fn();
    const gate = observerSocketGate(fake.Ctor as ObserverSocketCtor, blocked);
    const ws = new gate.Ctor('fake.invalid'); fake.last()!.open(); ws.send(frame);
    ws.send('3:::ALIVE'); expect(blocked).toHaveBeenCalledTimes(1);
    expect(fake.sockets[0]!.sent).toEqual([]); expect(fake.alive()).toHaveLength(0);
    expect(() => new gate.Ctor('fake.invalid')).toThrow('F0C_TRANSPORT_SEALED');
  });
  it('permite somente consultas conhecidas, sem registrar nomes de shows/playlists no relatório', async () => {
    const { session, fake, start } = setup(); await start;
    fake.last()!.deliver('SHOWLIST^PIN_TOKEN_SECRET', 'PLISTS^SECRET_PLAYLIST');
    await vi.advanceTimersByTimeAsync(1001);
    expect(fake.last()!.sent).toContain('3:::ALIVE');
    expect(fake.last()!.sent).toContain('3:::SNAPSHOTLIST^PIN_TOKEN_SECRET');
    assertReadOnly(fake); await session.stop();
    expect(exportObserverReport(session.report(), 'json')).not.toMatch(/SECRET|PLAYLIST|SHOWLIST/);
  });
  it('tentativa de frame proibido dentro da sessão produz evidência e termina sem replay', async () => {
    const { session, fake, start } = setup(); await start;
    fake.last()!.send('3:::SETD^i.0.mix^1'); await session.done;
    expect(session.report()).toMatchObject({ stopReason: 'outbound_blocked', counters: { safety: 1 } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.sockets).toHaveLength(1); assertReadOnly(fake);
  });
});

it.each(['SETD^i.0.mix^Infinity', 'SETD^i.0.mix^-0.1', 'SETD^i.0.mix^1.01', 'SETD^i.0.mute^0.5', 'SETS^i.0.mix^0.5'])('amostra selecionada inválida %s encerra antes de coerção e sem enviar nada', async (frame) => {
  const { session, fake, start } = setup(); await start;
  fake.last()!.deliver(frame); await session.done;
  expect(session.report().stopReason).toBe('invalid_sample');
  expect(params(session).at(-1)!.sample.reading).toEqual({ state: 'unknown', reason: 'invalid_value' });
  expect(fake.alive()).toHaveLength(0); assertReadOnly(fake);
});

it('wrapper de recepção preserva accessors nativos e valida também mensagens agrupadas', () => {
  const instances: AccessorSocket[] = [];
  class AccessorSocket {
    #handler: ((e: {data: unknown}) => void) | null = null;
    sent: unknown[] = []; closed = false;
    constructor(_url: string) { instances.push(this); }
    get onmessage() { return this.#handler; }
    set onmessage(handler: ((e: {data: unknown}) => void) | null) { this.#handler = handler; }
    deliver(data: unknown) { this.#handler?.({ data }); }
    send(data: unknown) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  const invalid = vi.fn();
  const gate = observerSocketGate(AccessorSocket, () => undefined, { keys: ['ch.1.main.level'], onInvalid: invalid });
  const socket = new gate.Ctor('fake.invalid'), handler = vi.fn(); socket.onmessage = handler;
  instances[0]!.deliver('3:::SETD^i.0.mix^0.5'); expect(handler).toHaveBeenCalledTimes(1);
  instances[0]!.deliver('3:::SETD^i.0.mute^0\nSETD^i.0.mix^NaN');
  expect(handler).toHaveBeenCalledTimes(1); expect(invalid).toHaveBeenCalledWith('ch.1.main.level');
  expect(instances[0]!.closed).toBe(true); expect(instances[0]!.sent).toEqual([]);
});
