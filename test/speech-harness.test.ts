import { mkdtemp, readFile, rm, writeFile, stat, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { WhisperFileRecognizer, parseWhisperJson, type ProcessSpawner } from '../src/speech/whisper-file.js';
import { validateWav } from '../src/speech/wav.js';
import { fixtureSpawn, silentWav } from './support/speech-fixtures.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(mode = 'success', options: { timeoutMs?: number; spawn?: ProcessSpawner } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mixai-stt-test-')); directories.push(dir);
  const audio = join(dir, 'authorized audio.wav');
  const model = join(dir, 'model ; $(unused) -f.json');
  const pidFile = join(dir, 'pids.json');
  await writeFile(audio, silentWav());
  await writeFile(model, JSON.stringify({ mode, pidFile }));
  const workspaces: string[] = [];
  const run = vi.fn<ProcessSpawner>((file, args, settings) => {
    workspaces.push(settings.cwd as string);
    return (options.spawn ?? fixtureSpawn)(file, args, settings);
  });
  const recognizer = new WhisperFileRecognizer({ executable: process.execPath, model, timeoutMs: options.timeoutMs ?? 3000 }, run);
  return { dir, audio, model, pidFile, recognizer, run, workspaces, request: () => recognizer.recognize({ audioFile: audio, authorized: true }) };
}
async function ready(path: string): Promise<number[]> {
  for (let i = 0; i < 250; i++) {
    try { return JSON.parse(await readFile(path, 'utf8')) as number[]; } catch { await new Promise(r => setTimeout(r, 10)); }
  }
  throw new Error('fixture did not start');
}
async function stopped(pids: number[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!alive.length) return;
    // Linux containers can retain a dead grandchild as zombie until PID 1 reaps it.
    if (process.platform === 'linux') {
      const running = await Promise.all(alive.map(async pid => { try { return !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z '); } catch { return false; } }));
      if (running.every(value => !value)) return;
    }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('live orphan process');
}

it('uses fixed argument positions/no shell, canonical WAV copy, no stdout transcript and per-run cleanup', async () => {
  const t = await setup('adversarial');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network forbidden'); });
  const result = await t.request();
  expect(result).toMatchObject({ text: 'Não altere nada.', language: 'pt-BR', cpuMs: null, peakRssBytes: null, audioSeconds: 0.1 });
  expect(result.processingMs).toBeGreaterThan(0);
  const [file, args, settings] = t.run.mock.calls[0]!;
  expect(file).toBe(await realpath(process.execPath));
  expect(args).toEqual(['-m', await realpath(t.model), '-f', join(t.workspaces[0]!, 'input.wav'), '-l', 'pt', '-oj', '-of', join(t.workspaces[0]!, 'result'), '-np', '-nt', '-ng', '-t', '2']);
  expect(settings.shell).toBe(false);
  expect(args).not.toContain(t.audio);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await expect(stat(t.workspaces[0]!)).rejects.toThrow();
});

it('requires audio authorization before reading files/spawning', async () => {
  const t = await setup();
  await expect(t.recognizer.recognize({ audioFile: join(t.dir, 'does-not-exist.wav'), authorized: false })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  expect(t.run).not.toHaveBeenCalled();
});

it.each(['relative/whisper-cli', 'https://host/whisper', '\\\\server\\whisper.exe', '/local/whisper.cmd', '/local/whisper\n-cli'])('rejects unsafe executable configuration %s', executable => {
  expect(() => new WhisperFileRecognizer({ executable, model: process.execPath })).toThrow();
});
it.each([0, -1, 120001, NaN, 1.1])('rejects timeout %s', timeoutMs => {
  expect(() => new WhisperFileRecognizer({ executable: process.execPath, model: process.execPath, timeoutMs })).toThrow();
});

it('rejects missing model or audio without network/download fallback', async () => {
  const t = await setup();
  await rm(t.model);
  await expect(t.request()).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
  expect(t.run).not.toHaveBeenCalled();
});

it.each(['invalid', 'missing', 'huge-file', 'fail', 'spam'])('handles process/output failure %s and cleans scratch files', async mode => {
  const t = await setup(mode);
  const code = mode === 'fail' ? 'PROCESS_FAILED' : mode === 'huge-file' || mode === 'spam' ? 'OUTPUT_LIMIT' : mode === 'missing' ? 'FILE_UNAVAILABLE' : 'INVALID_OUTPUT';
  await expect(t.request()).rejects.toMatchObject({ code });
  await expect(stat(t.workspaces[0]!)).rejects.toThrow();
});

it('handles spawn failures without echoing paths/stderr', async () => {
  const t = await setup('success', { spawn: () => { throw new Error('private path'); } });
  await expect(t.request()).rejects.toMatchObject({ code: 'SPAWN_FAILED', message: 'SPAWN_FAILED' });
  await expect(stat(t.workspaces[0]!)).rejects.toThrow();
});

it('handles asynchronous OS spawn failures and cleanup', async () => {
  const t = await setup('success', { spawn: (_file, args, settings) => spawn(join(tmpdir(), 'missing-mixai-executable'), args, settings) });
  await expect(t.request()).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
  await expect(stat(t.workspaces[0]!)).rejects.toThrow();
});

it('times out and escalates when a process ignores graceful termination', async () => {
  const t = await setup('hang', { timeoutMs: 1200 });
  await expect(t.request()).rejects.toMatchObject({ code: 'TIMEOUT' });
  await stopped(await ready(t.pidFile));
  await expect(stat(t.workspaces[0]!)).rejects.toThrow();
});

it('cancels a live process tree without leaving active descendants', async () => {
  const t = await setup('tree');
  const abort = new AbortController();
  const result = t.recognizer.recognize({ audioFile: t.audio, authorized: true, signal: abort.signal });
  // Attach rejection handler immediately; cancellation is an expected outcome.
  const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
  const pids = await ready(t.pidFile);
  abort.abort();
  await rejected;
  await stopped(pids);
  await expect(stat(t.workspaces[0]!)).rejects.toThrow();
}, 8000);

it('honors cancellation before spawn and isolates concurrent runs', async () => {
  const t = await setup();
  await expect(t.recognizer.recognize({ audioFile: t.audio, authorized: true, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(t.run).not.toHaveBeenCalled();
  const results = await Promise.all([t.request(), t.request()]);
  expect(results.map(r => r.text)).toEqual(['Não altere nada.', 'Não altere nada.']);
  expect(new Set(t.workspaces).size).toBe(2);
  for (const cwd of t.workspaces) await expect(stat(cwd)).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')('rejects symlink audio where the OS permits creating symlinks', async () => {
  // Windows often requires developer mode/admin for symlinks; file/output protocol is tested on both OSes.
  const t = await setup();
  const alias = join(t.dir, 'alias.wav');
  await symlink(t.audio, alias);
  await expect(t.recognizer.recognize({ audioFile: alias, authorized: true })).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
  expect(t.run).not.toHaveBeenCalled();
});

it('validates RIFF bounds, format, size/duration and strips metadata', () => {
  const valid = silentWav();
  for (const position of [0, 8, 20, 22, 24, 28, 32, 34, 40]) {
    const malformed = Buffer.from(valid); malformed[position] = 255;
    expect(() => validateWav(malformed)).toThrow();
  }
  expect(() => validateWav(valid.subarray(0, valid.length - 1))).toThrow();
  expect(() => validateWav(silentWav(61))).toThrow();
  expect(() => validateWav(silentWav(0))).toThrow();
  const withMetadata = Buffer.concat([valid, Buffer.from('JUNK\x04\x00\x00\x00data')]);
  withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
  expect(validateWav(withMetadata).wav).toEqual(valid);
});
it.each(['{}', '{"transcription":[{"text":7}]}', '{"transcription":[{"text":"\\u001b[2J"}]}'])('rejects adversarial JSON %s', text => {
  expect(() => parseWhisperJson(Buffer.from(text))).toThrow();
});

it('rejects malformed, oversized and non-regular audio before spawning', async () => {
  const t = await setup();
  await writeFile(t.audio, Buffer.from('not a WAV'));
  await expect(t.request()).rejects.toMatchObject({ code: 'INVALID_AUDIO' });
  await writeFile(t.audio, Buffer.alloc(4 * 1024 * 1024 + 1));
  await expect(t.request()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  await expect(t.recognizer.recognize({ audioFile: t.dir, authorized: true })).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
  expect(t.run).not.toHaveBeenCalled();
});
it('rejects invalid UTF-8 output and preserves shell-looking text as inert data', () => {
  expect(() => parseWhisperJson(Buffer.from([255]))).toThrow();
  const text = '$(touch never-run) ; Não altere nada.';
  expect(parseWhisperJson(Buffer.from(JSON.stringify({ transcription: [{ text }] })))).toBe(text);
});
