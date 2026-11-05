/** Onde um ajuste acontece: na mix principal (master) ou num retorno (AUX). */
export type Bus = { kind: 'master' } | { kind: 'aux'; aux: number };

export const MASTER: Bus = { kind: 'master' };
export const auxBus = (aux: number): Bus => ({ kind: 'aux', aux });

export interface MixerCapabilities {
  model: string;
  inputs: number;
  aux: number;
}

export type ShowList = Record<string, string[]>;

/**
 * Interface única para a mesa real e a simulada.
 * Níveis sempre em dB; -Infinity = fader todo para baixo.
 */
export interface MixerAdapter {
  readonly mode: 'mock' | 'real';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Texto curto sobre o estado da conexão. */
  statusText(): string;
  capabilities(): MixerCapabilities;

  getLevelDB(channel: number, bus: Bus): Promise<number>;
  setLevelDB(channel: number, bus: Bus, db: number): Promise<void>;
  getMute(channel: number, bus: Bus): Promise<boolean>;
  setMute(channel: number, bus: Bus, muted: boolean): Promise<void>;
  /** Nome que está escrito no canal da própria mesa (se houver). */
  getChannelName(channel: number): Promise<string | undefined>;

  getMasterDB(): Promise<number>;
  setMasterDB(db: number): Promise<void>;

  listShows(): Promise<ShowList>;
  currentSnapshot(): Promise<{ show?: string; snapshot?: string }>;
  loadSnapshot(show: string, snapshot: string): Promise<void>;
}
