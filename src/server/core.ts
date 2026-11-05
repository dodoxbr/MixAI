import { randomUUID } from 'node:crypto';
import type { MixController, Result } from '../core/controller.js';
import { jsonSafe, type ActionLog } from '../core/log.js';
import type { ParamKey } from '../core/revisions.js';
import { eventToWire, snapshotToWire, type StateEvent, type WireEvent, type WireSnapshot } from '../core/state.js';
import type { MixerAdapter } from '../mixer/types.js';
import type { Auth, Principal, Role } from './auth.js';
import { authorizeCommand, CommandSchema, describeCommand, dispatch, visibleKey, type Command } from './commands.js';
import type { MeterSource } from './meters.js';

export const PROTOCOL_VERSION = 1;
export const SERVER_VERSION = '0.4.0';

export type Mode = 'mock' | 'lab' | 'real';

/** Resposta de um comando: o Result do controlador (com -∞ já como "-inf"). */
export type WireResult = Result;

/** Contrato dos cartões de confirmação (a interface da E3 vai desenhá-los). */
export interface PendingCard {
  pendingId: string;
  status: 'open';
  /** Texto pronto para o cartão (o que vai mudar e por que precisa de aprovação). */
  summary: string;
  /** Resumo curto do comando ("volume de voz 2 no PA"). */
  title: string;
  command: Command;
  requestedBy: { role: Role; label: string };
  createdAt: string;
  expiresAt: string;
}

export type PendingStatus = 'approved' | 'rejected' | 'expired' | 'invalidated' | 'failed';

/** Avisos do servidor para as telas (além dos eventos de estado). */
export type Notice =
  | { type: 'pending'; card: PendingCard }
  | { type: 'pending_resolved'; pendingId: string; status: PendingStatus; by?: string; result?: WireResult };

interface PendingRecord {
  card: PendingCard;
  requesterId: string;
  expiresAtMs: number;
  state: 'open' | 'approving' | PendingStatus;
}

export interface CommandRequest {
  requestId?: unknown;
  /**
   * serverId esperado. Se o servidor for outro (reiniciou), o pedido é recusado com
   * SERVER_CHANGED SEM executar: uma repetição nunca é executada numa instância nova.
   */
  serverId?: unknown;
  targetMode?: unknown;
  command?: unknown;
}

export interface CommandResponse {
  requestId: string;
  duplicate: boolean;
  result: WireResult;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Coração do servidor da E2. Dono ÚNICO (no processo) do controlador, do estado observável,
 * da fila, das confirmações, da autorização e do histórico. HTTP, WebSocket e o MCP falam com
 * ele; nenhum deles toca o controlador ou a mesa diretamente.
 */
export class ServerCore {
  /** Muda a cada início: o cliente que vê outro serverId descarta tudo e pede snapshot. */
  readonly serverId = randomUUID();
  private pendings = new Map<string, PendingRecord>();
  private requests = new Map<string, { at: number; response: Promise<CommandResponse> }>();
  private noticeListeners = new Set<(n: Notice, audience: { roles: Role[]; principalId?: string }) => void>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private faders = new Map<string, { running: boolean; next?: { channel: string | number; aux: string | number | undefined; db: number; final: boolean } }>();

  constructor(
    readonly controller: MixController,
    readonly mixer: MixerAdapter,
    readonly mode: Mode,
    readonly auth: Auth,
    private log: ActionLog,
    readonly options: { musicianAux: number; clock?: () => number; meters?: MeterSource },
  ) {}

  get meters(): MeterSource | undefined {
    return this.options.meters;
  }

  private now() {
    return (this.options.clock ?? Date.now)();
  }

