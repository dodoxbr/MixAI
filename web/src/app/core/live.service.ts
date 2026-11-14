import type { OperationReceipt } from '../live-ux/operation-view';
import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { SessionService } from './session.service';
import { newId, StateSync, type Hello, type MeterFrame, type Named, type PendingCard, type PendingStatus, type Result, type Snapshot } from './protocol';

export interface MusicianBinding { schemaVersion: 1; sessionId: string; musicianId: string; name: string; channels: number[]; mute: boolean; revision: number }

export type Connection = 'idle' | 'connecting' | 'online' | 'offline';

/**
 * Resultado de uma mensagem do assistente:
 * - ok: chegou a resposta;
 * - offline: NÃO foi enviada (sem conexão) — nada aconteceu no servidor;
 * - lost: foi enviada, mas a conexão caiu (ou o tempo acabou) antes da resposta.
 * Em nenhum caso a mensagem é reenviada sozinha.
 */
export type AssistantOutcome = { ok: true; msg: Record<string, unknown> } | { ok: false; why: 'offline' | 'lost' };

/** Textos da volta ao PIN, conforme o motivo informado pelo servidor. */
export const SESSION_TEXT = {
  expired: 'Sua sessão venceu (vale 12 horas). Entre de novo com o PIN. Nada foi alterado.',
  logout: 'Sua sessão foi encerrada (alguém tocou em Sair com esta sessão). Entre de novo com o PIN.',
  restarted: 'O servidor do MixAI foi reiniciado e as sessões abertas foram encerradas. Entre de novo com o PIN. Pedidos que estavam em andamento não foram repetidos.',
  unknown: 'O servidor não reconheceu mais esta sessão. Entre de novo com o PIN.',
} as const;

export interface Toast {
  id: number;
  kind: 'ok' | 'info' | 'error';
  text: string;
}

const RESOLVED_TEXT: Record<PendingStatus, string> = {
  approved: 'Aprovado e aplicado.',
  rejected: 'Recusado pelo operador.',
  expired: 'A pendência expirou (60 s). Nada foi alterado; peça de novo.',
  invalidated: 'A pendência foi invalidada: a mesa mudou (ou o laboratório foi resetado). Nada foi alterado.',
  failed: 'A aprovação não pôde ser aplicada.',
};

