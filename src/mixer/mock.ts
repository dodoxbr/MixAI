import type { Bus, MixerAdapter, MixerCapabilities, ShowList } from './types.js';

interface ChannelState {
  level: number;
  mute: boolean;
  aux: Map<number, { level: number; mute: boolean }>;
}

/** Mesa simulada em memória, com o mesmo formato da Ui16 (12 entradas, 6 AUX). */
export class MockMixer implements MixerAdapter {
  readonly mode = 'mock' as const;
  private connected = false;
  private channels = new Map<number, ChannelState>();
  private master = -6;
  private shows: ShowList = { Pagode: ['Ensaio', 'Bar'] };
  private current: { show?: string; snapshot?: string } = {};
  /** Lista de tudo que foi enviado para a "mesa" (útil nos testes). */
  readonly writes: string[] = [];

  constructor(private caps: MixerCapabilities = { model: 'ui16', inputs: 12, aux: 6 }) {
    for (let ch = 1; ch <= caps.inputs; ch++) {
      const aux = new Map<number, { level: number; mute: boolean }>();
      for (let a = 1; a <= caps.aux; a++) aux.set(a, { level: -20, mute: false });
      this.channels.set(ch, { level: -10, mute: false, aux });
    }
  }

  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  statusText() {
    return this.connected ? 'Conectado à mesa simulada' : 'Mesa simulada desconectada';
  }
  capabilities() {
    return this.caps;
  }

  /** Só para testes: simula queda de conexão. */
  simulateDisconnect() {
    this.connected = false;
  }

  private slot(channel: number, bus: Bus) {
    const ch = this.channels.get(channel);
    if (!ch) throw new Error(`Canal ${channel} não existe nesta mesa`);
    if (bus.kind === 'master') return ch;
    const a = ch.aux.get(bus.aux);
    if (!a) throw new Error(`AUX ${bus.aux} não existe nesta mesa`);
    return a;
  }

  async getLevelDB(channel: number, bus: Bus) {
    return this.slot(channel, bus).level;
  }
  async setLevelDB(channel: number, bus: Bus, db: number) {
    this.slot(channel, bus).level = db;
    this.writes.push(`level ${channel} ${bus.kind === 'aux' ? `aux${bus.aux}` : 'master'} ${db}`);
  }
  async getMute(channel: number, bus: Bus) {
    return this.slot(channel, bus).mute;
  }
  async setMute(channel: number, bus: Bus, muted: boolean) {
    this.slot(channel, bus).mute = muted;
    this.writes.push(`mute ${channel} ${bus.kind === 'aux' ? `aux${bus.aux}` : 'master'} ${muted}`);
  }
  async getChannelName(channel: number) {
    return `CH ${channel}`;
  }
  async getMasterDB() {
    return this.master;
  }
  async setMasterDB(db: number) {
    this.master = db;
    this.writes.push(`master ${db}`);
  }
  async listShows() {
    return this.shows;
  }
  async currentSnapshot() {
    return this.current;
  }
  async loadSnapshot(show: string, snapshot: string) {
    if (!this.shows[show]?.includes(snapshot)) throw new Error(`Snapshot "${snapshot}" não existe no show "${show}"`);
    this.current = { show, snapshot };
    this.writes.push(`snapshot ${show}/${snapshot}`);
  }
}