  start(): void {
    this.sweepTimer ??= setInterval(() => this.sweep(), 1000);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  hello() {
    return {
      protocol: PROTOCOL_VERSION,
      version: SERVER_VERSION,
      serverId: this.serverId,
      mode: this.mode,
      model: this.mixer.capabilities().model,
      link: this.mixer.link(),
      musicianAux: this.options.musicianAux,
      auth: this.auth.configured(),
      meters: { available: !!this.options.meters && this.mode !== 'real', simulated: true },
    };
  }

  // ---------- estado ----------

  snapshotFor(role: Role): WireSnapshot {
    const visible = visibleKey(role, this.options.musicianAux);
    const keys = this.controller.registry.keys().filter(visible);
    return snapshotToWire(this.controller.state.snapshot(keys));
  }

  /** Evento já filtrado para o perfil (a sequência de revisões continua íntegra). */
  eventFor(role: Role, ev: StateEvent): WireEvent {
    if (ev.type === 'params' && role === 'musician') {
      const visible = visibleKey(role, this.options.musicianAux);
      return eventToWire({ ...ev, changes: ev.changes.filter((c) => visible(c.key as ParamKey)) });
    }
    return eventToWire(ev);
  }

  subscribeState(listener: (ev: StateEvent) => void): () => void {
    return this.controller.state.subscribe(listener);
  }

  onNotice(listener: (n: Notice, audience: { roles: Role[]; principalId?: string }) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  // ---------- comandos ----------

  /**
   * Executa um comando com proteção contra repetição: o mesmo requestId do mesmo usuário
   * devolve a MESMA resposta, sem executar de novo (inclusive se chegar enquanto o primeiro roda).
   */
  async execute(p: Principal, req: CommandRequest): Promise<CommandResponse> {
    const requestId = typeof req.requestId === 'string' ? req.requestId : '';
    if (!REQUEST_ID_RE.test(requestId)) {
      return { requestId, duplicate: false, result: fail('INVALID', 'requestId obrigatório (1 a 64 caracteres: letras, números, . _ : -).') };
    }
    const changed = this.serverChanged(req.serverId);
    if (changed) return { requestId, duplicate: false, result: changed };
    return this.once(p, requestId, () => this.run(p, requestId, req));
  }

  private async once(p: Principal, requestId: string, fn: () => Promise<CommandResponse>): Promise<CommandResponse> {
    this.pruneRequests();
    const key = `${p.id}:${requestId}`;
    const seen = this.requests.get(key);
    if (seen) return { ...(await seen.response), duplicate: true };
    const response = fn();
    this.requests.set(key, { at: this.now(), response });
    return response;
  }

  private async run(p: Principal, requestId: string, req: CommandRequest): Promise<CommandResponse> {
    const reply = (result: Result): CommandResponse => ({ requestId, duplicate: false, result: jsonSafe(result) as Result });
    if (req.targetMode !== undefined && req.targetMode !== this.mode) {
      const message = `Este servidor está em modo ${this.mode.toUpperCase()} e recusa comandos para o modo ${String(req.targetMode).toUpperCase()}. O modo é fixo na inicialização.`;
      this.audit(p, 'mode_mismatch', message);
      return reply(fail('MODE_MISMATCH', message));
    }
    const raw = req.command as Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object' && ('confirmationId' in raw || 'confirmation_id' in raw || 'confirm' in raw)) {
      const message =
        p.role === 'agent'
          ? 'O assistente não pode confirmar operações críticas. A pendência continua aguardando a aprovação de um operador na tela do MixAI.'
          : 'Confirmações não vão junto do comando: aprove o cartão da pendência (canal de aprovação do operador).';
      this.audit(p, 'confirmation_refused', message);
      return reply(fail('FORBIDDEN', message));
    }
    const parsed = CommandSchema.safeParse(raw);
    if (!parsed.success) return reply(fail('INVALID', `Comando inválido: ${parsed.error.issues.map((i) => i.message).join('; ')}`));
    const auth = authorizeCommand(p.role, parsed.data, this.controller.names, this.options.musicianAux);
    if (!auth.ok) {
      this.audit(p, 'forbidden', auth.message, { command: parsed.data.type });
      return reply(fail('FORBIDDEN', auth.message));
    }
    const command = auth.command;
    let result: Result;
    try {
      result = await dispatch(this.controller, command, undefined, p.role);
    } catch (err) {
      result = fail('INVALID', `Erro inesperado: ${(err as Error).message}`);
    }
    if (result.needsConfirmation && result.pendingId) result = this.registerPending(p, command, result);
    return reply(result);
  }

  // ---------- gesto de fader (arraste humano) ----------

  /**
   * Arraste de fader vindo de uma tela. Só pessoas (operador e músico, este só no AUX dele); o
   * assistente nunca arrasta. Enquanto uma escrita do gesto está em andamento, as mensagens
   * seguintes são JUNTADAS: só o valor mais recente é escrito depois (coalescência).
   * Devolve o resultado da última escrita e se o gesto foi fechado (soltou ou erro), ou
   * undefined se a mensagem foi juntada a outra que já está sendo processada.
   */
  async fader(p: Principal, msg: Record<string, unknown>): Promise<{ result: Result; closed: boolean } | undefined> {
    const gestureId = typeof msg.gestureId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(msg.gestureId) ? msg.gestureId : '';
    const db = typeof msg.db === 'number' && msg.db >= -100 && msg.db <= 10 ? msg.db : undefined;
    const channel = msg.channel;
    const aux = msg.aux;
    const final = msg.final === true;
    if (!gestureId || db === undefined || (typeof channel !== 'string' && typeof channel !== 'number')) {
      return { result: fail('INVALID', 'Gesto de fader inválido (gestureId, channel e db obrigatórios).'), closed: true };
    }
    if (aux !== undefined && typeof aux !== 'string' && typeof aux !== 'number') return { result: fail('INVALID', 'aux inválido.'), closed: true };
    if (p.role === 'agent') return { result: fail('FORBIDDEN', 'O assistente não move faders por arraste; use os comandos.'), closed: true };
    if (msg.targetMode !== undefined && msg.targetMode !== this.mode) {
      return { result: fail('MODE_MISMATCH', `Este servidor está em modo ${this.mode.toUpperCase()}.`), closed: true };
    }
    const auth = authorizeCommand(p.role, { type: 'set_level', channel, aux, db }, this.controller.names, this.options.musicianAux);
    if (!auth.ok) {
      this.audit(p, 'forbidden', auth.message, { command: 'fader' });
      return { result: fail('FORBIDDEN', auth.message), closed: true };
    }
    const id = `${p.id}:${gestureId}`;
    const st = this.faders.get(id) ?? { running: false };
    const req = { channel, aux, db, final };
    if (st.running) {
      st.next = st.next?.final ? { ...req, final: true } : req; // um "soltou" pendente nunca se perde
      return undefined;
    }
    this.faders.set(id, st);
    st.running = true;
    let current: typeof req | undefined = req;
    let last: Result = fail('INVALID', 'gesto vazio');
    let closed = false;
    try {
      while (current) {
        last = await this.controller.setFader({ ...current, gestureId: id, origin: p.role });
        closed = !!current.final || !last.ok;
        current = st.next;
        st.next = undefined;
        if (!last.ok && current) {
          if (current.final) closed = true;
          current = undefined; // erro: descarta o resto do gesto (o servidor já fechou o gesto)
        }
      }
    } finally {
      st.running = false;
      if (closed) this.faders.delete(id);
    }
    return { result: jsonSafe(last) as Result, closed };
  }

  /** A tela caiu no meio de um arraste: fecha os gestos dela (vira um item no desfazer). */
  async endFaders(p: Principal, gestureIds: Iterable<string>): Promise<void> {
    for (const g of gestureIds) {
      this.faders.delete(`${p.id}:${g}`);
      await this.controller.endFader(`${p.id}:${g}`);
    }
  }

  // ---------- aprovação humana ----------

  private registerPending(p: Principal, command: Command, result: Result): Result {
    const id = result.pendingId!;
    const expiresInSec = Number(result.data?.expiresInSec ?? 60);
    const summary = String(result.data?.summary ?? result.message);
    const now = this.now();
    const card: PendingCard = {
      pendingId: id,
      status: 'open',
      summary,
      title: describeCommand(command),
      command,
      requestedBy: { role: p.role, label: p.label },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInSec * 1000).toISOString(),
    };
    this.pendings.set(id, { card, requesterId: p.id, expiresAtMs: now + expiresInSec * 1000, state: 'open' });
    this.notify({ type: 'pending', card }, { roles: ['operator'] });
    return {
      ...result,
      message: `${summary} Nada foi alterado. Aguardando a aprovação de um operador na tela do MixAI (vale ${expiresInSec} s).`,
      data: { ...result.data, approval: 'operator_screen' },
    };
  }

