import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseObserverArgs, runF0Observer } from '../src/f0-observer-cli.js';
import { parseObserverReport } from '../src/mixer/observer-report.js';
import { OwnerLock, ownerLockFile } from '../src/core/owner-lock.js';
import { createFakeUi, stateMessages } from './support/fake-ui-socket.js';

const ip = '192.168.50.10';
const args = ['--physical-readonly', '--audio-disconnected', '--ip', ip, '--confirm-ethernet-ip', ip, '--channels', '1', '--duration', '1'];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mixai-f0c-cli-'));
  vi.stubEnv('MIXAI_LOCK_DIR', join(dir, 'locks'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('help, ausência de flags e terminal não interativo não constroem socket, nem usam overrides/config', async () => {
  const forbidden = vi.fn(function () { throw new Error('Não conectar'); }); vi.stubGlobal('WebSocket', forbidden);
  vi.stubEnv('MIXAI_MODE', 'real'); vi.stubEnv('MIXAI_IP', '10.10.1.1'); vi.stubEnv('MIXAI_CONFIG_DIR', 'SECRET_CONFIG');
  const lines: string[] = []; const io = { interactive: false, write: (s: string) => lines.push(s) };
  expect(await runF0Observer(['--help'], io)).toBe(0);
  expect(await runF0Observer([], io)).toBe(1);
  expect(await runF0Observer(args, io)).toBe(1);
  expect(forbidden).not.toHaveBeenCalled(); expect(lines.join('\n')).not.toMatch(/SECRET_CONFIG|192\.168\.50\.10/);
  expect(existsSync(join(dir, 'locks'))).toBe(false);
});

it.each([
  ['--real'], ['--readonly'], ['--physical-readonly', '--ip', ip],
  [...args, '--ip', ip], [...args, '--aux', '0'], [...args, '--aux', '1,1'],
  [...args.filter((a) => a !== '--audio-disconnected')],
  [...args, '--write'],
].map((bad) => [bad]))('recusa flags incompletas/ambíguas ou de escrita antes de rede: %j', (bad) => {
  expect(() => parseObserverArgs(bad)).toThrow('F0C_');
});
it.each(['10.10.1.1:80', 'http://192.168.50.10', '8.8.8.8', '127.0.0.1', 'localhost', '0.0.0.0'])('sem DNS, URL ou IP presumido/público: %s', (badIp) => {
  const bad = args.map((a) => a === ip ? badIp : a);
  expect(() => parseObserverArgs(bad)).toThrow('F0C_EXPLICIT_MANUAL_GATES_REQUIRED');
});

it('o caminho manual é ensaiado só com WebSocket falso; exportação opt-in sem identificadores e sem reenvio', async () => {
  const fake = createFakeUi({ initialState: () => stateMessages({ channels: [1], aux: [] }) });
  vi.stubGlobal('WebSocket', fake.Ctor);
  const lines: string[] = []; const baseline = process.listenerCount('SIGINT');
  const prefix = join(dir, 'evidence');
  const run = runF0Observer([...args, '--report', prefix], { interactive: true, write: (s) => lines.push(s) });
  await vi.advanceTimersByTimeAsync(1100);
  expect(await run).toBe(0);
  const report = parseObserverReport(JSON.parse(readFileSync(`${prefix}.json`, 'utf8')));
  expect(report).toMatchObject({ ended: true, source: 'manual_device_stream', hardwareValidation: 'pending', stopReason: 'duration' });
  const md = readFileSync(`${prefix}.md`, 'utf8');
  expect(md).toContain('CH 1 · PA');
  expect(JSON.stringify(report) + md + lines.join('\n')).not.toContain(ip);
  expect(fake.sockets.flatMap((s) => s.commands())).toEqual([]); expect(fake.alive()).toHaveLength(0);
  expect(process.listenerCount('SIGINT')).toBe(baseline);
  expect(existsSync(ownerLockFile('real', '')!)).toBe(false);
});

it('sem --report não cria arquivo de evidências; sem reaproveitar PINs ou LAB', async () => {
  const fake = createFakeUi({ initialState: () => stateMessages({ channels: [1], aux: [] }) }); vi.stubGlobal('WebSocket', fake.Ctor);
  const run = runF0Observer(args, { interactive: true, write: () => undefined });
  await vi.advanceTimersByTimeAsync(1100); expect(await run).toBe(0);
  expect(readdirSync(dir)).toEqual(['locks']); expect(readdirSync(join(dir, 'locks'))).toEqual([]);
});

it('colisão de relatório não sobrescreve e não abre socket; reserva parcial é limpa', async () => {
  const prefix = join(dir, 'existing'); writeFileSync(`${prefix}.md`, 'preserve');
  const fake = createFakeUi(); vi.stubGlobal('WebSocket', fake.Ctor);
  expect(await runF0Observer([...args, '--report', prefix], { interactive: true, write: () => undefined })).toBe(1);
  expect(readFileSync(`${prefix}.md`, 'utf8')).toBe('preserve'); expect(existsSync(`${prefix}.json`)).toBe(false);
  expect(fake.sockets).toHaveLength(0); expect(existsSync(ownerLockFile('real', '')!)).toBe(false);
});

it('trava F0 existente é respeitada sem expor dados do titular', async () => {
  const file = ownerLockFile('real', '')!;
  const holder = new OwnerLock(file, 'SECRET_OPERATOR', { equipment: 'SECRET_IP' }).acquire();
  try {
    const fake = createFakeUi(); vi.stubGlobal('WebSocket', fake.Ctor); const lines: string[] = [];
    expect(await runF0Observer(args, { interactive: true, write: (s) => lines.push(s) })).toBe(1);
    expect(fake.sockets).toHaveLength(0); expect(lines.join('')).not.toMatch(/SECRET|192\.168/);
    expect(existsSync(file)).toBe(true);
  } finally { holder.release(); }
});
