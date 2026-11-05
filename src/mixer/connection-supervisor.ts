import { ConnectionStatus, type SoundcraftUI } from 'soundcraft-ui-connection';
import { sameValue, type ParamKey, type ParamValue } from '../core/revisions.js';
import { observeParam, writeParam } from './protocol-map.js';
import {
  LinkUnavailableError,
  type LinkState,
  type ParamChangeOrigin,
  type ReadResult,
  type VerificationReport,
} from './types.js';

/** Por quanto tempo (padrão) uma instância descartada continua vigiada pelo status. */
const ZOMBIE_WATCH_MS = 30_000;

/**
 * Portão de uma geração. `isAlive()` fica false para sempre depois do descarte.
 * Quem cria a instância (RealMixer) usa isso para impedir, em definitivo, que uma instância
 * descartada abra qualquer conexão nova, mesmo depois que a vigilância terminar.
 */
export interface GenerationGate {
  readonly generation: number;
  isAlive(): boolean;
  /** Chamado quando uma instância descartada tentou abrir conexão (para derrubá-la de novo). */
  onBlocked(): void;
}

export interface SupervisorOptions {
  /** Cria uma instância NOVA da biblioteca (nunca reaproveitada entre gerações). */
  createUi: (gate: GenerationGate) => SoundcraftUI;
  /** Duração da vigilância por status das instâncias descartadas (padrão 30 s). */
  zombieWatchMs?: number;
  /** Parâmetros que precisam ser conhecidos para liberar escrita (READY). */
  requiredKeys: ParamKey[];
  /** Parâmetros acompanhados (inclui os obrigatórios). */
  watchedKeys: ParamKey[];
  /** Canais cujo nome na mesa é acompanhado (só exibição). */
  nameChannels?: number[];
  connectTimeoutMs: number;
  syncTimeoutMs: number;
  indeterminateWindowMs: number;
  reconnectBaseMs: number;
  reconnectMaxDelayMs: number;
  clock?: () => number;
  /** Para diagnóstico/testes. */
  onTrace?: (event: string) => void;
}

interface Generation {
  id: number;
  ui: SoundcraftUI;
  subs: Array<{ unsubscribe(): void }>;
  timers: Set<NodeJS.Timeout>;
}

interface SentWrite {
  key: ParamKey;
  value: ParamValue;
  sentAt: number;
}

/**
 * Supervisiona a conexão com a mesa real:
 * - cada instância da biblioteca é uma GERAÇÃO; eventos de gerações antigas são ignorados;
 * - na primeira queda, a instância é DESCARTADA (o buffer interno de comandos morre com ela);
 * - reconexão sempre com instância nova, sem levar comandos;
 * - escrita só em READY (todos os parâmetros obrigatórios conhecidos);
 * - escritas da janela da queda são verificadas na ressincronização, nunca reenviadas.
 */
export class ConnectionSupervisor {
  private state: LinkState = 'DISCONNECTED';
  private gen: Generation | undefined;
  private genCounter = 0;
  private values = new Map<ParamKey, ParamValue>();
  private names = new Map<number, string>();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private stopped = true;
  private selfWriting: ParamKey | undefined;
  private recentWrites: SentWrite[] = [];
  private toVerify: SentWrite[] = [];
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private lastReason = '';
  /** Instâncias descartadas ainda vigiadas (para garantir que não reconectem sozinhas). */
  private zombies = new Set<{ timers: NodeJS.Timeout[]; watch: { unsubscribe(): void }; kill: () => void }>();
  private readonly clock: () => number;
  private readonly required: Set<ParamKey>;

  private changeListeners = new Set<(key: ParamKey, value: ParamValue, origin: ParamChangeOrigin) => void>();
  private verificationListeners = new Set<(reports: VerificationReport[]) => void>();
  private linkListeners = new Set<(state: LinkState) => void>();

  constructor(private opts: SupervisorOptions) {
    this.clock = opts.clock ?? Date.now;
    this.required = new Set(opts.requiredKeys);
  }

  // ---------- API pública ----------

  link(): LinkState {
    return this.state;
  }
  reason(): string {
    return this.lastReason;
  }
  generation(): number {
    return this.gen?.id ?? 0;
  }
  /** Quantas instâncias vivas existem (deve ser 0 ou 1). */
  liveInstances(): number {
    return this.gen ? 1 : 0;
  }
  hasReconnectTimer(): boolean {
    return this.reconnectTimer !== undefined;
  }