/**
 * Ligação com o servidor (WebSocket): estado sincronizado, pendências, medidores e comandos.
 * - Reconecta sozinho (espera crescente até 5 s).
 * - Ao reconectar recebe um snapshot novo; evento perdido → pede snapshot (StateSync).
 * - Sessão recusada (4401) → volta para a tela de PIN.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly session = inject(SessionService);

  readonly musicianBinding = signal<MusicianBinding | null>(null);
  readonly musicianSession = signal('');
  private musicianTimer: ReturnType<typeof setInterval> | undefined;
  readonly connection = signal<Connection>('idle');
  readonly hello = signal<Hello | null>(null);
  readonly state = signal<Snapshot | null>(null);
  readonly pending = signal<PendingCard[]>([]);
  readonly synchronizing = signal(false);
  readonly faderReceipt = signal<OperationReceipt | null>(null);
  readonly meters = signal<MeterFrame | null>(null);
  readonly channels = signal<Named[]>([]);
  readonly auxes = signal<Named[]>([]);
  readonly auxBuses=computed(()=>this.hello()?.model==='ui16'?Array.from({length:6},(_,i)=>({number:i+1,name:this.auxes().find(a=>a.number===i+1)?.name??'Sem nome local'})):this.auxes());
  readonly toasts = signal<Toast[]>([]);
  /** Pode mexer: conectado e a mesa legível/gravável. */
  readonly writable = computed(() => this.connection() === 'online' && this.state()?.link === 'READY' && this.state()?.available === true && !this.synchronizing());

  private ws: WebSocket | undefined;
  private sync = new StateSync(() => this.raw({ type: 'resync' }));
  private waiting = new Map<string, (r: Result) => void>();
  /** Respostas do assistente (assistant_reply / proposal_result), pelo requestId. */
  private waitingRaw = new Map<string, (m: Record<string, unknown> | null) => void>();
  private retry = 0;
  /** Motivo enviado pelo servidor antes de fechar com 4401 (expired, logout, unknown_session). */
  private authReason: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private toastSeq = 0;
  /** Para testes: substitui o construtor do WebSocket. */
  static socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
    // Liga quando há sessão; desliga quando a sessão termina.
    effect(() => {
      const token = this.session.token();
      this.faderReceipt.set(null);
      if (token) this.open();
      else this.close();
    });
  }

  // ---------- comandos ----------

  /** Comando discreto (mesmo formato da API). Sempre resolve, nunca lança. */
  command(command: Record<string, unknown> & { type: string }, timeoutMs = 10_000): Promise<Result> {
    return this.request({ type: 'command', command }, timeoutMs);
  }

  approve(pendingId: string): Promise<Result> {
    return this.request({ type: 'approve', pendingId });
  }

  reject(pendingId: string): Promise<Result> {
    return this.request({ type: 'reject', pendingId });
  }

  /**
   * Mensagem do assistente com resposta própria (texto livre, aplicar proposta, "melhorou?").
   * Resolve null se a conexão cair ou não houver resposta no tempo: a tela nunca fica travada.
   */
  assistant(msg: Record<string, unknown> & { type: string }, timeoutMs = 25_000): Promise<AssistantOutcome> {
    const requestId = newId('a');
    if (this.connection() !== 'online' || !this.raw({ ...msg, requestId, serverId: this.hello()?.serverId })) {
      return Promise.resolve({ ok: false, why: 'offline' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waitingRaw.delete(requestId);
        resolve({ ok: false, why: 'lost' });
      }, timeoutMs);
      this.waitingRaw.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m ? { ok: true, msg: m } : { ok: false, why: 'lost' });
      });
    });
  }

  /** Cancela uma proposta (sem resposta). */
  send(msg: Record<string, unknown>): void {
    this.raw(msg);
  }

  /** Arraste de fader: o servidor junta os valores; o estado volta pelos eventos. */
  fader(gestureId: string, channel: number, aux: number | undefined, db: number, final: boolean): void {
    this.raw({ type: 'fader', gestureId, channel, aux, db: Number.isFinite(db) ? db : -100, final });
  }

  toast(kind: Toast['kind'], text: string): void {
    const id = ++this.toastSeq;
    this.toasts.update((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => this.toasts.update((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }

  // ---------- conexão ----------

  private open() {
    if (this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.connection.set('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = LiveService.socketFactory(url);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    this.authReason = undefined;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.session.token() }));
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)) as Record<string, unknown>);
      } catch {
        /* mensagem ilegível: ignora (o estado se corrige por snapshot) */
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      for (const resolve of this.waiting.values()) resolve(lost());
      this.waiting.clear();
      for (const resolve of this.waitingRaw.values()) resolve(null);
      this.waitingRaw.clear();
      if (e.code === 4401) {
        this.connection.set('idle');
        this.reset();
        void this.explainRejected(this.authReason);
        return;
      }
      this.connection.set('offline');
      this.scheduleReconnect();
    };
  }

  /**
   * Sessão recusada: volta ao PIN explicando o motivo. Sem motivo específico, compara a
   * instância do servidor: mudou → o servidor foi reiniciado.
   */
  private async explainRejected(reason: string | undefined) {
    if (reason === 'expired') return this.session.expire(SESSION_TEXT.expired);
    if (reason === 'logout') return this.session.expire(SESSION_TEXT.logout);
    const known = this.session.serverId;
    const now = await this.session.hello();
    const restarted = !!known && !!now && now.serverId !== known;
    this.session.expire(restarted ? SESSION_TEXT.restarted : SESSION_TEXT.unknown);
  }

  private close() {
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.reset();
    this.connection.set('idle');
  }

  private reset() {
    clearInterval(this.musicianTimer);
    this.musicianTimer = undefined;
    this.musicianBinding.set(null);
    this.musicianSession.set('');
    this.state.set(null);
    this.synchronizing.set(false); this.faderReceipt.set(null);
    this.hello.set(null);
    this.pending.set([]);
    this.meters.set(null);
    this.sync = new StateSync(() => this.raw({ type: 'resync' }));
  }

  private scheduleReconnect() {
    if (!this.session.token()) return;
    const delay = Math.min(5000, 500 * 2 ** this.retry++);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private raw(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private request(msg: Record<string, unknown>, timeoutMs = 10_000): Promise<Result> {
    const requestId = newId('r');
    // Preso a esta instância do servidor: se ele reiniciar, o pedido é recusado sem executar.
    const sent = this.raw({ ...msg, requestId, serverId: this.hello()?.serverId });
    if (!sent) return Promise.resolve({ ok: false, code: 'SERVER_UNAVAILABLE', message: 'Sem conexão com o servidor. Nada foi enviado.' });
    return new Promise<Result>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve(lost());
      }, timeoutMs);
      this.waiting.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  // ---------- mensagens do servidor ----------

  private handle(m: Record<string, unknown>) {
    switch (m['type']) {
      case 'hello': {
        const h = m as unknown as Hello;
        if (this.hello() && this.hello()!.serverId !== h.serverId) this.pending.set([]);
        this.synchronizing.set(true);
        this.hello.set(h);
        this.session.rememberServer(h.serverId);
        this.connection.set('online');
        this.retry = 0;
        this.sync.handle(m);
        if (h.role === 'operator' && h.meters.available) this.raw({ type: 'meters', on: true, hz: 12 });
        void this.loadNames();
        clearInterval(this.musicianTimer);
        if (h.role === 'musician') { void this.loadMusician(); this.musicianTimer = setInterval(() => void this.loadMusician(), 2000); }
        return;
      }
      case 'snapshot':
      case 'event': {
        const out = this.sync.handle(m);
        if (out === 'resync') this.synchronizing.set(true);
        if (out === 'ready') this.synchronizing.set(false);
        const s = this.sync.state;
        if (out === 'ready' || out === 'applied') this.state.set(s ? { ...s, params: { ...s.params } } : null);
        return;
      }
      case 'names_changed':
        void this.loadNames();return;
      case 'pending_list':
        this.pending.set((m['items'] as PendingCard[]) ?? []);
        return;
      case 'pending': {
        const card = m['card'] as PendingCard;
        this.pending.update((list) => [...list.filter((c) => c.pendingId !== card.pendingId), card]);
        return;
      }
      case 'pending_resolved': {
        const id = m['pendingId'] as string;
        const status = m['status'] as PendingStatus;
        const had = this.pending().some((c) => c.pendingId === id);
        this.pending.update((list) => list.filter((c) => c.pendingId !== id));
        if (had || this.session.role() !== 'operator') this.toast(status === 'approved' ? 'ok' : status === 'rejected' ? 'info' : 'error', RESOLVED_TEXT[status]);
        return;
      }
      case 'result': {
        const id = m['requestId'] as string;
        const done = this.waiting.get(id);
        this.waiting.delete(id);
        done?.(m['result'] as Result);
        return;
      }
      case 'assistant_reply':
      case 'proposal_result': {
        const id = m['requestId'] as string;
        const done = this.waitingRaw.get(id);
        this.waitingRaw.delete(id);
        done?.(m);
        return;
      }
      case 'fader_result': {
        if (typeof m['serverId'] === 'string' && m['serverId'] !== this.hello()?.serverId) return;
        const r = m['result'] as Result;
        this.faderReceipt.set({ receivedAt: Date.now(), result: r });
        if (!r.ok) this.toast('error', r.message);
        return;
      }
      case 'error': {
        // UNAUTHORIZED chega antes do fechamento 4401: guarda o motivo para a tela de PIN.
        if (m['code'] === 'UNAUTHORIZED') this.authReason = typeof m['reason'] === 'string' ? m['reason'] : undefined;
        else if (typeof m['message'] === 'string') this.toast('error', m['message']);
        return;
      }
      case 'meters':
        this.meters.set(m as unknown as MeterFrame);
        return;
      case 'meters_unavailable':
        this.meters.set(null);
        return;
      default:
        return;
    }
  }

  private async loadMusician() {
    if (this.connection() !== 'online') { this.musicianBinding.set(null); return; }
    const token = this.session.token();
    const r = await this.command({ type: 'musician_identity' });
    if (token !== this.session.token() || !r.ok || !r.data || this.hello()?.role !== 'musician') return;
    const binding = r.data['binding'] as MusicianBinding | null;
    this.musicianSession.set(String(r.data['sessionId'] ?? ''));
    if (JSON.stringify(binding) !== JSON.stringify(this.musicianBinding())) {
      this.musicianBinding.set(binding);
      this.channels.set([]);
      this.send({ type: 'resync' });
      await this.loadNames();
    }
  }
  private async loadNames() {
    const token=this.session.token(),server=this.hello()?.serverId;
    const r = await this.command({ type: 'list_names' });
    if (token!==this.session.token()||server!==this.hello()?.serverId||!r.ok || !r.data) return;
    this.channels.set((r.data['channels'] as Named[]) ?? []);
    this.auxes.set((r.data['aux'] as Named[]) ?? []);
  }
}

function lost(): Result {
  return {
    ok: false,
    code: 'INDETERMINATE',
    message: 'A conexão caiu antes da resposta: a alteração PODE ter sido aplicada. Confira os valores na tela antes de repetir.',
  };
}