  /** Pendências que ainda podem ser aprovadas (para o operador). */
  listPending(p: Principal): { ok: true; items: PendingCard[] } | { ok: false; result: Result } {
    if (p.role !== 'operator') return { ok: false, result: fail('FORBIDDEN', 'Só o operador vê e aprova pendências.') };
    this.sweep();
    return { ok: true, items: [...this.pendings.values()].filter((r) => r.state === 'open').map((r) => r.card) };
  }

  /**
   * Aprovação: SÓ operador autenticado por PIN. O comando aprovado é exatamente o que gerou a
   * pendência; o controlador ainda confere hash, revisões, validade e uso único.
   */
  async approve(p: Principal, requestId: unknown, pendingId: string, serverId?: unknown): Promise<CommandResponse> {
    return this.decide(p, requestId, pendingId, true, serverId);
  }

  async reject(p: Principal, requestId: unknown, pendingId: string, serverId?: unknown): Promise<CommandResponse> {
    return this.decide(p, requestId, pendingId, false, serverId);
  }

  /** undefined = mesmo servidor (ou não informado). */
  private serverChanged(expected: unknown): Result | undefined {
    if (expected === undefined || expected === this.serverId) return undefined;
    return fail(
      'SERVER_CHANGED',
      'O servidor do MixAI foi reiniciado depois que este pedido foi preparado. Ele foi recusado sem executar; confira o estado atual antes de pedir de novo.',
    );
  }

