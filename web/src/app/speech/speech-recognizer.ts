/** Provider-neutral boundary. No command/parser/network dependency. */
export type SpeechState = 'idle' | 'permission' | 'listening' | 'transcribing' | 'done' | 'cancelled' | 'error';
export interface SpeechResult {
  text: string;
  language: 'pt-BR';
  /** Absent when the provider cannot supply a calibrated confidence. */
  confidence?: number;
  simulated: boolean;
}
export interface SpeechRecognizer {
  readonly state: SpeechState;
  start(stream: MediaStream, options: { language: 'pt-BR'; signal: AbortSignal }): Promise<void>;
  finish(): Promise<SpeechResult>;
  /** Idempotent; must stop processing and discard buffered audio/results. */
  cancel(): void;
}
/** Fixture only: never reads, records, stores or uploads the stream. */
export class FixtureSpeechRecognizer implements SpeechRecognizer {
  state: SpeechState = 'idle';
  private signal?: AbortSignal;
  async start(_stream: MediaStream, options: { language: 'pt-BR'; signal: AbortSignal }): Promise<void> {
    this.signal = options.signal;
    this.state = options.signal.aborted ? 'cancelled' : 'listening';
  }
  async finish(): Promise<SpeechResult> {
    if (!this.signal || this.signal.aborted) throw new Error('cancelled');
    this.state = 'done';
    return { text: 'Aumente a voz no meu fone', language: 'pt-BR', simulated: true };
  }
  cancel(): void { this.signal = undefined; this.state = 'cancelled'; }
}

export interface SpeechEnvironment {
  secure(): boolean;
  available(): boolean;
  allowed(): boolean;
  getUserMedia(): Promise<MediaStream>;
}

/** One explicit gesture per session; late async completions cannot revive capture. */
export class PushToTalk {
  state: SpeechState = 'idle';
  result?: SpeechResult;
  error?: string;
  private abort?: AbortController;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private env: SpeechEnvironment, private recognizer: SpeechRecognizer, private changed: () => void = () => {}) {}

  async press(): Promise<void> {
    if (this.abort) return;
    this.result = undefined;
    this.error = undefined;
    if (!this.env.allowed()) return this.fail('Experimento indisponível: requer flag, operador LAB e conexão.');
    if (!this.env.secure()) return this.fail('Microfone exige HTTPS confiável ou localhost. HTTP por IP da rede não é seguro.');
    if (!this.env.available()) return this.fail('Microfone indisponível neste navegador.');
    const run = new AbortController();
    this.abort = run;
    this.set('permission');
    // Bounds even a held gesture or an unanswered permission prompt.
    this.timer = setTimeout(() => this.cancel(), 15_000);
    try {
      const stream = await this.env.getUserMedia();
      if (run.signal.aborted || !this.env.allowed()) {
        stream.getTracks().forEach(t => t.stop());
        if (!run.signal.aborted) this.cancel();
        return;
      }
      this.stream = stream;
      stream.getTracks().forEach(t => t.addEventListener('ended', () => this.cancel(), { once: true }));
      await this.recognizer.start(stream, { language: 'pt-BR', signal: run.signal });
      if (!run.signal.aborted) this.set('listening');
    } catch (e) {
      if (!run.signal.aborted) {
        this.cancel();
        this.fail(typeof e === 'object' && e !== null && 'name' in e && e.name === 'NotAllowedError' ? 'Permissão de microfone negada.' : 'Não foi possível abrir o microfone.');
      }
    }
  }

  async release(): Promise<void> {
    if (this.state !== 'listening') { if (this.abort) this.cancel(); return; }
    const run = this.abort!;
    this.stopTracks();
    this.set('transcribing');
    try {
      const result = await this.recognizer.finish();
      if (run.signal.aborted) return;
      if (!this.env.allowed()) { this.cancel(); return; }
      this.result = result;
      this.cleanup();
      this.set('done');
    } catch {
      if (!run.signal.aborted) { this.cancel(); this.fail('Falha na transcrição simulada.'); }
    }
  }

  cancel(): void {
    this.abort?.abort();
    this.cleanup();
    this.result = undefined;
    this.set('cancelled');
  }
  private stopTracks(): void {
    const stream = this.stream;
    this.stream = undefined;
    stream?.getTracks().forEach(t => t.stop());
  }
  private cleanup(): void {
    clearTimeout(this.timer);
    this.stopTracks();
    this.recognizer.cancel();
    this.abort = undefined;
  }
  private fail(message: string): void { this.error = message; this.set('error'); }
  private set(state: SpeechState): void { this.state = state; this.changed(); }
}
