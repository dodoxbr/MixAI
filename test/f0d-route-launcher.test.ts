import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { confirmWindowsObserverRoute, WINDOWS_ROUTE_QUERY } from '../src/mixer/observer-network.js';
import { routeFixture } from './support/route-fixtures.js';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
function inWindows<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', original); vi.resetAllMocks(); vi.unstubAllEnvs(); }
}
function output(value: unknown, status = 0, stderr = '') {
  vi.mocked(spawnSync).mockReturnValue({ status, stdout: JSON.stringify(value), stderr, error: undefined } as ReturnType<typeof spawnSync>);
}
it('consulta fixa isolada: não executa arquivo, código de entrada, shell ou alteração de política', () => inWindows(() => {
  vi.stubEnv('PSExecutionPolicyPreference', 'Restricted');
  output(routeFixture());
  expect(confirmWindowsObserverRoute('/fixture', '10.10.1.1', 'wifi', 8)).toBe(true);
  const [command, args, opts] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(command).toBe('powershell.exe');
  expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ROUTE_QUERY]);
  expect(args!.join(' ')).not.toMatch(/ExecutionPolicy|Bypass|Unblock-File|EncodedCommand|Invoke-Expression|\.ps1|10\.10\.1\.1|Set-|New-|Remove-/i);
  expect(opts).toMatchObject({ timeout: 15000, maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe'], env: { MIXAI_F0_ROUTE_TARGET: '10.10.1.1', PSExecutionPolicyPreference: 'Restricted' } });
  expect(opts).not.toHaveProperty('shell');
  expect(process.env.PSExecutionPolicyPreference).toBe('Restricted');
  const other = routeFixture(); other.selected = [{ InterfaceIndex: 9 }]; output(other);
  expect(confirmWindowsObserverRoute('/other', '192.168.50.10', 'ethernet', 9)).toBe(true);
  expect(vi.mocked(spawnSync).mock.calls[1]![1]).toEqual(args);
}));
it('rejeita snapshot extra, stderr, JSON inválido, erro e timeout sem expor dados', () => inWindows(() => {
  for (const value of [{}, { ...routeFixture(), ip: 'SECRET' }]) {
    output(value); expect(confirmWindowsObserverRoute('/fixture', '10.10.1.1', 'wifi', 8)).toBe(false);
  }
  for (const [value, status, stderr] of [[routeFixture(), 1, 'SECRET'], [routeFixture(), 0, 'SECRET']] as const) {
    output(value, status, stderr);
    expect(() => confirmWindowsObserverRoute('/fixture', '10.10.1.1', 'wifi', 8)).toThrow(/^F0D_ROUTE_PREFLIGHT_FAILED$/);
  }
  for (const result of [{ status: 0, stdout: 'SECRET invalid JSON', stderr: '' }, { status: null, error: new Error('SECRET timeout'), stdout: '', stderr: '' }]) {
    vi.mocked(spawnSync).mockReturnValue(result as ReturnType<typeof spawnSync>);
    expect(() => confirmWindowsObserverRoute('/fixture', '10.10.1.1', 'wifi', 8)).toThrow(/^F0D_ROUTE_PREFLIGHT_FAILED$/);
  }
}));
it('recusa valores inválidos/injeção antes de iniciar processo', () => inWindows(() => {
  for (const [ip, index] of [['8.8.8.8', 8], ['localhost', 8], ['10.10.1.1; malicious-code', 8], ['10.10.1.1', 0], ['10.10.1.1', Infinity], ['10.10.1.1', 2 ** 32]] as const) {
    expect(() => confirmWindowsObserverRoute('/fixture', ip, 'wifi', index)).toThrow('F0D_WINDOWS_ROUTE_CHECK_REQUIRED');
  }
  expect(spawnSync).not.toHaveBeenCalled();
}));
it('recusa dados inconsistentes mesmo quando o processo conclui sem erro', () => inWindows(() => {
  const fixture = routeFixture(); fixture.selected = [{ InterfaceIndex: 10 }]; output(fixture);
  expect(confirmWindowsObserverRoute('/fixture', '10.10.1.1', 'wifi', 8)).toBe(false);
}));