  private async decide(
    p: Principal,
    requestIdRaw: unknown,
    pendingId: string,
    approve: boolean,
    serverId?: unknown,
  ): Promise<CommandResponse> {
    const requestId = typeof requestIdRaw === 'string' ? requestIdRaw : '';
    if (!REQUEST_ID_RE.test(requestId)) {
      return { requestId, duplicate: false, result: fail('INVALID', 'requestId obrigatório.') };
    }
    const changed = this.serverChanged(serverId);
    if (changed) return { requestId, duplicate: false, result: changed };
    return this.once(p, requestId, async () => {
      const reply = (result: Result): CommandResponse => ({ requestId, duplicate: false, result: jsonSafe(result) as Result });
      if (p.role !== 'operator') {
        const message =
          p.role === 'agent'
            ? 'O assistente não pode aprovar operações críticas, nem as próprias. Só um operador, na tela do MixAI.'
            : 'Só o operador aprova ou recusa operações críticas.';
        this.audit(p, approve ? 'approve_refused' : 'reject_refused', message, { pendingId });
        return reply(fail('FORBIDDEN', message));
      }
      this.sweep();
      const rec = this.pendings.get(pendingId);
      if (!rec) return reply(fail('NOT_FOUND', `Pendência "${pendingId}" não encontrada.`));
      if (rec.state !== 'open') {
        const code = rec.state === 'expired' ? 'CONFIRMATION_EXPIRED' : rec.state === 'invalidated' ? 'CONFIRMATION_STALE' : 'CONFIRMATION_USED';
        return reply(fail(code, `Esta pendência não está mais aberta (${rec.state}). Peça de novo.`));
      }
      rec.state = 'approving';
      if (!approve) {
        this.controller.cancelPending(pendingId);
        rec.state = 'rejected';
        const result: Result = { ok: true, code: 'OK', message: `Recusado pelo operador: ${rec.card.summary}` };
        this.audit(p, 'reject', result.message, { pendingId });
        this.notify({ type: 'pending_resolved', pendingId, status: 'rejected', by: p.label }, { roles: ['operator'], principalId: rec.requesterId });
        return reply(result);
      }
      let result: Result;
      try {
        result = await dispatch(this.controller, rec.card.command, pendingId, rec.card.requestedBy.role);
      } catch (err) {
        result = fail('INVALID', `Erro inesperado: ${(err as Error).message}`);
      }
      const status: PendingStatus =
        result.ok || result.code === 'PARTIAL'
          ? 'approved'
          : result.code === 'CONFIRMATION_EXPIRED'
            ? 'expired'
            : result.code === 'CONFIRMATION_STALE'
              ? 'invalidated'
              : 'failed';
      rec.state = status;
      const safe = jsonSafe(result) as Result;
      this.notify({ type: 'pending_resolved', pendingId, status, by: p.label, result: safe }, { roles: ['operator'], principalId: rec.requesterId });
      return reply(result);
    });
  }

  /** Fecha pendências vencidas ou invalidadas (ex.: reset, mudança na mesa) e avisa as telas. */
  sweep(): void {
    void this.controller.sweepGestures(3000);
    const now = this.now();
    for (const [id, rec] of this.pendings) {
      if (rec.state === 'open' && !this.controller.isPendingOpen(id)) {
        rec.state = now > rec.expiresAtMs ? 'expired' : 'invalidated';
        this.notify({ type: 'pending_resolved', pendingId: id, status: rec.state }, { roles: ['operator'], principalId: rec.requesterId });
      }
      if (rec.state !== 'open' && rec.state !== 'approving' && now - rec.expiresAtMs > 10 * 60_000) this.pendings.delete(id);
    }
  }

  // ---------- internos ----------

  private notify(n: Notice, audience: { roles: Role[]; principalId?: string }) {
    for (const l of this.noticeListeners) {
      try {
        l(n, audience);
      } catch {
        /* uma tela com erro não atrapalha as outras */
      }
    }
  }

  private pruneRequests() {
    const now = this.now();
    if (this.requests.size < 200) return;
    for (const [k, v] of this.requests) if (now - v.at > 10 * 60_000) this.requests.delete(k);
    while (this.requests.size > 2000) this.requests.delete(this.requests.keys().next().value!);
  }

  /** Registro no histórico. Nunca inclui PIN nem token. */
  audit(p: Principal | undefined, action: string, message: string, details: Record<string, unknown> = {}) {
    this.log.add({ action: `server_${action}`, ok: false, message, details: { ...details, role: p?.role } });
  }
}

export function fail(code: Result['code'], message: string): Result {
  return { ok: false, code, message };
}
