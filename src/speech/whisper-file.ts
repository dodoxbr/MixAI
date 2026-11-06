import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { localPath, readLocal, regularFile, SpeechHarnessError, type SpeechErrorCode } from './files.js';
import { MAX_AUDIO_BYTES, validateWav } from './wav.js';

export interface FileSpeechResult {
  provider: 'whisper.cpp';
  language: 'pt-BR';
  text: string;
  processingMs: number;
  audioSeconds: number;
  realTimeFactor: number;
  /** Not measured portably by this harness. */
  cpuMs: null;
  peakRssBytes: null;
}
export interface FileSpeechRecognizer {
  recognize(request: { audioFile: string; authorized: boolean; signal?: AbortSignal }): Promise<FileSpeechResult>;
}
export interface WhisperFileConfig { executable: string; model: string; timeoutMs?: number; threads?: number }
export type ProcessSpawner = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
const OUTPUT_BYTES = 256 * 1024;
const PIPE_BYTES = 64 * 1024;

/** Parse a bounded JSON file, NEVER stdout (which may contain logs or adversarial text). */
export function parseWhisperJson(bytes: Buffer): string {
  if (bytes.length > OUTPUT_BYTES) throw new SpeechHarnessError('OUTPUT_LIMIT');
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || !('transcription' in value) || !Array.isArray(value.transcription) || value.transcription.length > 512) throw new Error();
    const parts = value.transcription.map((part: unknown) => {
      if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') throw new Error();
      return part.text;
    });
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    // Terminal escapes, NUL and bidi overrides are not transcript content.
    if (text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text)) throw new Error();
    return text;
  } catch { throw new SpeechHarnessError('INVALID_OUTPUT'); }
}

/** Fixed trusted executable, no shell, no provider/network/server/parser dependency. */
export class WhisperFileRecognizer implements FileSpeechRecognizer {
  private readonly timeoutMs: number;
  private readonly threads: number;
  constructor(private readonly config: WhisperFileConfig, private readonly spawnProcess: ProcessSpawner = spawn) {
    localPath(config.executable); localPath(config.model);
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.threads = config.threads ?? 2;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 120_000 || !Number.isInteger(this.threads) || this.threads < 1 || this.threads > 8 || /\.(?:cmd|bat|ps1|sh)$/i.test(config.executable)) throw new SpeechHarnessError('CONFIG');
  }
  async recognize(request: { audioFile: string; authorized: boolean; signal?: AbortSignal }): Promise<FileSpeechResult> {
    if (request.authorized !== true) throw new SpeechHarnessError('NOT_AUTHORIZED');
    if (request.signal?.aborted) throw new SpeechHarnessError('CANCELLED');
    const executable = await regularFile(this.config.executable);
    const model = await regularFile(this.config.model);
    const { wav, durationSeconds } = validateWav(await readLocal(request.audioFile, MAX_AUDIO_BYTES));
    if (request.signal?.aborted) throw new SpeechHarnessError('CANCELLED');
    const workspace = await mkdtemp(join(tmpdir(), 'mixai-stt-')).catch(() => { throw new SpeechHarnessError('FILE_UNAVAILABLE'); });
    try {
      const audio = join(workspace, 'input.wav');
      const output = join(workspace, 'result');
      await writeFile(audio, wav, { mode: 0o600, flag: 'wx' });
      const started = performance.now();
      await this.run(executable, ['-m', model, '-f', audio, '-l', 'pt', '-oj', '-of', output, '-np', '-nt', '-ng', '-t', String(this.threads)], workspace, request.signal);
      const processingMs = performance.now() - started;
      if (request.signal?.aborted) throw new SpeechHarnessError('CANCELLED');
      const text = parseWhisperJson(await readLocal(`${output}.json`, OUTPUT_BYTES));
      if (request.signal?.aborted) throw new SpeechHarnessError('CANCELLED');
      return { provider: 'whisper.cpp', language: 'pt-BR', text, processingMs, audioSeconds: durationSeconds, realTimeFactor: processingMs / 1000 / durationSeconds, cpuMs: null, peakRssBytes: null };
    } catch (error) {
      if (error instanceof SpeechHarnessError) throw error;
      throw new SpeechHarnessError('FILE_UNAVAILABLE');
    } finally {
      try { await rm(workspace, { recursive: true, force: true }); }
      catch { throw new SpeechHarnessError('CLEANUP_FAILED'); }
    }
  }

  private run(executable: string, args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new SpeechHarnessError('CANCELLED')); return; }
      let child: ChildProcess;
      let failure: SpeechErrorCode | undefined;
      let settled = false;
      let treeKillStarted = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = (code?: SpeechErrorCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(watchdog);
        signal?.removeEventListener('abort', abort);
        if (code) reject(new SpeechHarnessError(code));
        else resolve();
      };
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let treeKill: Promise<void> = Promise.resolve();
      const terminate = (hard: boolean) => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          if (treeKillStarted) return;
          treeKillStarted = true;
          // taskkill /T closes descendants too. No shell, PID is generated by the OS.
          const root = process.env['SystemRoot'];
          if (!root) { child.kill('SIGKILL'); return; }
          treeKill = new Promise<void>(done => {
            const killer = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 1000, killSignal: 'SIGKILL' });
            killer.once('error', () => { child.kill('SIGKILL'); done(); });
            killer.once('close', () => { child.kill('SIGKILL'); done(); });
          });
        } else {
          try { process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); }
          catch { child.kill(hard ? 'SIGKILL' : 'SIGTERM'); }
        }
      };
      const stop = (code: SpeechErrorCode) => {
        if (failure) return;
        failure = code;
        terminate(false);
        killTimer = setTimeout(() => terminate(true), 250);
        watchdog = setTimeout(() => {
          terminate(true);
          child.stdout?.destroy(); child.stderr?.destroy();
          finish('CLEANUP_FAILED'); // Do not claim cancellation succeeded if the OS cannot reap it.
        }, 2000);
      };
      const abort = () => stop('CANCELLED');
      try {
        child = this.spawnProcess(executable, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { reject(new SpeechHarnessError('SPAWN_FAILED')); return; }
      let total = 0;
      const drain = (chunk: Buffer | string) => { total += Buffer.byteLength(chunk); if (total > PIPE_BYTES) stop('OUTPUT_LIMIT'); };
      child.stdout?.on('data', drain); child.stderr?.on('data', drain);
      child.once('error', () => { failure ??= 'SPAWN_FAILED'; });
      child.once('close', async (code) => {
        clearTimeout(deadline); clearTimeout(killTimer);
        // A foreground CLI must not leave descendants holding files after exit.
        if (process.platform !== 'win32') terminate(true);
        await treeKill;
        finish(failure ?? (code !== 0 ? 'PROCESS_FAILED' : undefined));
      });
      deadline = setTimeout(() => stop('TIMEOUT'), this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
