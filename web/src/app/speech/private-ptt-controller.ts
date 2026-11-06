import { PRIVATE_PTT_BYTES, PcmCapture } from './pcm-capture';
export interface PttView { visible: boolean; configured: boolean; simulated: boolean; state: string; text: string; message: string }
export interface PttBrowser {
  allowed(): boolean;
  secure(): boolean;
  key(): string | null;
  capture(): PcmCapture;
  request(path: string, key: string, signal: AbortSignal, init?: RequestInit): Promise<Response>;
}
const messages: Record<string, string> = {
  NOT_CONFIGURED: 'whisper.cpp ou modelo local não instalado/configurado no Yoga.',
  RATE_LIMIT: 'Limite de três tentativas por minuto atingido. Aguarde.',
  CAPACITY: 'Transcrição ocupada. Tente novamente depois.',
  BAD_TICKET: 'Tentativa vencida ou já utilizada. Segure novamente para uma nova captura.',
  BAD_AUDIO: 'Áudio inválido ou além do limite de 10 segundos/320044 bytes.',
  UNAUTHORIZED: 'Sessão encerrada. Entre novamente com o PIN.',
  FORBIDDEN: 'Acesso restrito ao operador pelo HTTPS privado LAB.',
  TIMEOUT: 'Tempo esgotado. O áudio foi descartado.',
  STT_FAILED: 'Falha no reconhecimento local. Confira a instalação no Yoga.',
};
export class PrivatePttController {
  view: PttView = { visible: false, configured: false, simulated: false, state: 'idle', text: '', message: '' };
  private run?: { abort: AbortController; key: string; ticket?: string; capture: PcmCapture; timer: ReturnType<typeof setTimeout> };
  private loadAbort?: AbortController;
  constructor(private env: PttBrowser, private changed: () => void) {}
  private notify(): void { this.changed(); }
  reset(): void {
    this.loadAbort?.abort(); this.cancel();
    this.view = { visible: false, configured: false, simulated: false, state: 'idle', text: '', message: '' }; this.notify();
  }
  async load(): Promise<void> {
    const key = this.env.key();
    if (!key || !this.env.allowed() || !this.env.secure()) return;
    const abort = new AbortController(); this.loadAbort = abort;
    try {
      const response = await this.env.request('/api/speech/status', key, abort.signal);
      if (!response.ok) return;
      const data = await response.json();
      if (abort.signal.aborted || key !== this.env.key() || !this.env.allowed()) return;
      this.view.visible = data.enabled === true;
      this.view.configured = data.configured === true;
      this.view.simulated = data.simulated === true;
      this.view.message = this.view.configured ? '' : messages['NOT_CONFIGURED']!; this.notify();
    } catch { /* OFF/unavailable: never request mic automatically. */ }
  }
  private async json(path: string, run: NonNullable<PrivatePttController['run']>, init: RequestInit): Promise<any> {
    const response = await this.env.request(path, run.key, run.abort.signal, init);
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.code === 'string' ? data.code : response.status === 401 ? 'UNAUTHORIZED' : 'STT_FAILED');
    return data;
  }
  async press(): Promise<void> {
    const key = this.env.key();
    if (this.run || !this.view.configured || !this.env.allowed() || !this.env.secure() || !key) return;
    this.view.text = ''; this.view.message = ''; this.view.state = 'permission'; this.notify();
    let capture: PcmCapture;
    try { capture = this.env.capture(); } catch { this.view.message = 'Navegador sem captura PCM/AudioWorklet compatível.'; this.view.state = 'error'; this.notify(); return; }
    const run = { key, abort: new AbortController(), capture, ticket: undefined as string | undefined, timer: setTimeout(() => this.cancel(), 10000) };
    this.run = run;
    try {
      const ticket = await this.json('/api/speech/ticket', run, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!this.valid(run)) return;
      if (typeof ticket.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket.ticket)) throw new Error('BAD_TICKET');
      run.ticket = ticket.ticket;
      await capture.start(run.abort.signal, () => this.cancel());
      if (!this.valid(run)) return;
      this.view.state = 'recording'; this.notify();
    } catch (error) { this.failure(run, error); }
  }
  private valid(run: NonNullable<PrivatePttController['run']>): boolean {
    if (this.run !== run || run.abort.signal.aborted) return false;
    if (run.key !== this.env.key() || !this.env.allowed() || !this.env.secure()) { this.cancel(); return false; }
    return true;
  }
  async release(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (this.view.state !== 'recording' || !this.valid(run)) { this.cancel(); return; }
    clearTimeout(run.timer);
    let wav: Uint8Array<ArrayBuffer> | undefined;
    try {
      this.view.state = 'transcribing'; this.notify();
      wav = await run.capture.finish(); // Stop tracks BEFORE transmitting.
      if (!this.valid(run)) return;
      if (!wav.length || wav.length > PRIVATE_PTT_BYTES) throw new Error('BAD_AUDIO');
      this.view.state = 'transcribing'; this.notify();
      run.timer = setTimeout(() => this.cancel(), 20000);
      const data = await this.json('/api/speech/transcribe', run, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-ptt-ticket': run.ticket! }, body: wav.buffer });
      if (!this.valid(run)) return;
      if (data.preview !== true || typeof data.text !== 'string' || data.text.length > 4000) throw new Error('STT_FAILED');
      this.view.text = data.text; this.view.simulated = data.simulated === true; this.view.state = 'done';
      clearTimeout(run.timer); this.run = undefined; run.abort.abort(); this.notify();
    } catch (error) { this.failure(run, error); }
    finally { wav?.fill(0); }
  }
  private failure(run: NonNullable<PrivatePttController['run']>, error: unknown): void {
    if (!this.valid(run)) return;
    this.cancel(); this.view.state = 'error';
    const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
    const code = error instanceof Error ? error.message : '';
    this.view.message = name === 'NotAllowedError' ? 'Permissão de microfone negada.' : messages[code] ?? 'Captura indisponível ou falhou. Áudio descartado.'; this.notify();
  }
  cancel(): void {
    const run = this.run; this.run = undefined;
    if (run) {
      clearTimeout(run.timer); run.abort.abort(); run.capture.cancel();
      if (run.ticket) {
        const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 3000);
        void this.env.request('/api/speech/cancel', run.key, abort.signal, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: run.ticket }) }).catch(() => {}).finally(() => clearTimeout(timer));
      }
    }
    this.view.text = ''; this.view.state = 'cancelled'; this.notify();
  }
}
