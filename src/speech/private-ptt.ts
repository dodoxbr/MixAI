import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regularFile } from './files.js';
import { validateWav } from './wav.js';
import { WhisperFileRecognizer, type FileSpeechRecognizer } from './whisper-file.js';

export const PTT_MAX_SECONDS = 10;
export const PTT_MAX_BYTES = 44 + PTT_MAX_SECONDS * 32000;
export class PttError extends Error {
  constructor(readonly code: 'NOT_CONFIGURED' | 'RATE_LIMIT' | 'CAPACITY' | 'BAD_TICKET' | 'BAD_AUDIO' | 'CANCELLED' | 'UNAUTHORIZED' | 'TIMEOUT' | 'STT_FAILED') { super(code); }
}
export interface PttJob {
  session: string; ticket: string; abort: AbortController;
  deadline: ReturnType<typeof setTimeout>; watch: ReturnType<typeof setInterval>;
}
/** No controller, parser, assistant, history or network dependency. All data is ephemeral. */
export class PrivatePtt {
  private tickets = new Map<string, { value: string; expires: number }>();
  private rates = new Map<string, { start: number; count: number }>();
  private job?: PttJob;
  private work?: Promise<void>;
  readonly simulated: boolean;
  constructor(private config: { executable?: string; model?: string }, private recognizer?: FileSpeechRecognizer, private clock = Date.now) {
    this.simulated = !!recognizer; // Dependency injection only, never an HTTP/config switch.
  }
  async configured(): Promise<boolean> {
    if (this.simulated) return true;
    if (!this.config.executable || !this.config.model) return false;
    try {
      await regularFile(this.config.executable); await regularFile(this.config.model);
      this.recognizer ??= new WhisperFileRecognizer({ executable: this.config.executable, model: this.config.model, timeoutMs: 15000 });
      return true;
    } catch { return false; }
  }
  async ticket(session: string): Promise<string> {
    if (!await this.configured()) throw new PttError('NOT_CONFIGURED');
    const now = this.clock();
    for (const [key, value] of this.rates) if (now - value.start >= 60000) this.rates.delete(key);
    for (const [key, value] of this.tickets) if (now > value.expires) this.tickets.delete(key);
    const rate = this.rates.get(session) ?? { start: now, count: 0 };
    if (rate.count >= 3) throw new PttError('RATE_LIMIT');
    if ((!this.rates.has(session) && this.rates.size >= 64) || this.job) throw new PttError('CAPACITY');
    rate.count++; this.rates.set(session, rate);
    const value = randomBytes(32).toString('hex');
    this.tickets.set(session, { value, expires: now + 20000 });
    return value;
  }
  begin(session: string, value: unknown, active: () => boolean): PttJob {
    const ticket = this.tickets.get(session);
    if (!ticket || typeof value !== 'string' || ticket.value !== value || this.clock() > ticket.expires) throw new PttError('BAD_TICKET');
    this.tickets.delete(session); // Consume before body parsing; never retry an upload.
    if (!active()) throw new PttError('UNAUTHORIZED');
    if (this.job) throw new PttError('CAPACITY');
    const abort = new AbortController();
    const job: PttJob = { session, ticket: value, abort,
      deadline: setTimeout(() => abort.abort(new PttError('TIMEOUT')), 15000),
      watch: setInterval(() => { if (!active()) abort.abort(new PttError('UNAUTHORIZED')); }, 250),
    };
    this.job = job;
    abort.signal.addEventListener('abort', () => { if (this.job === job && !this.work) this.finish(job); }, { once: true });
    return job;
  }
  cancel(session: string, ticket?: unknown): void {
    const pending = this.tickets.get(session);
    if (ticket === undefined || pending?.value === ticket) this.tickets.delete(session);
    if (this.job?.session === session && (ticket === undefined || this.job.ticket === ticket)) this.job.abort.abort(new PttError('CANCELLED'));
  }
  revoke(session: string): void {
    this.tickets.delete(session); this.rates.delete(session);
    if (this.job?.session === session) this.job.abort.abort(new PttError('UNAUTHORIZED'));
  }
  finish(job: PttJob): void {
    clearTimeout(job.deadline); clearInterval(job.watch);
    if (this.job === job) this.job = undefined;
  }
  async close(): Promise<void> {
    if (this.job) { this.job.abort.abort(new PttError('CANCELLED')); if (!this.work) this.finish(this.job); }
    this.tickets.clear(); this.rates.clear();
    await this.work;
  }
  async transcribe(job: PttJob, audio: unknown, active: () => boolean) {
    if (job.abort.signal.aborted) { if (Buffer.isBuffer(audio)) audio.fill(0); throw job.abort.signal.reason; }
    let directory: string | undefined;
    let completed!: () => void;
    this.work = new Promise<void>(resolve => { completed = resolve; });
    const check = () => {
      if (!active()) throw new PttError('UNAUTHORIZED');
      if (job.abort.signal.aborted) throw job.abort.signal.reason;
    };
    try {
      check();
      if (!Buffer.isBuffer(audio) || audio.length > PTT_MAX_BYTES) throw new PttError('BAD_AUDIO');
      let canonical;
      try { canonical = validateWav(audio); } catch { throw new PttError('BAD_AUDIO'); }
      if (canonical.durationSeconds > PTT_MAX_SECONDS) { canonical.wav.fill(0); throw new PttError('BAD_AUDIO'); }
      try {
        if (!await this.configured()) throw new PttError('NOT_CONFIGURED');
        check();
        directory = await mkdtemp(join(tmpdir(), 'mixai-ptt-'));
        const file = join(directory, 'input.wav');
        await writeFile(file, canonical.wav, { mode: 0o600, flag: 'wx' });
        check();
        const result = await this.recognizer!.recognize({ audioFile: file, authorized: true, signal: job.abort.signal });
        check();
        if (typeof result.text !== 'string' || result.text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(result.text)) throw new PttError('STT_FAILED');
        return { text: result.text, simulated: this.simulated, preview: true as const };
      } finally { canonical.wav.fill(0); }
    } catch (error) {
      if (job.abort.signal.aborted) throw job.abort.signal.reason;
      if (error instanceof PttError) throw error;
      throw new PttError('STT_FAILED');
    } finally {
      if (Buffer.isBuffer(audio)) audio.fill(0);
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      catch { throw new PttError('STT_FAILED'); }
      finally { this.finish(job); this.work = undefined; completed(); }
    }
  }
}
