import { MusicianAccess as MusicianBindings, musicianRoster } from './musician-access.js';
import { randomUUID } from 'node:crypto';
import type { Expectation, MixController, Result } from '../core/controller.js';
import { jsonSafe, type ActionLog } from '../core/log.js';
import type { ParamKey } from '../core/revisions.js';
import { eventToWire, snapshotToWire, type StateEvent, type WireEvent, type WireSnapshot } from '../core/state.js';
import type { MixerAdapter } from '../mixer/types.js';
import type { Auth, Principal, Role } from './auth.js';
import { ExternalConsent } from './external-consent.js';
import { authorizeCommand, CommandSchema, describeCommand, dispatch, isSceneCommand, visibleKey, type Command } from './commands.js';
import type { ScenesService } from './scenes.js';
import { actorOf, DEFAULT_POLICY, MUSICIAN_PA_STEP_MAX_DB, stepLimitFor, type AccessPolicy, type MusicianAccess } from './policy.js';
import type { MeterSource } from './meters.js';
import type { AssistantService } from '../assistant/service.js';

export const PROTOCOL_VERSION = 1;
export const SERVER_VERSION = '0.7.0';

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
  bindingRevision?: number;
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
  musicians = new MusicianBindings();
  private pendings = new Map<string, PendingRecord>();
  private requests = new Map<string, { at: number; response: Promise<CommandResponse> }>();
  private noticeListeners = new Set<(n: Notice, audience: { roles: Role[]; principalId?: string }) => void>();
  private sweepTimer: NodeJS.Timeout | undefined;
  /** Consentimento de envio a serviços externos de IA: por sessão, só na memória. */
  readonly externalConsent = new ExternalConsent();
  /** Assistente de texto (E4). Montado em start.ts. */
  assistant: AssistantService | undefined;
  /** Cenas do MixAI (E5). */
  scenes: ScenesService | undefined;
  private faders = new Map<string, { running: boolean; next?: { channel: string | number; aux: string | number | undefined; db: number; final: boolean } }>();

  constructor(
    readonly controller: MixController,
    readonly mixer: MixerAdapter,
    readonly mode: Mode,
    readonly auth: Auth,
    private log: ActionLog,
    readonly options: {
      musicianAux: number;
      clock?: () => number;
      meters?: MeterSource;
      /** Política do perfil músico (padrão: fones_only). */
      musicianAccess?: MusicianAccess;
      musicianPaStepDB?: number;
    },
  ) { this.auth.onRevoke(id => this.musicians.end(id)); }

  /** Política de acesso em vigor (fixa durante a execução do servidor). */
  get policy(): AccessPolicy {
    return {
      musicianAux: this.options.musicianAux,
      musicianAccess: this.options.musicianAccess ?? DEFAULT_POLICY.musicianAccess,
      musicianPaStepDB: Math.min(this.options.musicianPaStepDB ?? DEFAULT_POLICY.musicianPaStepDB, MUSICIAN_PA_STEP_MAX_DB),
    };
  }

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
    this.assistant?.stop();
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
      musicianAccess: this.policy.musicianAccess,
      musicianPaStepDB: this.policy.musicianPaStepDB,
      auth: this.auth.configured(),
      meters: { available: !!this.options.meters && this.mode !== 'real', simulated: true },
      assistant: { available: !!this.assistant, ai: !!this.assistant?.aiAvailable() },
      scenes: { available: !!this.scenes, canLoad: !!this.scenes?.labOnly },
    };
  }

  // ---------- estado ----------

  snapshotFor(subject: Role | Principal): WireSnapshot {
    const role = typeof subject === 'string' ? subject : subject.role;
    const binding = typeof subject === 'string' ? undefined : this.musicians.get(subject);
    const base = visibleKey(role, this.policy);
    const visible = (key: ParamKey) => base(key) && (role !== 'musician' || !!binding?.channels.includes(Number(key.split('.')[1])));
    const keys = this.controller.registry.keys().filter(visible);
    return snapshotToWire(this.controller.state.snapshot(keys));
  }

  /** Evento já filtrado para o perfil (a sequência de revisões continua íntegra). */
  eventFor(subject: Role | Principal, ev: StateEvent): WireEvent {
    const role = typeof subject === 'string' ? subject : subject.role;
    if (ev.type === 'params' && role === 'musician') {
      const binding = typeof subject === 'string' ? undefined : this.musicians.get(subject);
      const base = visibleKey(role, this.policy);
      const visible = (key: ParamKey) => base(key) && !!binding?.channels.includes(Number(key.split('.')[1]));
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
  async execute(p: Principal, req: CommandRequest, internal: { expect?: Expectation } = {}): Promise<CommandResponse> {
    const requestId = typeof req.requestId === 'string' ? req.requestId : '';
    if (!REQUEST_ID_RE.test(requestId)) {
      return { requestId, duplicate: false, result: fail('INVALID', 'requestId obrigatório (1 a 64 caracteres: letras, números, . _ : -).') };
    }
    const changed = this.serverChanged(req.serverId);
    if (changed) return { requestId, duplicate: false, result: changed };
    return this.once(p, requestId, () => this.run(p, requestId, req, internal.expect));
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

  /**
   * `expect` (precondição de estado) só chega por parâmetro interno do servidor (assistente),
   * nunca pelo corpo da requisição do cliente. É conferida dentro da fila do controlador.
   */
  private async run(p: Principal, requestId: string, req: CommandRequest, expect?: Expectation): Promise<CommandResponse> {
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
    this.musicians.observe(p);
    const binding = this.musicians.get(p);
    if (parsed.data.type.startsWith('musician_')) {
      const cmd = parsed.data;
      if (cmd.type === 'musician_identity') return reply({ ok: true, code: 'OK', message: 'Identidade vinculada pelo operador.', data: { schemaVersion: 1, sessionId: p.id, binding: binding ?? null, lab: this.mode === 'lab' } });
      if (p.role !== 'operator') return reply(fail('FORBIDDEN', 'Só o operador administra vínculos.'));
      if (this.mode !== 'lab') return reply(fail('MODE_MISMATCH', 'Vínculos disponíveis somente no LAB.'));
      if (cmd.type === 'musician_sessions') return reply({ ok: true, code: 'OK', message: 'Sessões de músicos.', data: { sessions: this.musicians.list(), roster: musicianRoster } });
      try {
        if (cmd.type === 'musician_bind') {
          if (!this.auth.isActive({ id: cmd.sessionId, role: 'musician', label: 'músico' })) return reply(fail('INVALID', 'Sessão encerrada.'));
          const { type: _type, ...input } = cmd;
          const assigned = this.musicians.bind(input, this.controller.names.inputs.list().map(c => c.number));
          this.audit(p, 'musician_bind', 'Vínculo confirmado pelo operador.', { session: assigned.sessionId, musician: assigned.musicianId, channels: assigned.channels, mute: assigned.mute });
        } else if (cmd.type === 'musician_revoke') {
          this.musicians.revoke(cmd.sessionId);
          this.audit(p, 'musician_revoke', 'Vínculo revogado pelo operador.', { session: cmd.sessionId });
        }
        return reply({ ok: true, code: 'OK', message: 'Vínculo atualizado no LAB.' });
      } catch { return reply(fail('INVALID', 'Vínculo inválido; confira sessão e canais configurados.')); }
    }
    const access = this.authorizeMusicianCommand(p, parsed.data);
    if (!access) {
      this.audit(p, 'forbidden', 'Canal, destino ou vínculo não autorizado.', { command: parsed.data.type });
      return reply(fail('FORBIDDEN', 'Sessão sem vínculo autorizado para este canal/destino no LAB. Peça ao operador.'));
    }
    const auth = authorizeCommand(p.role, parsed.data, this.controller.names, this.policy);
    if (!auth.ok) {
      this.audit(p, 'forbidden', auth.message, { command: parsed.data.type });
      return reply(fail('FORBIDDEN', auth.message));
    }
    const command = auth.command;
    if ((command.type === 'set_lab_eq' || command.type === 'reset_lab_eq') && this.mode !== 'lab') {
      return reply(fail('MODE_MISMATCH', 'EQ disponível somente no LABORATÓRIO.'));
    }
    let result: Result;
    if (isSceneCommand(command)) {
      try {
        result = this.scenes ? await this.scenes.handle(p, command) : fail('NOT_CONFIGURED', 'Cenas indisponíveis neste servidor.');
      } catch (err) {
        result = fail('INVALID', `Erro inesperado nas cenas: ${(err as Error).message}`);
      }
      if (result.needsConfirmation && result.pendingId) result = this.registerPending(p, command, result);
      return reply(result);
    }
    try {
      // Músico no PA: limite de passo próprio (3 dB); acima vira aprovação do operador.
      const limit = this.musicianStepLimit(p.role, command);
      if (p.role === 'musician') expect = { ...expect, authorize: () => this.auth.isActive(p) && this.musicians.get(p)?.revision === binding?.revision && this.authorizeMusicianCommand(p, command) };
      result = await dispatch(this.controller, command, undefined, p.role, expect, { actor: this.musicianActor(p), ...limit });
    } catch (err) {
      result = fail('INVALID', `Erro inesperado: ${(err as Error).message}`);
    }
    if (result.needsConfirmation && result.pendingId) result = this.registerPending(p, command, result);
    if (p.role === 'musician' && command.type === 'mix_state' && result.data) {
      // A consulta do PA traz o master junto; o músico nunca vê o master.
      const { master: _m, masterDB: _d, ...rest } = result.data as Record<string, unknown>;
      result = { ...result, data: rest };
    }
    if (p.role === 'musician' && result.data) {
      if (command.type === 'list_names') result = { ...result, data: { ...result.data, channels: this.controller.names.inputs.list().filter(c => binding?.channels.includes(c.number)) } };
      if (command.type === 'mix_state') {
        const data = result.data as Record<string, unknown>;
        if (Array.isArray(data.channels)) result = { ...result, data: { ...data, channels: data.channels.filter((c: any) => binding?.channels.includes(c.channel)) } };
      }
    }
    return reply(result);
  }

  /** Versioned identity contract shared with the future request queue; never supplied by a client. */
  musicianIdentity(p: Principal) { return { schemaVersion: 1 as const, sessionId: p.id, binding: this.musicians.get(p) ?? null }; }
  private musicianActor(p: Principal) {
    const b = this.musicians.get(p);
    return b ? `${b.name} (${b.musicianId}) · sessão ${p.id.slice(0, 6)}` : actorOf(p);
  }
  private musicianStepLimit(role: Role, command: Command) {
    return role === 'musician' && command.type === 'set_level'
      ? { maxStepDB: Math.min(3, this.policy.musicianPaStepDB), stepRule: command.aux === undefined ? 'limite do músico no PA; precisa do operador' : 'limite do músico no AUX compartilhado; precisa do operador' }
      : stepLimitFor(role, command, this.policy);
  }
  authorizeMusicianCommand(p: Principal, cmd: Command): boolean {
    if (p.role !== 'musician') return true;
    if (!['set_level', 'set_mute'].includes(cmd.type)) return true;
    const b = this.musicians.get(p);
    if (this.mode !== 'lab' || this.mixer.mode !== 'lab' || !b || !this.auth.isActive(p)) return false;
    try {
      if (cmd.type === 'set_level') return b.channels.includes(this.controller.names.channel(cmd.channel).number);
      if (cmd.type === 'set_mute') return b.mute && cmd.channels.length === 1 && b.channels.includes(this.controller.names.channel(cmd.channels[0]!).number);
    } catch { return false; }
    return false;
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
    if (p.role === 'musician') return { result: fail('FORBIDDEN', 'Músicos usam somente passos discretos nos canais vinculados.'), closed: true };
    if (p.role === 'agent') return { result: fail('FORBIDDEN', 'O assistente não move faders por arraste; use os comandos.'), closed: true };
    if (msg.targetMode !== undefined && msg.targetMode !== this.mode) {
      return { result: fail('MODE_MISMATCH', `Este servidor está em modo ${this.mode.toUpperCase()}.`), closed: true };
    }
    const auth = authorizeCommand(p.role, { type: 'set_level', channel, aux, db }, this.controller.names, this.policy);
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
        last = await this.controller.setFader({ ...current, gestureId: id, origin: p.role, actor: actorOf(p) });
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
      requestedBy: { role: p.role, label: this.musicianActor(p) },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInSec * 1000).toISOString(),
    };
    this.pendings.set(id, { card, requesterId: p.id, expiresAtMs: now + expiresInSec * 1000, state: 'open', bindingRevision: this.musicians.get(p)?.revision });
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
      if (rec.card.requestedBy.role === 'musician' && !this.musicians.list().some(s => s.sessionId === rec.requesterId && s.observed && s.binding?.revision === rec.bindingRevision)) return reply(fail('FORBIDDEN', 'Vínculo revogado; solicite novamente.'));
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
        const requester = rec.card.requestedBy;
        const cmd = rec.card.command;
        result =
          cmd.type === 'scene_load'
            ? this.scenes
              ? await this.scenes.applyApproved(requester, cmd, pendingId, p)
              : fail('NOT_CONFIGURED', 'Cenas indisponíveis neste servidor.')
            : await dispatch(this.controller, cmd, pendingId, requester.role, requester.role === 'musician' ? { authorize: () => { const owner = { id: rec.requesterId, role: 'musician' as const, label: requester.label }; return this.auth.isActive(owner) && this.musicians.get(owner)?.revision === rec.bindingRevision && this.authorizeMusicianCommand(owner, cmd); } } : undefined, {
                actor: `${requester.label}; aprovado por ${actorOf(p)}`,
                ...this.musicianStepLimit(requester.role, cmd),
              });
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
    this.assistant?.sweep();
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
    this.log.add({ action: `server_${action}`, ok: false, message, details: { ...details, role: p?.role, ...(p ? { by: this.musicianActor(p) } : {}) } });
  }
}

export function fail(code: Result['code'], message: string): Result {
  return { ok: false, code, message };
}
