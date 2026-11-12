import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';

/** Limites e textos da tela supervisionada. A tela NÃO decide nada: só chama prévia/confirmação do servidor (#100). */
export const STEP_DB = 0.5;
const CONFIRM_TIMEOUT_MS = 12_000;
const PREVIEW_TTL_MS = 15_000;

export interface AuxStatus {
  serverId: string; mode: string; model: string; link: string;
  feature: { gate: boolean; validation: string | null; available: boolean; state: 'not_real' | 'disabled' | 'blocked' | 'enabled' };
  stepDB: number; maxStepDB: number;
  channels: Array<{ number: number; name: string }>; aux: Array<{ number: number; name: string }>;
  observed: number | '-inf' | null;
}
export interface AuxPreview { id: string; channel: number; aux: number; previous: number; requested: number; observed: number | '-inf' | null; expiresAtMs: number; validation: string }
export type ConfirmationStatus = 'observed_target' | 'unconfirmed' | 'not_sent' | 'indeterminate';
export interface AuxOutcome { status: ConfirmationStatus; previous: number | null; requested: number | null; observed: number | '-inf' | null; message: string; causalAcknowledgement: false }

const ERRORS: Record<string, string> = {
  UNAUTHORIZED: 'Sessão encerrada ou expirada. Entre novamente; nada foi enviado.',
  FORBIDDEN: 'Somente o operador autenticado pode usar este teste.',
  MODE_MISMATCH: 'O servidor não está em REAL. Nada foi enviado.',
  SERVER_CHANGED: 'A instância do servidor mudou. Atualize a tela; nada foi enviado.',
  DEGRADED_READ_ONLY: 'Escrita AUX bloqueada: sem validação física, identificação, conexão ou rota válidas. Nada foi enviado.',
  INVALID: 'Pedido recusado pelo servidor (canal/AUX não cadastrados ou passo fora do limite). Nada foi enviado.',
  STATE_CHANGED: 'Leitura atual indisponível, antiga ou diferente. Atualize e prepare de novo; nada foi enviado.',
  CONFIRMATION_EXPIRED: 'A prévia expirou. Prepare de novo; nada foi enviado.',
  CONFIRMATION_USED: 'Esta prévia já foi usada. Prepare outra se precisar.',
  NOT_FOUND: 'Prévia não encontrada nesta sessão. Prepare de novo; nada foi enviado.',
  CONFLICT: 'Outro ajuste deste envio está em andamento. Não reenvie.',
  RATE_LIMIT: 'Limite de prévias atingido; aguarde.',
  INDETERMINATE: 'Resultado indeterminado. Confira o estado na mesa antes de qualquer nova operação.',
};
const num = (v: unknown): number | '-inf' | null => (v === '-inf' ? '-inf' : typeof v === 'number' && Number.isFinite(v) ? v : null);

