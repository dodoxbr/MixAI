import type { SafetyConfig } from './config.js';
import { ChannelMap, NameResolutionError, type Resolved } from './channels.js';
import type { ActionLog } from './log.js';
import { auxBus, MASTER, type Bus, type MixerAdapter } from '../mixer/types.js';

export interface Result {
  ok: boolean;
  /** true = nada foi feito; a ação precisa da confirmação do usuário (repita com confirm=true). */
  needsConfirmation?: boolean;
  message: string;
  data?: Record<string, unknown>;
}

interface UndoEntry {
  description: string;
  revert: () => Promise<void>;
}

export interface LevelRequest {
  channel: string | number;
  aux?: string | number;
  /** Valor absoluto em dB (≤ -80 = fader todo para baixo). */
  db?: number;
  /** Mudança relativa em dB (+3 sobe, -3 desce). */
  deltaDB?: number;
  confirm?: boolean;
}

export interface MuteRequest {
  channels: Array<string | number>;
  muted: boolean;
  aux?: string | number;
  confirm?: boolean;
}

/** Abaixo disso, consideramos o fader todo para baixo. */
const SILENCE_DB = -80;

export function formatDB(db: number): string {
  if (!Number.isFinite(db)) return db < 0 ? '-∞ dB' : '+∞ dB';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : ''}${r} dB`;
}

const roundHalf = (db: number) => (Number.isFinite(db) ? Math.round(db * 2) / 2 : db);

/**
 * Cérebro do MixAI: traduz nomes, aplica as travas de segurança,
 * registra no log e guarda a pilha de desfazer. A IA só chega na mesa por aqui.
 */
export class MixController {
  private undoStack: UndoEntry[] = [];
  private actionTimes: number[] = [];

  constructor(
    readonly mixer: MixerAdapter,
    private safety: SafetyConfig,
    readonly names: ChannelMap,
    private log: ActionLog,
    private clock: () => number = Date.now,
  ) {}

  // ---------- leitura ----------

  async status(): Promise<Result> {
    const caps = this.mixer.capabilities();
    const data: Record<string, unknown> = {
      connected: this.mixer.isConnected(),
      mode: this.mixer.mode === 'mock' ? 'simulada' : 'real',
      model: caps.model,
      inputs: caps.inputs,
      aux: caps.aux,
      undoAvailable: this.undoStack.length,
    };
    if (this.mixer.isConnected()) {
      const snap = await this.mixer.currentSnapshot().catch(() => ({}));
      Object.assign(data, snap);
    }
    return { ok: true, message: this.mixer.statusText(), data };
  }

  /** Tenta (re)conectar se estiver desconectado. */
  async ensureConnected(): Promise<Result> {
    if (this.mixer.isConnected()) return this.status();
    try {
      await this.mixer.connect();
      this.log.add({ action: 'connect', ok: true, message: this.mixer.statusText() });
      return this.status();
    } catch (err) {
      const message = `Não consegui conectar: ${(err as Error).message}`;
      this.log.add({ action: 'connect', ok: false, message });
      return { ok: false, message };
    }
  }

  listNames(): Result {
    return {
      ok: true,
      message: 'Nomes de canais e retornos cadastrados',
      data: { channels: this.names.inputs.list(), aux: this.names.aux.list() },
    };
  }

  async mixState(auxQuery?: string | number): Promise<Result> {
    const off = this.requireConnection();
    if (off) return off;
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
    for (let ch = 1; ch <= caps.inputs; ch++) {
      const [levelDB, muted, mixerName] = await Promise.all([
        this.mixer.getLevelDB(ch, bus),
        this.mixer.getMute(ch, bus),
        this.mixer.getChannelName(ch),
      ]);
      channels.push({
        channel: ch,
        name: this.names.inputs.nameOf(ch),
        mixerName,
        levelDB: roundHalf(levelDB),
        level: formatDB(levelDB),
        muted,
      });
    }
    const data: Record<string, unknown> = { bus: busName, channels };
    if (bus.kind === 'master') {
      const m = await this.mixer.getMasterDB();
      data.masterDB = roundHalf(m);
      data.master = formatDB(m);
    }
    return { ok: true, message: `Estado da mix: ${busName}`, data };
  }

  history(limit = 20): Result {
    return { ok: true, message: `Últimas ${limit} ações`, data: { entries: this.log.recent(limit) } };
  }

  // ---------- escrita ----------

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
    const off = this.requireConnection();
    if (off) return off;

    const label = `${ch.value.name} ${where}`;
    const current = await this.mixer.getLevelDB(ch.value.number, bus);
    const plan = this.plan(current, req.db, req.deltaDB, ceiling);
    if ('error' in plan) return this.refuse('set_level', plan.error, { label });
    if (plan.target === roundHalf(current)) {
      return { ok: true, message: `${label} já está em ${formatDB(current)}. Nada mudou.` };
    }
    if (plan.step > this.safety.maxStepDB && !req.confirm) {
      return this.askConfirmation(
        `Mudar ${label} de ${formatDB(current)} para ${formatDB(plan.target)} é uma mudança de ${Math.round(plan.step)} dB, acima do limite de ${this.safety.maxStepDB} dB por comando.`,
      );
    }
    const limited = this.rateLimit();
    if (limited) return limited;

    await this.mixer.setLevelDB(ch.value.number, bus, plan.target);
    const description = `${label}: ${formatDB(current)} → ${formatDB(plan.target)}`;
    this.pushUndo(description, () => this.mixer.setLevelDB(ch.value.number, bus, current));
    const note = plan.clamped ? ` (limitei ao teto de ${formatDB(ceiling)})` : '';
    return this.done('set_level', `${description}${note}`, {
      channel: ch.value.number,
      bus: bus.kind === 'aux' ? `aux${bus.aux}` : 'master',
      fromDB: current,
      toDB: plan.target,
      clamped: plan.clamped,
    });
  }

  async setMute(req: MuteRequest): Promise<Result> {
    if (!req.channels.length) return { ok: false, message: 'Informe pelo menos um canal.' };
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
    const off = this.requireConnection();
    if (off) return off;

    const names = resolved.map((r) => r.name).join(', ');
    const verb = req.muted ? 'Mutar' : 'Desmutar';
    if (req.muted && resolved.length > this.safety.bulkMuteConfirmAbove && !req.confirm) {
      return this.askConfirmation(`${verb} ${resolved.length} canais de uma vez (${names}) ${where}.`);
    }

    const before = await Promise.all(resolved.map((r) => this.mixer.getMute(r.number, bus)));
    const toChange = resolved.filter((_, i) => before[i] !== req.muted);
    if (!toChange.length) {
      return { ok: true, message: `${names} já ${req.muted ? 'estava(m) mutado(s)' : 'estava(m) aberto(s)'} ${where}. Nada mudou.` };
    }
    const limited = this.rateLimit();
    if (limited) return limited;

    for (const r of toChange) await this.mixer.setMute(r.number, bus, req.muted);
    const changedNames = toChange.map((r) => r.name).join(', ');
    const description = `${req.muted ? 'Mutado' : 'Desmutado'} ${where}: ${changedNames}`;
    this.pushUndo(description, async () => {
      for (const r of toChange) await this.mixer.setMute(r.number, bus, !req.muted);
    });
    return this.done('mute', description, { channels: toChange.map((r) => r.number), muted: req.muted });
  }

  async setMaster(req: { db?: number; deltaDB?: number; confirm?: boolean }): Promise<Result> {
    const off = this.requireConnection();
    if (off) return off;
    const current = await this.mixer.getMasterDB();
    const plan = this.plan(current, req.db, req.deltaDB, this.safety.maxMasterLevelDB);
    if ('error' in plan) return this.refuse('master', plan.error, {});
    if (plan.target === roundHalf(current)) {
      return { ok: true, message: `O master já está em ${formatDB(current)}. Nada mudou.` };
    }
    const needs = this.safety.masterRequiresConfirmation || plan.step > this.safety.maxStepDB;
    if (needs && !req.confirm) {
      return this.askConfirmation(
        `Mudar o MASTER (som geral) de ${formatDB(current)} para ${formatDB(plan.target)}.`,
      );
    }
    const limited = this.rateLimit();
    if (limited) return limited;

    await this.mixer.setMasterDB(plan.target);
    const description = `Master: ${formatDB(current)} → ${formatDB(plan.target)}`;
    this.pushUndo(description, () => this.mixer.setMasterDB(current));
    const note = plan.clamped ? ` (limitei ao teto de ${formatDB(this.safety.maxMasterLevelDB)})` : '';
    return this.done('master', description + note, { fromDB: current, toDB: plan.target });
  }

  async undo(steps = 1): Promise<Result> {
    const off = this.requireConnection();
    if (off) return off;
    if (!this.undoStack.length) return { ok: true, message: 'Não há nada para desfazer.' };
    const n = Math.max(1, Math.min(steps, this.undoStack.length));
    const undone: string[] = [];
    for (let i = 0; i < n; i++) {
      const entry = this.undoStack.pop()!;
      await entry.revert();
      undone.push(entry.description);
    }
    return this.done('undo', `Desfeito: ${undone.join(' | ')}`, { undone });
  }

  async listSnapshots(): Promise<Result> {
    const off = this.requireConnection();
    if (off) return off;
    const [shows, current] = await Promise.all([this.mixer.listShows(), this.mixer.currentSnapshot()]);
    return { ok: true, message: 'Shows e snapshots salvos na mesa', data: { shows, current } };
  }

  async loadSnapshot(req: { show: string; snapshot: string; confirm?: boolean }): Promise<Result> {
    const off = this.requireConnection();
    if (off) return off;
    const shows = await this.mixer.listShows();
    const showName = Object.keys(shows).find((s) => s.toLowerCase() === req.show.trim().toLowerCase());
    const snapName = showName
      ? shows[showName]!.find((s) => s.toLowerCase() === req.snapshot.trim().toLowerCase())
      : undefined;
    if (!showName || !snapName) {
      return this.refuse('snapshot', `Não encontrei o snapshot "${req.snapshot}" no show "${req.show}".`, { shows });
    }
    if (!req.confirm) {
      return this.askConfirmation(
        `Carregar o snapshot "${snapName}" do show "${showName}" troca a mix inteira e não dá para desfazer pelo MixAI.`,
      );
    }
    const limited = this.rateLimit();
    if (limited) return limited;
    await this.mixer.loadSnapshot(showName, snapName);
    this.undoStack = [];
    return this.done('snapshot', `Snapshot carregado: ${showName} / ${snapName}. A pilha de desfazer foi zerada.`, {
      show: showName,
      snapshot: snapName,
    });
  }

  // ---------- regras internas ----------

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

  private resolve<T>(fn: () => T): { value: T } | { error: Result } {
    try {
      return { value: fn() };
    } catch (err) {
      if (err instanceof NameResolutionError) return { error: { ok: false, message: err.message } };
      throw err;
    }
  }

  private requireConnection(): Result | undefined {
    if (this.mixer.isConnected()) return undefined;
    return { ok: false, message: `Sem conexão com a mesa. ${this.mixer.statusText()}` };
  }

  private rateLimit(): Result | undefined {
    const now = this.clock();
    this.actionTimes = this.actionTimes.filter((t) => now - t < 1000);
    if (this.actionTimes.length >= this.safety.maxActionsPerSecond) {
      return this.refuse('rate_limit', 'Muitos comandos seguidos. Espere um segundo e tente de novo.', {});
    }
    this.actionTimes.push(now);
    return undefined;
  }

  private pushUndo(description: string, revert: () => Promise<void>) {
    this.undoStack.push({ description, revert });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  private askConfirmation(what: string): Result {
    return {
      ok: false,
      needsConfirmation: true,
      message: `${what} Nada foi alterado. Confirme com o usuário e repita o comando com confirm=true.`,
    };
  }

  private refuse(action: string, message: string, details: Record<string, unknown>): Result {
    this.log.add({ action, ok: false, message, details });
    return { ok: false, message };
  }

  private done(action: string, message: string, details: Record<string, unknown>): Result {
    this.log.add({ action, ok: true, message, details });
    return { ok: true, message, data: details };
  }
}
