import { paramKey, type ParamKey, type ParamValue } from '../core/revisions.js';
import {
  LinkUnavailableError,
  MASTER,
  type Bus,
  type LinkState,
  type MixerAdapter,
  type MixerCapabilities,
  type ParamChangeOrigin,
  type ReadResult,
  type ShowList,
  type VerificationReport,
  type WriteOutcome,
} from './types.js';

type ChangeListener = (key: ParamKey, value: ParamValue, origin: ParamChangeOrigin) => void;

/**
 * Mesa simulada em memória, no formato da Ui16 (12 entradas, 6 AUX). É o dublê dos testes e o
 * modo mock do Claude Desktop. Também simula queda, ressincronização, mudança externa e falha
 * no meio de uma operação composta.
 */
export class MockMixer implements MixerAdapter {
  readonly mode = 'mock' as const;
  private state: LinkState = 'DISCONNECTED';
  private values = new Map<ParamKey, ParamValue>();
  private shows: ShowList = { Pagode: ['Ensaio', 'Bar'] };
  private current: { show?: string; snapshot?: string } = {};
  private changeListeners = new Set<ChangeListener>();
  private verificationListeners = new Set<(r: VerificationReport[]) => void>();
  private writesBeforeFailure: number | undefined;
  private writesBeforeThrow: { n: number; error: Error } | undefined;
  /** Escritas feitas pelo MixAI (útil nos testes). Mudanças simuladas de fora não entram aqui. */
  readonly writes: string[] = [];

  constructor(private caps: MixerCapabilities = { model: 'ui16', inputs: 12, aux: 6 }) {
    for (let ch = 1; ch <= caps.inputs; ch++) {
      this.values.set(paramKey.level(ch, MASTER), -10);
      this.values.set(paramKey.mute(ch, MASTER), false);
      for (let a = 1; a <= caps.aux; a++) {
        this.values.set(paramKey.level(ch, { kind: 'aux', aux: a }), -20);
        this.values.set(paramKey.mute(ch, { kind: 'aux', aux: a }), false);
      }
    }
    this.values.set(paramKey.master(), -6);
  }

  // ---------- contrato ----------

  async connect() {
    this.state = 'READY';
  }
  async disconnect() {
    this.state = 'DISCONNECTED';
  }
  link() {
    return this.state;
  }
  statusText() {
    switch (this.state) {
      case 'READY':
        return 'Conectado à mesa simulada';
      case 'LOST':
        return 'Mesa simulada: conexão perdida, aguardando ressincronização';
      case 'DEGRADED_READ_ONLY':
        return 'Mesa simulada: sincronização incompleta (somente leitura)';
      default:
        return 'Mesa simulada desconectada';
    }
  }
  capabilities() {
    return this.caps;
  }

  read(key: ParamKey): ReadResult {
    if (this.state !== 'READY' && this.state !== 'DEGRADED_READ_ONLY') return { known: false };
    const v = this.values.get(key);
    return v === undefined ? { known: false } : { known: true, value: v };
  }

  async write(key: ParamKey, value: ParamValue): Promise<WriteOutcome> {
    if (this.state !== 'READY') throw new LinkUnavailableError(this.state);
    if (this.writesBeforeFailure !== undefined) {
      if (this.writesBeforeFailure <= 0) {
        this.writesBeforeFailure = undefined;
        this.simulateDrop();
        throw new LinkUnavailableError(this.state);
      }
      this.writesBeforeFailure -= 1;
    }
    if (this.writesBeforeThrow) {
      if (this.writesBeforeThrow.n <= 0) {
        const { error } = this.writesBeforeThrow;
        this.writesBeforeThrow = undefined;
        throw error;
      }
      this.writesBeforeThrow.n -= 1;
    }
    if (!this.values.has(key)) throw new Error(`Parâmetro inexistente na mesa simulada: ${key}`);
    this.values.set(key, value);
    this.writes.push(`${key}=${value}`);
    return 'applied_simulated';
  }