  /**
   * Inicia (ou acompanha) a conexão. Resolve em READY ou DEGRADED_READ_ONLY; rejeita no tempo
   * limite, mas o supervisor continua tentando em segundo plano. Chamadas concorrentes não
   * criam tentativas novas.
   */
  connect(): Promise<void> {
    if (this.state === 'READY' || this.state === 'DEGRADED_READ_ONLY') return Promise.resolve();
    if (this.state === 'STOPPED') return Promise.reject(new Error(this.lastReason || 'controle interrompido'));
    const wait = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`a mesa não ficou pronta em ${this.opts.connectTimeoutMs} ms (${this.state})`));
      }, this.opts.connectTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
    if (this.stopped) {
      this.stopped = false;
      this.reconnectAttempts = 0;
      this.guard(() => this.attempt());
    }
    return wait;
  }

  /** Desliga por pedido do usuário: cancela tudo e não tenta de novo. */
  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.dispose();
    this.releaseZombies();
    this.recentWrites = [];
    this.setState('DISCONNECTED');
    this.rejectWaiters(new Error('desconectado'));
  }

  read(key: ParamKey): ReadResult {
    if (this.state !== 'READY' && this.state !== 'DEGRADED_READ_ONLY') return { known: false };
    const v = this.values.get(key);
    return v === undefined ? { known: false } : { known: true, value: v };
  }

  channelName(channel: number): string | undefined {
    return this.names.get(channel);
  }

  /** Escreve um parâmetro. Lança LinkUnavailableError (nada enviado) fora de READY. */
  write(key: ParamKey, value: ParamValue): void {
    if (this.state !== 'READY' || !this.gen) throw new LinkUnavailableError(this.state);
    const g = this.gen;
    // Defesa em profundidade: a instância precisa estar aberta neste exato momento.
    if (g.ui.conn.status !== ConnectionStatus.Open) {
      this.lost(g.id, 'portão de envio: conexão não está aberta');
      throw new LinkUnavailableError(this.state);
    }
    this.selfWriting = key;
    try {
      writeParam(g.ui, key, value);
    } finally {
      this.selfWriting = undefined;
    }
    this.values.set(key, value);
    const now = this.clock();
    this.recentWrites.push({ key, value, sentAt: now });
    this.pruneRecent(now);
  }

  /** Executa uma ação na instância atual, só em READY. */
  withReadyUi<T>(fn: (ui: SoundcraftUI) => T): T {
    if (this.state !== 'READY' || !this.gen) throw new LinkUnavailableError(this.state);
    if (this.gen.ui.conn.status !== ConnectionStatus.Open) {
      this.lost(this.gen.id, 'portão de envio: conexão não está aberta');
      throw new LinkUnavailableError(this.state);
    }
    return fn(this.gen.ui);
  }

  /** Acesso de leitura à instância atual (READY ou DEGRADED). */
  currentUi(): SoundcraftUI | undefined {
    return this.state === 'READY' || this.state === 'DEGRADED_READ_ONLY' ? this.gen?.ui : undefined;
  }

  onParamChange(l: (key: ParamKey, value: ParamValue, origin: ParamChangeOrigin) => void) {
    this.changeListeners.add(l);
    return () => this.changeListeners.delete(l);
  }
  onVerification(l: (reports: VerificationReport[]) => void) {
    this.verificationListeners.add(l);
    return () => this.verificationListeners.delete(l);
  }
  onLinkChange(l: (state: LinkState) => void) {
    this.linkListeners.add(l);
    return () => this.linkListeners.delete(l);
  }

  // ---------- ciclo de vida ----------

  private attempt() {
    this.reconnectTimer = undefined;
    if (this.stopped) return;
    this.dispose();
    const id = ++this.genCounter;
    this.values.clear();
    this.names.clear();
    this.setState('CONNECTING');
    this.trace(`gen ${id}: conectando`);
    let killLater: () => void = () => undefined;
    const gate: GenerationGate = {
      generation: id,
      isAlive: () => this.isCurrent(id),
      onBlocked: () => {
        this.trace(`gen ${id}: instância descartada tentou abrir conexão; bloqueada`);
        killLater();
      },
    };
    const ui = this.opts.createUi(gate);
    killLater = () =>
      setTimeout(() => {
        try {
          void ui.disconnect().catch(() => undefined);
        } catch {
          /* ignora */
        }
      }, 0);
    const g: Generation = { id, ui, subs: [], timers: new Set() };
    this.gen = g;
    g.subs.push(ui.status$.subscribe((ev) => this.guard(() => this.onStatus(id, ev.type))));
    this.timer(g, this.opts.connectTimeoutMs, () => {
      if (this.state === 'CONNECTING') this.lost(id, 'tempo limite de conexão');
    });
    ui.connect().catch(() => undefined); // o resultado chega pelos eventos de status
  }

  private onStatus(id: number, type: ConnectionStatus) {
    if (!this.isCurrent(id)) {
      this.trace(`gen ${id}: evento ${type} ignorado (geração antiga)`);
      return;
    }
    if (type === ConnectionStatus.Opening) return;
    if (type === ConnectionStatus.Open) {
      if (this.state === 'CONNECTING') this.beginSync(id);
      return; // OPEN duplicado em SYNCING/DEGRADED/READY: ignorado
    }
    // CLOSE, CLOSING, ERROR, RECONNECTING: primeira queda = descarta a instância.
    this.lost(id, `evento ${type}`);
  }

  private beginSync(id: number) {
    const g = this.gen!;
    this.setState('SYNCING');
    this.trace(`gen ${id}: sincronizando`);
    for (const key of this.opts.watchedKeys) {
      g.subs.push(observeParam(g.ui, key).subscribe((v) => this.guard(() => this.onValue(id, key, v))));
    }
    for (const ch of this.opts.nameChannels ?? []) {
      g.subs.push(
        g.ui.master.input(ch).name$.subscribe((n) => {
          if (this.isCurrent(id) && n) this.names.set(ch, n);
        }),
      );
    }
    this.checkComplete(id);
    this.timer(g, this.opts.syncTimeoutMs, () => {
      if (this.isCurrent(id) && this.state === 'SYNCING') {
        this.setState('DEGRADED_READ_ONLY');
        this.trace(`gen ${id}: sincronização incompleta, somente leitura`);
        this.runVerification();
        this.resolveWaiters();
      }
    });
  }

  private onValue(id: number, key: ParamKey, value: ParamValue) {
    if (!this.isCurrent(id)) return;
    if (this.selfWriting === key) return; // eco local da própria escrita
    const prev = this.values.get(key);
    this.values.set(key, value);
    if (this.state === 'READY') {
      if (!sameValue(prev, value)) this.emitChange(key, value, 'external');
      return;
    }
    if (this.state === 'SYNCING' || this.state === 'DEGRADED_READ_ONLY') {
      this.emitChange(key, value, 'resync');
      this.checkComplete(id);
    }
  }

  private checkComplete(id: number) {
    if (!this.isCurrent(id)) return;
    if (this.state !== 'SYNCING' && this.state !== 'DEGRADED_READ_ONLY') return;
    for (const k of this.required) if (!this.values.has(k)) return;
    const wasDegraded = this.state === 'DEGRADED_READ_ONLY';
    this.setState('READY');
    this.reconnectAttempts = 0;
    this.trace(`gen ${id}: pronto`);
    if (!wasDegraded) this.runVerification();
    this.resolveWaiters();
  }

  /** Classifica as escritas da janela da queda. Nunca reenvia nada. */
  private runVerification() {
    if (!this.toVerify.length) return;
    const reports: VerificationReport[] = this.toVerify.map((w) => {
      const observed = this.values.get(w.key);
      if (observed === undefined) return { key: w.key, target: w.value, outcome: 'indeterminate' };
      return {
        key: w.key,
        target: w.value,
        observed,
        outcome: sameValue(observed, w.value) ? 'observed_target' : 'observed_different',
      };
    });
    this.toVerify = [];
    for (const l of this.verificationListeners) l(reports);
  }

  private lost(id: number, reason: string) {
    if (!this.isCurrent(id)) return;
    if (this.state === 'LOST' || this.state === 'DISCONNECTED' || this.state === 'STOPPED') return;
    const wasReady = this.state === 'READY';
    this.lastReason = reason;
    this.trace(`gen ${id}: perdida (${reason})`);
    if (wasReady) {
      const now = this.clock();
      this.pruneRecent(now);
      // Só a última escrita de cada parâmetro importa para a verificação.
      for (const w of this.recentWrites) {
        this.toVerify = this.toVerify.filter((x) => x.key !== w.key);
        this.toVerify.push(w);
      }
    }
    this.recentWrites = [];
    this.dispose();
    this.values.clear();
    this.setState('LOST');
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.opts.reconnectBaseMs * 2 ** this.reconnectAttempts, this.opts.reconnectMaxDelayMs);
    this.reconnectAttempts += 1;
    this.trace(`nova tentativa em ${delay} ms`);
    this.reconnectTimer = setTimeout(() => this.guard(() => this.attempt()), delay);
  }

  /**
   * Descarta a geração atual: temporizadores, assinaturas e a instância da biblioteca.
   *
   * Detalhe importante (verificado no código da biblioteca 7.1.0): a reconexão automática dela só
   * é cancelada por `disconnect()` se ele for chamado DEPOIS que ela agendou a nova tentativa.
   * Como a queda chega a nós no meio desse processo, o disconnect é chamado na hora E de novo na
   * próxima volta do loop de eventos, e a instância descartada fica vigiada: se ela tentar abrir
   * sozinha, é derrubada de novo. Nada é enviado por ela, porque o MixAI não a usa mais.
   *
   * Garantia definitiva (independente do tempo de vigilância): o portão da geração fecha aqui,
   * e o RealMixer cria os sockets através dele; uma instância descartada não consegue mais
   * abrir conexão nenhuma, nem minutos depois.
   */
  private dispose() {
    const g = this.gen;
    if (!g) return;
    this.gen = undefined;
    for (const t of g.timers) clearTimeout(t);
    g.timers.clear();
    for (const s of g.subs) {
      try {
        s.unsubscribe();
      } catch {
        /* ignora */
      }
    }
    g.subs = [];
    const kill = () => {
      try {
        // Não esperar: depois de uma queda, a promessa da biblioteca pode nunca resolver.
        void g.ui.disconnect().catch(() => undefined);
      } catch {
        /* ignora */
      }
    };
    kill();
    const zombie = {
      timers: [] as NodeJS.Timeout[],
      watch: { unsubscribe() {} } as { unsubscribe(): void },
      kill,
    };
    try {
      zombie.watch = g.ui.status$.subscribe((ev) => {
        if (ev.type === ConnectionStatus.Open || ev.type === ConnectionStatus.Opening || ev.type === ConnectionStatus.Reconnecting) {
          this.trace(`gen ${g.id}: instância descartada tentou reconectar (${ev.type}); derrubada de novo`);
          kill();
        }
      });
    } catch {
      /* ignora */
    }
    zombie.timers.push(setTimeout(kill, 0));
    zombie.timers.push(
      setTimeout(() => {
        zombie.watch.unsubscribe();
        this.zombies.delete(zombie);
      }, this.opts.zombieWatchMs ?? ZOMBIE_WATCH_MS),
    );
    this.zombies.add(zombie);
    this.trace(`gen ${g.id}: descartada`);
  }

  private releaseZombies() {
    for (const z of this.zombies) {
      for (const t of z.timers) clearTimeout(t);
      z.kill();
      z.watch.unsubscribe();
    }
    this.zombies.clear();
  }

  // ---------- utilitários ----------

  private isCurrent(id: number) {
    return this.gen !== undefined && this.gen.id === id;
  }

  private timer(g: Generation, ms: number, fn: () => void) {
    const t = setTimeout(() => {
      g.timers.delete(t);
      if (this.isCurrent(g.id)) this.guard(fn);
    }, ms);
    g.timers.add(t);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private pruneRecent(now: number) {
    this.recentWrites = this.recentWrites.filter((w) => now - w.sentAt <= this.opts.indeterminateWindowMs);
  }

  private setState(s: LinkState) {
    if (this.state === s) return;
    this.state = s;
    for (const l of this.linkListeners) l(s);
  }

  private emitChange(key: ParamKey, value: ParamValue, origin: ParamChangeOrigin) {
    for (const l of this.changeListeners) l(key, value, origin);
  }

  private resolveWaiters() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private rejectWaiters(err: Error) {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** Qualquer falha interna interrompe o controle automático (STOPPED). */
  private guard(fn: () => void) {
    try {
      fn();
    } catch (err) {
      this.lastReason = `falha interna do supervisor: ${(err as Error).message}`;
      this.trace(this.lastReason);
      this.stopped = true;
      this.clearReconnect();
      this.dispose();
      this.releaseZombies();
      this.setState('STOPPED');
      this.rejectWaiters(new Error(this.lastReason));
    }
  }

  private trace(event: string) {
    this.opts.onTrace?.(event);
  }
}
