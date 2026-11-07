import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { confirmWindowsObserverRoute } from '../src/mixer/observer-network.js';
import { Ui16ReadOnlyObserver } from '../src/mixer/readonly-observer.js';
import { RealMixer } from '../src/mixer/real.js';
import { isObserverReadFrame } from '../src/mixer/readonly-socket.js';
import { createFakeUi, stateMessages } from './support/fake-ui-socket.js';
import { routeFixture } from './support/route-fixtures.js';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const sessions: Ui16ReadOnlyObserver[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.stop())); vi.restoreAllMocks(); vi.useRealTimers(); });
function confirm(ip: string, transport: 'wifi' | 'ethernet', index: number) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { return confirmWindowsObserverRoute('/unused', ip, transport, index); }
  finally { Object.defineProperty(process, 'platform', original); }
}
for (const transport of ['wifi', 'ethernet'] as const) {
  const ip = transport === 'wifi' ? '10.10.1.1' : '192.168.50.10', index = transport === 'wifi' ? 8 : 9;
  const prepare = () => {
    const fake = createFakeUi({ autoOpen: false });
    const observer = new Ui16ReadOnlyObserver({ source: 'fake_websocket', transport, ip, webSocketCtor: fake.Ctor,
      routeGuard: () => confirm(ip, transport, index), scope: { channels: [1], aux: [], master: false }, appVersion: '0.7.0',
      durationMs: 10000, connectTimeoutMs: 200, syncTimeoutMs: 20, reconnectBaseMs: 10, reconnectMaxDelayMs: 20 });
    sessions.push(observer); return { fake, observer };
  };
  it(`${transport}: cmdlets bloqueados recusam antes do primeiro WebSocket`, async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'SECRET access denied' } as ReturnType<typeof spawnSync>);
    const { fake, observer } = prepare();
    await expect(observer.start()).rejects.toThrow(); await observer.done;
    expect(fake.sockets).toHaveLength(0); expect(observer.report().stopReason).toBe('route_mismatch');
    expect(JSON.stringify(observer.report())).not.toContain('SECRET');
  });
  it(`${transport}: recusa da consulta na reconexão sela sessão, zero replay/escrita`, async () => {
    const write = vi.spyOn(RealMixer.prototype, 'write'), load = vi.spyOn(RealMixer.prototype, 'loadSnapshot');
    const snapshot = routeFixture(); snapshot.selected = [{ InterfaceIndex: index }];
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: JSON.stringify(snapshot), stderr: '' } as ReturnType<typeof spawnSync>);
    const { fake, observer } = prepare();
    const start = observer.start(); fake.last()!.open(); fake.last()!.deliver(...stateMessages({ channels: [1], aux: [] })); await start;
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'blocked query' } as ReturnType<typeof spawnSync>);
    const old = fake.last()!; old.drop(); await vi.advanceTimersByTimeAsync(11); await observer.done;
    old.deliver('SETD^i.0.mix^0'); await vi.advanceTimersByTimeAsync(3000);
    expect(observer.report().stopReason).toBe('route_mismatch');
    expect(fake.sockets).toHaveLength(1); expect(fake.alive()).toHaveLength(0);
    expect(fake.sockets.flatMap(s => s.commands())).toEqual([]);
    expect(fake.sockets.flatMap(s => s.sent).every(isObserverReadFrame)).toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  });
}
