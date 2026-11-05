import { paramKey, type ParamKey, type ParamValue } from '../core/revisions.js';
import { SimulatedMixer, UI16_CAPS } from './simulated.js';
import { LinkUnavailableError, type Bus, type LinkState, type MixerCapabilities, type VerificationReport } from './types.js';

/**
 * Dublê em memória, no formato da Ui16 (12 entradas, 6 AUX), para TESTES.
 * Nada é gravado em disco. Simula queda, ressincronização, mudança externa e falhas.
 * Para uso com o Claude Desktop sem a mesa, prefira o modo `lab` (LabMixer persistente).
 */
export class MockMixer extends SimulatedMixer {
  readonly mode = 'mock' as const;
  private writesBeforeFailure: number | undefined;
  private writesBeforeThrow: { n: number; error: Error } | undefined;
  /** Escritas feitas pelo MixAI (útil nos testes). Mudanças simuladas de fora não entram aqui. */
  readonly writes: string[] = [];

  constructor(caps: MixerCapabilities = UI16_CAPS) {
    super(caps);
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

  override channelName(channel: number) {
    return `CH ${channel}`;
  }

  protected override beforeWrite() {
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
  }
  protected override afterWrite(key: ParamKey, value: ParamValue) {
    this.writes.push(`${key}=${value}`);
  }
  protected override beforeSnapshot() {
    if (this.writesBeforeThrow) {
      const { error } = this.writesBeforeThrow;
      this.writesBeforeThrow = undefined;
      throw error;
    }
  }
  protected override afterSnapshot(show: string, snapshot: string) {
    this.writes.push(`snapshot ${show}/${snapshot}`);
  }

  // ---------- simulação (testes) ----------

  /** Muda um parâmetro como se fosse outro aparelho ou a interface oficial. */
  simulateExternalChange(key: ParamKey, value: ParamValue) {
    this.values.set(key, value);
    this.emitChange(key, value, 'external');
  }
  /** Desligamento limpo. */
  simulateDisconnect() {
    this.setLink('DISCONNECTED');
  }
  /** Queda de conexão: escritas passam a ser recusadas até ressincronizar. */
  simulateDrop() {
    this.setLink('LOST');
  }
  /** Volta a conexão: aplica os valores que "a mesa" tem agora e avisa como ressincronização. */
  simulateResync(changes: Array<[ParamKey, ParamValue]> = [], verification: VerificationReport[] = []) {
    for (const [k, v] of changes) this.values.set(k, v);
    this.setLink('READY');
    for (const [k, v] of changes) this.emitChange(k, v, 'resync');
    if (verification.length) this.emitVerification(verification);
  }
  /** Deixa a ligação em somente leitura (sincronização incompleta). */
  simulateDegraded() {
    this.setLink('DEGRADED_READ_ONLY');
  }
  /** Força um estado de ligação qualquer (testes de estados distintos). */
  simulateLink(state: LinkState) {
    this.setLink(state);
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
