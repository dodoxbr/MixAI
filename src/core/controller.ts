import type { SafetyConfig } from './config.js';
import { ChannelMap, NameResolutionError, type Resolved } from './channels.js';
import type { ActionLog } from './log.js';
import { commandHash, PendingStore } from './pending.js';
import { CommandQueue } from './queue.js';
import { paramKey, RevisionTracker, sameValue, type Actor, type ParamKey, type ParamValue } from './revisions.js';
import { UndoStack, type UndoItem } from './undo.js';
import {
  auxBus,
  LinkUnavailableError,
  MASTER,
  type Bus,
  type LinkState,
  type MixerAdapter,
  type VerificationReport,
  type WriteOutcome,
} from '../mixer/types.js';

export type ResultCode =
  | 'OK'
  | 'PARTIAL'
  | 'NEEDS_CONFIRMATION'
  | 'NO_CONNECTION'
  | 'RESYNCING'
  | 'DEGRADED_READ_ONLY'
  | 'CONTROL_STOPPED'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'NOT_CONFIGURED'
  | 'RATE_LIMIT'
  | 'INVALID'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_MISMATCH'
  | 'CONFIRMATION_STALE'
  | 'CONFIRMATION_USED';

export interface Result {
  ok: boolean;
  code: ResultCode;
  /** true = nada foi feito; repita o comando com confirmationId depois do "sim" do usuário. */
  needsConfirmation?: boolean;
  pendingId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LevelRequest {
  channel: string | number;
  aux?: string | number;
  /** Valor absoluto em dB (≤ -80 = fader todo para baixo). */
  db?: number;
  /** Mudança relativa em dB (+3 sobe, -3 desce). */
  deltaDB?: number;
  /** Aceito por compatibilidade; sozinho NUNCA executa (devolve uma pendência). */
  confirm?: boolean;
  confirmationId?: string;
}

export interface MuteRequest {
  channels: Array<string | number>;
  muted: boolean;
  aux?: string | number;
  confirm?: boolean;
  confirmationId?: string;
}

interface Change {
  key: ParamKey;
  label: string;
  from: ParamValue;
  to: ParamValue;
}

/** Escrita interrompida por um erro inesperado: não se sabe se chegou à mesa. */
interface UncertainChange extends Change {
  error: string;
}

interface ApplyResult {
  done: DoneChange[];
  /** No máximo uma: a escrita em andamento quando o erro inesperado aconteceu. */
  uncertain: UncertainChange[];
  notSent: Change[];
}

interface DoneChange extends Change {
  outcome: WriteOutcome;
  revisionBefore: number;
  revisionAtWrite: number;
  actorBefore?: Actor;
}

/** Abaixo disso, consideramos o fader todo para baixo. */
const SILENCE_DB = -80;

export function formatDB(db: number): string {
  if (!Number.isFinite(db)) return db < 0 ? '-∞ dB' : '+∞ dB';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : ''}${r} dB`;
}

const roundHalf = (db: number) => (Number.isFinite(db) ? Math.round(db * 2) / 2 : db);

const fmt = (v: ParamValue) => (typeof v === 'boolean' ? (v ? 'mutado' : 'aberto') : formatDB(v));

const ACTOR_TEXT: Record<Actor, string> = {
  mixai: 'pelo MixAI',
  external: 'por outro aparelho ou na própria mesa',
  resync: 'na reconexão (a mesa mostrou outro valor ou não confirmou)',
  snapshot: 'por um snapshot',
  uncertain: 'e o resultado ficou incerto (queda de conexão ou erro durante o envio); por segurança não desfaço',
};

/**
 * Cérebro do MixAI: traduz nomes, aplica as travas, serializa as escritas numa fila única,
 * controla revisões, desfazer causal, pendências de confirmação e o log.
 * A IA (e qualquer outro cliente) só chega na mesa por aqui.
 */
export class MixController {
  private readonly queue = new CommandQueue();
  private readonly tracker = new RevisionTracker();
  private readonly undoStack = new UndoStack();
  private readonly pending: PendingStore;
  private readonly lastKnown = new Map<ParamKey, ParamValue>();
  private readonly verifications: Array<VerificationReport & { time: string }> = [];
  private actionTimes: number[] = [];

  constructor(
    readonly mixer: MixerAdapter,
    private safety: SafetyConfig,
    readonly names: ChannelMap,
    private log: ActionLog,
    private clock: () => number = Date.now,
    pending?: PendingStore,
  ) {
    this.pending = pending ?? new PendingStore(60_000, clock);
    mixer.onParamChange((key, value, origin) => this.observe(key, value, origin === 'external' ? 'external' : 'resync'));
    mixer.onVerification((reports) => this.onVerification(reports));
  }

  // ---------- leitura ----------

  async status(): Promise<Result> {
    const caps = this.mixer.capabilities();
    const link = this.mixer.link();
    const data: Record<string, unknown> = {
      connected: link === 'READY' || link === 'DEGRADED_READ_ONLY',
      link,
      mode: this.mixer.mode === 'mock' ? 'simulada' : 'real',
      model: caps.model,
      inputs: caps.inputs,
      aux: caps.aux,
      undoAvailable: this.undoStack.size(),
    };
    if (this.verifications.length) data.verificationsAfterReconnect = this.verifications.slice(-10);
    if (link === 'READY' || link === 'DEGRADED_READ_ONLY') {
      const snap = await this.mixer.currentSnapshot().catch(() => ({}));
      Object.assign(data, snap);
    }
    const ok = link === 'READY' || link === 'DEGRADED_READ_ONLY';
    return { ok, code: ok ? (link === 'READY' ? 'OK' : 'DEGRADED_READ_ONLY') : this.codeFor(link), message: this.mixer.statusText(), data };
  }

  /** Tenta (re)conectar se estiver desconectado. Nunca reenvia comandos antigos. */
  async ensureConnected(): Promise<Result> {
    const link = this.mixer.link();
    if (link === 'READY' || link === 'DEGRADED_READ_ONLY') return this.status();
    try {
      await this.mixer.connect();
      this.log.add({ action: 'connect', ok: true, message: this.mixer.statusText() });
      return this.status();
    } catch (err) {
      const message = `Não consegui conectar: ${(err as Error).message}`;
      this.log.add({ action: 'connect', ok: false, message });
      return { ok: false, code: this.codeFor(this.mixer.link()), message };
    }
  }

  listNames(): Result {
    return {
      ok: true,
      code: 'OK',
      message: 'Nomes de canais e retornos cadastrados',
      data: { channels: this.names.inputs.list(), aux: this.names.aux.list() },
    };
  }

  async mixState(auxQuery?: string | number): Promise<Result> {
    const gate = this.readGate();
    if (gate) return gate;
    let bus: Bus = MASTER;
    let busName = 'Master';
    if (auxQuery !== undefined && auxQuery !== '') {
      const r = this.resolve(() => this.names.auxBus(auxQuery));
      if ('error' in r) return r.error;
      bus = auxBus(r.value.number);
      busName = `${r.value.name} (AUX ${r.value.number})`;
    }
    const caps = this.mixer.capabilities();
    const channels = [];
    let unknown = 0;
    for (let ch = 1; ch <= caps.inputs; ch++) {
      const lvl = this.mixer.read(paramKey.level(ch, bus));
      const mute = this.mixer.read(paramKey.mute(ch, bus));
      const known = lvl.known && mute.known;
      if (!known) unknown++;
      channels.push({
        channel: ch,
        name: this.names.inputs.nameOf(ch),
        mixerName: this.mixer.channelName(ch),
        known,
        levelDB: lvl.known ? roundHalf(lvl.value as number) : null,
        level: lvl.known ? formatDB(lvl.value as number) : 'desconhecido',
        muted: mute.known ? (mute.value as boolean) : null,
      });
    }
    const data: Record<string, unknown> = { bus: busName, link: this.mixer.link(), channels };
    if (bus.kind === 'master') {
      const m = this.mixer.read(paramKey.master());
      data.masterDB = m.known ? roundHalf(m.value as number) : null;
      data.master = m.known ? formatDB(m.value as number) : 'desconhecido';
    }
    const partial = this.mixer.link() === 'DEGRADED_READ_ONLY';
    const note = partial ? ` (leitura parcial: ${unknown} canal(is) ainda desconhecido(s); escrita bloqueada)` : '';
    return { ok: true, code: partial ? 'DEGRADED_READ_ONLY' : 'OK', message: `Estado da mix: ${busName}${note}`, data };
  }

  history(limit = 20): Result {
    return { ok: true, code: 'OK', message: `Últimas ${limit} ações`, data: { entries: this.log.recent(limit) } };
  }

  // ---------- escrita (sempre pela fila) ----------

  async setLevel(req: LevelRequest): Promise<Result> {
    const ch = this.resolve(() => this.names.channel(req.channel));
    if ('error' in ch) return ch.error;
    let bus: Bus = MASTER;
    let where = 'no master';
    let ceiling = this.safety.maxChannelLevelDB;
    if (req.aux !== undefined && req.aux !== '') {
      const a = this.resolve(() => this.names.auxBus(req.aux!));
      if ('error' in a) return a.error;
      bus = auxBus(a.value.number);
      where = `no ${a.value.name}`;
      ceiling = this.safety.maxAuxSendDB;
    }
    const key = paramKey.level(ch.value.number, bus);
    const label = `${ch.value.name} ${where}`;

    return this.queue.run(async () => {
      const gate = this.writeGate();
      if (gate) return gate;
      const cur = this.mixer.read(key);
      if (!cur.known) return this.unknownState(label);
      const current = cur.value as number;
      const plan = this.plan(current, req.db, req.deltaDB, ceiling);
      if ('error' in plan) return this.refuse('set_level', 'INVALID', plan.error, { label });
      if (plan.target === roundHalf(current)) {
        return { ok: true, code: 'OK', message: `${label} já está em ${formatDB(current)}. Nada mudou.` };
      }
      const needs = plan.step > this.safety.maxStepDB;
      const command = { op: 'level', key, db: req.db, deltaDB: req.deltaDB };
      const summary = `Mudar ${label} de ${formatDB(current)} para ${formatDB(plan.target)} é uma mudança de ${Math.round(plan.step)} dB, acima do limite de ${this.safety.maxStepDB} dB por comando.`;
      const blocked = this.authorize(needs, req.confirmationId, command, [key], summary);
      if (blocked) return blocked;

      const applied = await this.applyChanges([{ key, label, from: current, to: plan.target }]);
      const note = plan.clamped ? ` (limitei ao teto de ${formatDB(ceiling)})` : '';
      return this.finish('set_level', `${label}: ${formatDB(current)} → ${formatDB(plan.target)}${note}`, applied, {
        channel: ch.value.number,
        bus: bus.kind === 'aux' ? `aux${bus.aux}` : 'master',
        fromDB: current,
        toDB: plan.target,
        clamped: plan.clamped,
      });
    });
  }

  async setMute(req: MuteRequest): Promise<Result> {
    if (!req.channels.length) return { ok: false, code: 'INVALID', message: 'Informe pelo menos um canal.' };
    const resolved: Resolved[] = [];
    for (const q of req.channels) {
      const r = this.resolve(() => this.names.channel(q));
      if ('error' in r) return r.error;
      if (!resolved.some((x) => x.number === r.value.number)) resolved.push(r.value);
    }
    let bus: Bus = MASTER;
    let where = 'no master';
    if (req.aux !== undefined && req.aux !== '') {
      const a = this.resolve(() => this.names.auxBus(req.aux!));
      if ('error' in a) return a.error;
      bus = auxBus(a.value.number);
      where = `no ${a.value.name}`;
    }

    return this.queue.run(async () => {
      const gate = this.writeGate();
      if (gate) return gate;
      const names = resolved.map((r) => r.name).join(', ');
      const changes: Change[] = [];
      for (const r of resolved) {
        const key = paramKey.mute(r.number, bus);
        const cur = this.mixer.read(key);
        if (!cur.known) return this.unknownState(`${r.name} ${where}`);
        if (cur.value !== req.muted) changes.push({ key, label: r.name, from: cur.value, to: req.muted });
      }
      if (!changes.length) {
        return {
          ok: true,
          code: 'OK',
          message: `${names} já ${req.muted ? 'estava(m) mutado(s)' : 'estava(m) aberto(s)'} ${where}. Nada mudou.`,
        };
      }
      const needs = req.muted && resolved.length > this.safety.bulkMuteConfirmAbove;
      const command = { op: 'mute', bus: bus.kind === 'aux' ? bus.aux : 0, channels: resolved.map((r) => r.number).sort((a, b) => a - b), muted: req.muted };
      const summary = `${req.muted ? 'Mutar' : 'Desmutar'} ${resolved.length} canais de uma vez (${names}) ${where}.`;
      const blocked = this.authorize(needs, req.confirmationId, command, changes.map((c) => c.key), summary);
      if (blocked) return blocked;

      const applied = await this.applyChanges(changes);
      const description = `${req.muted ? 'Mutado' : 'Desmutado'} ${where}: ${applied.done.map((d) => d.label).join(', ')}`;
      return this.finish('mute', description, applied, {
        channels: applied.done.map((d) => Number(d.key.split('.')[1])),
        muted: req.muted,
      });
    });
  }

  async setMaster(req: { db?: number; deltaDB?: number; confirm?: boolean; confirmationId?: string }): Promise<Result> {
    const key = paramKey.master();
    return this.queue.run(async () => {
      const gate = this.writeGate();
      if (gate) return gate;
      const cur = this.mixer.read(key);
      if (!cur.known) return this.unknownState('o master');
      const current = cur.value as number;
      const plan = this.plan(current, req.db, req.deltaDB, this.safety.maxMasterLevelDB);
      if ('error' in plan) return this.refuse('master', 'INVALID', plan.error, {});
      if (plan.target === roundHalf(current)) {
        return { ok: true, code: 'OK', message: `O master já está em ${formatDB(current)}. Nada mudou.` };
      }
      const needs = this.safety.masterRequiresConfirmation || plan.step > this.safety.maxStepDB;
      const summary = `Mudar o MASTER (som geral) de ${formatDB(current)} para ${formatDB(plan.target)}.`;
      const blocked = this.authorize(needs, req.confirmationId, { op: 'master', db: req.db, deltaDB: req.deltaDB }, [key], summary);
      if (blocked) return blocked;

      const applied = await this.applyChanges([{ key, label: 'Master', from: current, to: plan.target }]);
      const note = plan.clamped ? ` (limitei ao teto de ${formatDB(this.safety.maxMasterLevelDB)})` : '';
      return this.finish('master', `Master: ${formatDB(current)} → ${formatDB(plan.target)}${note}`, applied, {
        fromDB: current,
        toDB: plan.target,
      });
    });
  }

  async undo(steps = 1): Promise<Result> {
    return this.queue.run(async () => {
      const gate = this.writeGate();
      if (gate) return gate;
      if (!this.undoStack.size()) return { ok: true, code: 'OK', message: 'Não há nada para desfazer.' };
      const limited = this.rateLimit();
      if (limited) return limited;

      const n = Math.max(1, Math.min(steps, this.undoStack.size()));
      const undone: string[] = [];
      const skipped: string[] = [];
      const notSentAll: string[] = [];
      const uncertainAll: string[] = [];
      for (let i = 0; i < n; i++) {
        const entry = this.undoStack.pop()!;
        const ready: UndoItem[] = [];
        for (const item of entry.items) {
          if (this.tracker.revisionOf(item.key) !== item.revisionAtWrite) {
            const current = this.tracker.actorOf(item.key);
            const actor = item.blockedBy ?? (current && current !== 'mixai' ? current : 'external');
            skipped.push(`${item.label}: alterado depois ${ACTOR_TEXT[actor]}; não desfiz para não apagar essa mudança`);
          } else if (typeof item.before === 'number' && item.before > this.ceilingFor(item.key)) {
            skipped.push(`${item.label}: o valor anterior (${formatDB(item.before)}) está acima do teto atual`);
          } else {
            ready.push(item);
          }
        }
        const { done, notSent, uncertain } = await this.applyChanges(
          ready.map((it) => ({ key: it.key, label: it.label, from: it.after, to: it.before })),
        );
        uncertainAll.push(...uncertain.map((c) => `${c.label} (${c.error})`));
        for (const d of done) {
          const item = ready.find((it) => it.key === d.key)!;
          this.undoStack.relink(item, d.revisionAtWrite);
        }
        if (done.length) {
          undone.push(
            done.length === entry.items.length
              ? entry.description
              : `${entry.description} — só: ${done.map((d) => `${d.label} → ${fmt(d.to)}`).join(', ')}`,
          );
        }
        if (notSent.length || uncertain.length) {
          // Interrompido no meio: o que não foi enviado volta para a pilha, como estava.
          // O item de resultado incerto NÃO volta (perdeu o desfazer por segurança).
          const remaining = ready.filter((it) => notSent.some((c) => c.key === it.key));
          this.undoStack.push({ description: entry.description, items: remaining });
          notSentAll.push(...notSent.map((c) => c.label));
          break;
        }
      }

      const parts = [];
      if (undone.length) parts.push(`Desfeito: ${undone.join(' | ')}`);
      if (skipped.length) parts.push(`Não desfeito (conflito): ${skipped.join(' | ')}`);
      if (uncertainAll.length) parts.push(`RESULTADO INCERTO ao desfazer (erro inesperado; confira na mesa): ${uncertainAll.join(', ')}`);
      if (notSentAll.length) parts.push(`Não enviado (fica para desfazer depois): ${notSentAll.join(', ')}`);
      const code: ResultCode =
        notSentAll.length || uncertainAll.length ? 'PARTIAL' : skipped.length ? (undone.length ? 'PARTIAL' : 'CONFLICT') : 'OK';
      const ok = code === 'OK';
      const message = parts.join('. ');
      this.log.add({ action: 'undo', ok, message, details: { undone, skipped, notSent: notSentAll, uncertain: uncertainAll } });
      return { ok, code, message, data: { undone, skipped, notSent: notSentAll, uncertain: uncertainAll } };
    });
  }

  async listSnapshots(): Promise<Result> {
    const gate = this.readGate();
    if (gate) return gate;
    const [shows, current] = await Promise.all([this.mixer.listShows(), this.mixer.currentSnapshot()]);
    return { ok: true, code: 'OK', message: 'Shows e snapshots salvos na mesa', data: { shows, current } };
  }

  async loadSnapshot(req: { show: string; snapshot: string; confirm?: boolean; confirmationId?: string }): Promise<Result> {
    return this.queue.run(async () => {
      const gate = this.writeGate();
      if (gate) return gate;
      const shows = await this.mixer.listShows();
      const showName = Object.keys(shows).find((s) => s.toLowerCase() === req.show.trim().toLowerCase());
      const snapName = showName
        ? shows[showName]!.find((s) => s.toLowerCase() === req.snapshot.trim().toLowerCase())
        : undefined;
      if (!showName || !snapName) {
        return this.refuse('snapshot', 'NOT_FOUND', `Não encontrei o snapshot "${req.snapshot}" no show "${req.show}".`, { shows });
      }
      const summary = `Carregar o snapshot "${snapName}" do show "${showName}" troca a mix inteira e não dá para desfazer pelo MixAI.`;
      // A confirmação fica presa à revisão global do estado e ao snapshot carregado agora:
      // qualquer mudança na mesa (ou troca de snapshot) até a confirmação a invalida.
      const current = await this.mixer.currentSnapshot().catch(() => ({}));
      const guard = JSON.stringify({ revision: this.tracker.current(), current });
      const blocked = this.authorize(true, req.confirmationId, { op: 'snapshot', show: showName, snapshot: snapName }, [], summary, guard);
      if (blocked) return blocked;
      let outcome: WriteOutcome;
      try {
        outcome = await this.mixer.loadSnapshot(showName, snapName);
      } catch (err) {
        if (err instanceof LinkUnavailableError) return this.writeGate() ?? this.refuse('snapshot', 'NO_CONNECTION', 'Sem conexão com a mesa.', {});
        // Erro inesperado: a mesa pode ter carregado ou não. Nada do que havia antes é desfazível.
        this.tracker.bumpAll(this.allKeys(), 'uncertain');
        this.lastKnown.clear();
        this.undoStack.clear();
        const error = err instanceof Error ? err.message : String(err);
        const message = `RESULTADO INCERTO ao carregar o snapshot "${snapName}" (${error}): confira na mesa. A pilha de desfazer foi zerada.`;
        this.log.add({ action: 'snapshot', ok: false, message, details: { show: showName, snapshot: snapName, outcome: 'indeterminate', error } });
        return { ok: false, code: 'PARTIAL', message, data: { show: showName, snapshot: snapName, outcome: 'indeterminate' } };
      }
      this.tracker.bumpAll(this.allKeys(), 'snapshot');
      this.lastKnown.clear();
      this.undoStack.clear();
      const sent = outcome === 'sent' ? ' (enviado à mesa)' : '';
      const message = `Snapshot carregado: ${showName} / ${snapName}${sent}. A pilha de desfazer foi zerada.`;
      this.log.add({ action: 'snapshot', ok: true, message, details: { show: showName, snapshot: snapName, outcome } });
      return { ok: true, code: 'OK', message, data: { show: showName, snapshot: snapName, outcome } };
    });
  }

  // ---------- execução ----------

  /**
   * Escreve as mudanças em ordem.
   * - Recusa de conexão (LinkUnavailableError): nada daquela escrita saiu; ela e as seguintes ficam "não enviado".
   * - Qualquer outro erro: a escrita em andamento fica com resultado INCERTO (pode ter saído ou não),
   *   o parâmetro perde o desfazer, e as seguintes ficam "não enviado". Nunca vira sucesso completo.
   */
  private async applyChanges(changes: Change[]): Promise<ApplyResult> {
    const done: DoneChange[] = [];
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i]!;
      let outcome: WriteOutcome;
      try {
        outcome = await this.mixer.write(c.key, c.to);
      } catch (err) {
        if (err instanceof LinkUnavailableError) return { done, uncertain: [], notSent: changes.slice(i) };
        this.tracker.bump(c.key, 'uncertain');
        this.lastKnown.delete(c.key);
        const error = err instanceof Error ? err.message : String(err);
        return { done, uncertain: [{ ...c, error }], notSent: changes.slice(i + 1) };
      }
      const revisionBefore = this.tracker.revisionOf(c.key);
      const actorBefore = this.tracker.actorOf(c.key);
      const revisionAtWrite = this.tracker.bump(c.key, 'mixai');
      this.lastKnown.set(c.key, c.to);
      done.push({ ...c, outcome, revisionBefore, revisionAtWrite, actorBefore });
    }
    return { done, uncertain: [], notSent: [] };
  }

  /** Monta o resultado, o desfazer (só do que foi enviado) e o log, com a etapa de cada parâmetro. */
  private finish(action: string, description: string, applied: ApplyResult, data: Record<string, unknown>): Result {
    const { done, uncertain, notSent } = applied;
    const complete = !uncertain.length && !notSent.length;
    if (done.length) {
      this.undoStack.push({
        description: complete ? description : `${description} (parcial)`,
        items: done.map((d) => ({
          key: d.key,
          label: d.label,
          before: d.from,
          after: d.to,
          revisionAtWrite: d.revisionAtWrite,
          revisionBefore: d.revisionBefore,
          actorBefore: d.actorBefore,
        })),
      });
    }
    const changes = [
      ...done.map((d) => ({ key: d.key, from: d.from, to: d.to, outcome: d.outcome as string })),
      ...uncertain.map((c) => ({ key: c.key, from: c.from, to: c.to, outcome: 'indeterminate', error: c.error })),
      ...notSent.map((c) => ({ key: c.key, from: c.from, to: c.to, outcome: 'not_sent' })),
    ];
    const sent = done.some((d) => d.outcome === 'sent') ? ' (enviado à mesa; a Ui16 não confirma o recebimento)' : '';
    if (complete) {
      const message = `${description}${sent}`;
      this.log.add({ action, ok: true, message, details: { ...data, changes } });
      return { ok: true, code: 'OK', message, data: { ...data, changes } };
    }
    const link = this.mixer.link();
    const nothing = uncertain.length ? 'nada foi concluído' : 'nada foi enviado';
    const parts = [`Operação PARCIAL: ${done.length ? `${description}${sent}` : nothing}.`];
    if (uncertain.length) {
      parts.push(
        `RESULTADO INCERTO (erro inesperado; pode ou não ter chegado à mesa, confira): ${uncertain
          .map((c) => `${c.label} (${c.error})`)
          .join(', ')}.`,
      );
    }
    if (notSent.length) parts.push(`NÃO enviado: ${notSent.map((c) => c.label).join(', ')}.`);
    parts.push(this.mixer.statusText());
    const message = parts.join(' ');
    this.log.add({ action, ok: false, message, details: { ...data, changes, link } });
    return { ok: false, code: 'PARTIAL', message, data: { ...data, changes, link } };
  }

  /**
   * Autorização vinculada à operação e ao estado. Devolve um Result para interromper, ou
   * undefined para seguir. `confirm: true` sozinho não autoriza nada.
   */
  private authorize(
    needs: boolean,
    confirmationId: string | undefined,
    command: Record<string, unknown>,
    keys: ParamKey[],
    summary: string,
    guard?: string,
  ): Result | undefined {
    if (!needs) return this.rateLimit();
    const hash = commandHash(command);
    if (!confirmationId) {
      const { id, expiresInSec } = this.pending.create(
        hash,
        keys.map((k) => [k, this.tracker.revisionOf(k)]),
        summary,
        guard,
      );
      return {
        ok: false,
        code: 'NEEDS_CONFIRMATION',
        needsConfirmation: true,
        pendingId: id,
        message: `${summary} Nada foi alterado. Mostre isto ao usuário e, só depois do "sim" dele, repita o mesmo comando com confirmation_id="${id}" (vale ${expiresInSec} s, uma vez).`,
        data: { pendingId: id, expiresInSec, summary },
      };
    }
    const limited = this.rateLimit();
    if (limited) return limited;
    const check = this.pending.consume(confirmationId, hash, (k) => this.tracker.revisionOf(k), guard);
    if (!check.ok) return this.refuse('confirmation', check.code, check.message, { confirmationId });
    return undefined;
  }

  // ---------- regras internas ----------

  private observe(key: ParamKey, value: ParamValue, actor: Actor) {
    if (!sameValue(this.lastKnown.get(key), value)) this.tracker.bump(key, actor);
    this.lastKnown.set(key, value);
  }

  private onVerification(reports: VerificationReport[]) {
    const time = new Date(this.clock()).toISOString();
    for (const r of reports) {
      // Política conservadora: qualquer escrita que caiu na janela de uma queda tem resultado
      // incerto, inclusive "observed_target" (ver o valor desejado não prova que foi o MixAI).
      // A revisão nova invalida o desfazer daquele parâmetro.
      this.tracker.bump(r.key, 'uncertain');
      this.verifications.push({ ...r, time });
      if (this.verifications.length > 50) this.verifications.shift();
      const text: Record<string, string> = {
        observed_target: 'a mesa mostra o valor desejado (isso não prova que foi o MixAI)',
        observed_different: 'a mesa mostra OUTRO valor; o comando provavelmente não chegou',
        indeterminate: 'não foi possível saber se o comando chegou',
      };
      this.log.add({
        action: 'verification',
        ok: r.outcome === 'observed_target',
        message: `Após reconexão, ${r.key}: ${text[r.outcome]}`,
        details: { ...r },
      });
    }
  }

  private plan(
    current: number,
    db: number | undefined,
    deltaDB: number | undefined,
    ceiling: number,
  ): { target: number; step: number; clamped: boolean } | { error: string } {
    const hasAbs = typeof db === 'number' && !Number.isNaN(db);
    const hasRel = typeof deltaDB === 'number' && !Number.isNaN(deltaDB);
    if (hasAbs === hasRel) return { error: 'Informe o valor em dB (db) OU a mudança relativa (delta_db), não os dois.' };

    const floor = this.safety.relativeFloorDB;
    const base = Number.isFinite(current) ? current : floor;
    let target = hasAbs ? db! : base + deltaDB!;
    if (target <= SILENCE_DB || (hasRel && target < floor)) target = -Infinity;
    let clamped = false;
    if (target > ceiling) {
      target = ceiling;
      clamped = true;
    }
    target = roundHalf(target);
    const asNumber = (x: number) => (Number.isFinite(x) ? x : floor);
    const step = Math.abs(asNumber(target) - asNumber(current));
    return { target, step, clamped };
  }

  private ceilingFor(key: ParamKey): number {
    if (key === 'master.level') return this.safety.maxMasterLevelDB;
    return key.includes('.aux.') ? this.safety.maxAuxSendDB : this.safety.maxChannelLevelDB;
  }

  private allKeys(): ParamKey[] {
    const caps = this.mixer.capabilities();
    const keys: ParamKey[] = [paramKey.master()];
    for (let ch = 1; ch <= caps.inputs; ch++) {
      keys.push(paramKey.level(ch, MASTER), paramKey.mute(ch, MASTER));
      for (let a = 1; a <= caps.aux; a++) keys.push(paramKey.level(ch, auxBus(a)), paramKey.mute(ch, auxBus(a)));
    }
    return keys;
  }

  private resolve<T>(fn: () => T): { value: T } | { error: Result } {
    try {
      return { value: fn() };
    } catch (err) {
      if (err instanceof NameResolutionError) return { error: { ok: false, code: err.code, message: err.message } };
      throw err;
    }
  }

  private codeFor(link: LinkState): ResultCode {
    switch (link) {
      case 'READY':
        return 'OK';
      case 'DEGRADED_READ_ONLY':
        return 'DEGRADED_READ_ONLY';
      case 'CONNECTING':
      case 'SYNCING':
        return 'RESYNCING';
      case 'STOPPED':
        return 'CONTROL_STOPPED';
      default:
        return 'NO_CONNECTION';
    }
  }

  private gateMessage(link: LinkState): string {
    switch (link) {
      case 'DEGRADED_READ_ONLY':
        return `A mesa ainda não mandou o estado completo: somente leitura, escrita bloqueada. ${this.mixer.statusText()}`;
      case 'CONNECTING':
      case 'SYNCING':
        return `Sincronizando com a mesa; nenhum comando é aceito até terminar. ${this.mixer.statusText()}`;
      case 'STOPPED':
        return `Controle automático interrompido: use a interface oficial da Soundcraft. ${this.mixer.statusText()}`;
      default:
        return `Sem conexão com a mesa. ${this.mixer.statusText()}`;
    }
  }

  private writeGate(): Result | undefined {
    const link = this.mixer.link();
    if (link === 'READY') return undefined;
    return { ok: false, code: this.codeFor(link), message: this.gateMessage(link) };
  }

  private readGate(): Result | undefined {
    const link = this.mixer.link();
    if (link === 'READY' || link === 'DEGRADED_READ_ONLY') return undefined;
    return { ok: false, code: this.codeFor(link), message: this.gateMessage(link) };
  }

  private unknownState(what: string): Result {
    return {
      ok: false,
      code: 'DEGRADED_READ_ONLY',
      message: `Ainda não sei o valor atual de ${what} na mesa; não alterei nada.`,
    };
  }

  private rateLimit(): Result | undefined {
    const now = this.clock();
    this.actionTimes = this.actionTimes.filter((t) => now - t < 1000);
    if (this.actionTimes.length >= this.safety.maxActionsPerSecond) {
      return this.refuse('rate_limit', 'RATE_LIMIT', 'Muitos comandos seguidos. Espere um segundo e tente de novo.', {});
    }
    this.actionTimes.push(now);
    return undefined;
  }

  private refuse(action: string, code: ResultCode, message: string, details: Record<string, unknown>): Result {
    this.log.add({ action, ok: false, message, details: { ...details, code } });
    return { ok: false, code, message };
  }
}