@Injectable()
export class SupervisedAuxService implements OnDestroy {
  private readonly live = inject(LiveService);
  private readonly session = inject(SessionService);
  readonly status = signal<AuxStatus | null>(null);
  readonly channel = signal<number | null>(null);
  readonly aux = signal<number | null>(null);
  readonly preview = signal<AuxPreview | null>(null);
  readonly outcome = signal<AuxOutcome | null>(null);
  readonly busy = signal<'preview' | 'confirm' | null>(null);
  /** Leitura de estado em andamento: não bloqueia a tela (só evita leituras sobrepostas). */
  private refreshing = false;
  readonly error = signal('');
  readonly now = signal(Date.now());
  readonly operator = computed(() => !!this.session.token() && this.live.hello()?.role === 'operator' && this.live.connection() === 'online');
  /** LAB/MOCK: as rotas REAL nem existem. A tela fica explicitamente bloqueada e não chama nada. */
  readonly lab = computed(() => this.operator() && this.live.hello()?.mode !== 'real');
  readonly real = computed(() => this.operator() && this.live.hello()?.mode === 'real');
  readonly enabled = computed(() => this.real() && this.status()?.feature.state === 'enabled' && this.status()?.serverId === this.live.hello()?.serverId);
  readonly remainingMs = computed(() => { const p = this.preview(); return p ? Math.max(0, p.expiresAtMs - this.now()) : 0; });
  readonly previewValid = computed(() => !!this.preview() && this.remainingMs() > 0);
  private epoch = 0;
  private ctl?: AbortController;
  private ticker = setInterval(() => this.now.set(Date.now()), 500);
  /** Releitura do estado (frescor do valor observado). Nunca durante uma operação em andamento. */
  private poll = setInterval(() => { if (this.real() && !this.busy()) void this.refresh(); }, 2000);
  constructor() {
    effect(() => {
      this.session.token(); this.live.hello()?.serverId; this.live.hello()?.mode; this.live.connection();
      const real = this.real();
      untracked(() => { this.reset(); if (real) void this.refresh(); });
    });
  }
  ngOnDestroy() { clearInterval(this.ticker); clearInterval(this.poll); this.reset(); }
  /** Qualquer troca de sessão/servidor/conexão descarta prévia e resultado: nada é reaproveitado entre contextos. */
  private reset() {
    this.epoch++; this.ctl?.abort(); this.ctl = undefined;
    this.status.set(null); this.preview.set(null); this.outcome.set(null); this.error.set(''); this.busy.set(null); this.refreshing = false;
  }
  selectChannel(n: number | null) { if (this.busy()) return; this.channel.set(Number.isInteger(n) ? n : null); this.dropPreview(); void this.refresh(); }
  selectAux(n: number | null) { if (this.busy()) return; this.aux.set(Number.isInteger(n) ? n : null); this.dropPreview(); void this.refresh(); }
  /** O servidor não tem endpoint de cancelamento: a prévia local é descartada e a do servidor expira sozinha (15 s). */
  dropPreview() { this.preview.set(null); this.outcome.set(null); this.error.set(''); }
  cancel() { this.dropPreview(); }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: unknown }, timeoutMs: number): Promise<{ status: number; json: Record<string, any> } | 'timeout' | 'offline'> {
    const token = this.session.token();
    if (!token) return { status: 401, json: { code: 'UNAUTHORIZED' } };
    const ctl = new AbortController(); this.ctl = ctl;
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(path, { method: init.method, cache: 'no-store', credentials: 'omit', signal: ctl.signal,
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json: json && typeof json === 'object' ? json : {} };
    } catch (e) { return ctl.signal.aborted && ctl.signal.reason === 'timeout' ? 'timeout' : (ctl.signal.aborted ? 'offline' : 'offline'); }
    finally { clearTimeout(timer); }
  }

  async refresh() {
    if (!this.real() || this.busy() || this.refreshing) return;
    const epoch = this.epoch; this.refreshing = true;
    const q = this.channel() && this.aux() ? `?channel=${this.channel()}&aux=${this.aux()}` : '';
    const r = await this.call('/api/ui16/aux/status' + q, { method: 'GET' }, 6000);
    if (epoch !== this.epoch) return;
    this.refreshing = false;
    if (r === 'timeout' || r === 'offline') { this.status.set(null); this.error.set('Sem resposta do servidor. Estado do recurso REAL desconhecido; tratado como bloqueado.'); return; }
    if (r.status !== 200 || typeof r.json['serverId'] !== 'string') { this.status.set(null); this.error.set(ERRORS[String(r.json['code'])] ?? 'Estado do recurso REAL indisponível; tratado como bloqueado.'); return; }
    const s = r.json as unknown as AuxStatus;
    this.status.set(s); this.error.set('');
    // Sem seleção padrão: a primeira escrita física exige escolha explícita de canal e AUX pelo operador.
    if (this.channel() !== null && !s.channels.some(c => c.number === this.channel())) this.channel.set(null);
    if (this.aux() !== null && !s.aux.some(a => a.number === this.aux())) this.aux.set(null);
  }

  async prepare(direction: 1 | -1) {
    if (!this.enabled() || this.busy() || this.channel() === null || this.aux() === null) return;
    const epoch = this.epoch; this.dropPreview(); this.busy.set('preview');
    const serverId = this.live.hello()!.serverId, channel = this.channel()!, aux = this.aux()!;
    const r = await this.call('/api/ui16/aux/preview', { method: 'POST', body: { targetMode: 'real', serverId, channel, aux, deltaDB: direction * STEP_DB } }, 8000);
    if (epoch !== this.epoch) return;
    this.busy.set(null);
    if (r === 'timeout' || r === 'offline') { this.error.set('Sem resposta do servidor na prévia. Nada foi enviado.'); return; }
    const card = r.json['proposal'] as { id?: string } | undefined;
    if (r.status !== 200 || !card || typeof card.id !== 'string' || typeof r.json['previous'] !== 'number' || typeof r.json['requested'] !== 'number') {
      const code = String((r.json['result'] as { code?: string } | undefined)?.code ?? r.json['code'] ?? '');
      this.error.set(ERRORS[code] ?? ((r.json['result'] as { message?: string } | undefined)?.message ?? 'Prévia recusada. Nada foi enviado.')); return;
    }
    this.preview.set({ id: card.id, channel, aux, previous: r.json['previous'] as number, requested: r.json['requested'] as number,
      observed: num(r.json['observed']), expiresAtMs: Date.now() + PREVIEW_TTL_MS, validation: String(r.json['validation'] ?? '') });
    this.now.set(Date.now());
  }

  /** Ação humana explícita (clique). requestId único por tentativa; NUNCA reenviado automaticamente. */
  async confirm() {
    const p = this.preview();
    if (!p || !this.enabled() || this.busy() || !this.previewValid()) return;
    const epoch = this.epoch; this.busy.set('confirm'); this.error.set('');
    const requestId = 'ui-' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    const r = await this.call(`/api/ui16/aux/${p.id}/confirm`, { method: 'POST', body: { targetMode: 'real', serverId: this.live.hello()!.serverId, requestId, humanConfirmed: true } }, CONFIRM_TIMEOUT_MS);
    if (epoch !== this.epoch) return; // sessão/servidor/conexão mudou: descarta a resposta tardia
    this.busy.set(null); this.preview.set(null);
    if (r === 'timeout' || r === 'offline') {
      this.outcome.set({ status: 'indeterminate', previous: p.previous, requested: p.requested, observed: null, causalAcknowledgement: false,
        message: 'Sem resposta do servidor. O envio pode ou não ter ocorrido: confira o fader na mesa. Não reenvie automaticamente.' });
      return;
    }
    const c = r.json['confirmation'] as { status?: string; previous?: unknown; requested?: unknown; observed?: unknown; reason?: string } | undefined;
    const code = String((r.json['result'] as { code?: string } | undefined)?.code ?? r.json['code'] ?? '');
    if (r.status === 401) { this.error.set(ERRORS['UNAUTHORIZED']!); return; }
    if (c && (c.status === 'observed_target' || c.status === 'unconfirmed' || c.status === 'not_sent')) {
      const message = c.status === 'observed_target' ? 'Observamos uma amostra independente no valor pedido. Isso não prova que o MixAI causou a mudança nem melhora de áudio.'
        : c.status === 'unconfirmed' ? 'Não confirmado: confira o fader na mesa antes de nova operação. Nada foi repetido ou desfeito automaticamente.'
        : (ERRORS[code] ?? 'Nada foi enviado à mesa.');
      this.outcome.set({ status: c.status, previous: num(c.previous) as number | null, requested: num(c.requested) as number | null, observed: num(c.observed), message, causalAcknowledgement: false });
      void this.refresh(); return;
    }
    if (code === 'INDETERMINATE') { this.outcome.set({ status: 'indeterminate', previous: p.previous, requested: p.requested, observed: null, causalAcknowledgement: false, message: ERRORS['INDETERMINATE']! }); return; }
    this.outcome.set({ status: 'not_sent', previous: p.previous, requested: p.requested, observed: null, causalAcknowledgement: false, message: ERRORS[code] ?? 'Confirmação recusada. Nada foi enviado.' });
  }
}