  onParamChange(listener: ChangeListener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  onVerification(listener: (r: VerificationReport[]) => void) {
    this.verificationListeners.add(listener);
    return () => this.verificationListeners.delete(listener);
  }

  channelName(channel: number) {
    return `CH ${channel}`;
  }
  async listShows() {
    return this.shows;
  }
  async currentSnapshot() {
    return this.current;
  }
  async loadSnapshot(show: string, snapshot: string): Promise<WriteOutcome> {
    if (this.state !== 'READY') throw new LinkUnavailableError(this.state);
    if (this.writesBeforeThrow) {
      const { error } = this.writesBeforeThrow;
      this.writesBeforeThrow = undefined;
      throw error;
    }
    if (!this.shows[show]?.includes(snapshot)) throw new Error(`Snapshot "${snapshot}" não existe no show "${show}"`);
    this.current = { show, snapshot };
    this.writes.push(`snapshot ${show}/${snapshot}`);
    return 'applied_simulated';
  }

  // ---------- simulação (testes) ----------

  /** Muda um parâmetro como se fosse outro aparelho ou a interface oficial. */
  simulateExternalChange(key: ParamKey, value: ParamValue) {
    this.values.set(key, value);
    for (const l of this.changeListeners) l(key, value, 'external');
  }
  /** Desligamento limpo (como antes da E0). */
  simulateDisconnect() {
    this.state = 'DISCONNECTED';
  }
  /** Queda de conexão: escritas passam a ser recusadas até ressincronizar. */
  simulateDrop() {
    this.state = 'LOST';
  }
  /** Volta a conexão: aplica os valores que "a mesa" tem agora e avisa como ressincronização. */
  simulateResync(changes: Array<[ParamKey, ParamValue]> = [], verification: VerificationReport[] = []) {
    for (const [k, v] of changes) this.values.set(k, v);
    this.state = 'READY';
    for (const [k, v] of changes) for (const l of this.changeListeners) l(k, v, 'resync');
    if (verification.length) for (const l of this.verificationListeners) l(verification);
  }
  /** Deixa a ligação em somente leitura (sincronização incompleta). */
  simulateDegraded() {
    this.state = 'DEGRADED_READ_ONLY';
  }
  /** Força um estado de ligação qualquer (testes de estados distintos). */
  simulateLink(state: LinkState) {
    this.state = state;
  }
  /** Faz um parâmetro ficar desconhecido (a "mesa" ainda não mandou esse valor). */
  simulateUnknown(key: ParamKey) {
    this.values.delete(key);
  }
  /** A escrita depois de `n` escritas bem-sucedidas lança um erro inesperado (não de conexão). */
  throwOnWriteAfter(n: number, error: Error = new Error('erro inesperado simulado')) {
    this.writesBeforeThrow = { n, error };
  }
  /** Outro aparelho carregou um snapshot (muda o snapshot atual sem passar pelo MixAI). */
  simulateSnapshotLoaded(show: string, snapshot: string) {
    this.current = { show, snapshot };
  }
  /** A próxima escrita depois de `n` escritas bem-sucedidas derruba a conexão. */
  failAfterWrites(n: number) {
    this.writesBeforeFailure = n;
  }

  // ---------- atalhos (compatibilidade com os testes da v0.1) ----------

  async getLevelDB(channel: number, bus: Bus) {
    return this.values.get(paramKey.level(channel, bus)) as number;
  }
  /** Mudança "de fora" (equivale a simulateExternalChange). */
  async setLevelDB(channel: number, bus: Bus, db: number) {
    this.simulateExternalChange(paramKey.level(channel, bus), db);
  }
  async getMute(channel: number, bus: Bus) {
    return this.values.get(paramKey.mute(channel, bus)) as boolean;
  }
  async setMute(channel: number, bus: Bus, muted: boolean) {
    this.simulateExternalChange(paramKey.mute(channel, bus), muted);
  }
  async getMasterDB() {
    return this.values.get(paramKey.master()) as number;
  }
  async setMasterDB(db: number) {
    this.simulateExternalChange(paramKey.master(), db);
  }
}
