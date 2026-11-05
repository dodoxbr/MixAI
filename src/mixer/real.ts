import { DEVICE_CAPABILITIES, SoundcraftUI } from 'soundcraft-ui-connection';
import type { ParamKey, ParamValue } from '../core/revisions.js';
import { ConnectionSupervisor } from './connection-supervisor.js';
import {
  LinkUnavailableError,
  type MixerAdapter,
  type MixerCapabilities,
  type ParamChangeOrigin,
  type ReadResult,
  type ShowList,
  type VerificationReport,
  type WriteOutcome,
} from './types.js';

interface Subscribable<T> {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
}

/** Lê o valor atual de um stream da biblioteca (para listas que não fazem parte do estado espelhado). */
export function currentValue<T>(source: Subscribable<T>, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    let sub: { unsubscribe(): void } | undefined;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sub?.unsubscribe();
      reject(new Error('A mesa não respondeu a tempo'));
    }, timeoutMs);
    sub = source.subscribe((value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => sub?.unsubscribe());
      resolve(value);
    });
    if (done) queueMicrotask(() => sub?.unsubscribe());
  });
}

export interface RealMixerOptions {
  ip: string;
  model?: 'ui12' | 'ui16' | 'ui24';
  /** Parâmetros obrigatórios para liberar escrita (canais do channels.yaml + master). */
  requiredKeys: ParamKey[];
  /** Parâmetros acompanhados (inclui os obrigatórios). */
  watchedKeys: ParamKey[];
  nameChannels?: number[];
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  indeterminateWindowMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxDelayMs?: number;
  /** Só para testes: troca o WebSocket usado pela biblioteca. */
  webSocketCtor?: unknown;
  onTrace?: (event: string) => void;
}

/** Mesa real, via soundcraft-ui-connection, sempre atrás do ConnectionSupervisor. */
export class RealMixer implements MixerAdapter {
  readonly mode = 'real' as const;
  readonly supervisor: ConnectionSupervisor;
  private caps: MixerCapabilities;

  constructor(private opts: RealMixerOptions) {
    const c = DEVICE_CAPABILITIES[opts.model ?? 'ui16'];
    this.caps = { model: c.model, inputs: c.input, aux: c.aux };
    this.supervisor = new ConnectionSupervisor({
      createUi: () => {
        const options: Record<string, unknown> = { targetIP: opts.ip };
        if (opts.webSocketCtor) options.webSocketCtor = opts.webSocketCtor;
        return new SoundcraftUI(options as never);
      },
      requiredKeys: opts.requiredKeys,
      watchedKeys: opts.watchedKeys,
      nameChannels: opts.nameChannels,
      connectTimeoutMs: opts.connectTimeoutMs ?? 8000,
      syncTimeoutMs: opts.syncTimeoutMs ?? 5000,
      indeterminateWindowMs: opts.indeterminateWindowMs ?? 3000,
      reconnectBaseMs: opts.reconnectBaseMs ?? 1000,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? 10000,
      onTrace: opts.onTrace,
    });
  }

  async connect() {
    try {
      await this.supervisor.connect();
    } catch (err) {
      throw new Error(`Não consegui conectar na mesa em ${this.opts.ip}: ${(err as Error).message}`);
    }
  }

  async disconnect() {
    await this.supervisor.disconnect();
  }

  link() {
    return this.supervisor.link();
  }

  statusText() {
    const ip = this.opts.ip;
    switch (this.supervisor.link()) {
      case 'READY':
        return `Conectado à mesa em ${ip}`;
      case 'CONNECTING':
        return `Conectando à mesa em ${ip}...`;
      case 'SYNCING':
        return `Sincronizando o estado da mesa em ${ip}...`;
      case 'DEGRADED_READ_ONLY':
        return `Mesa em ${ip}: estado incompleto, somente leitura (sincronização continua)`;
      case 'LOST':
        return `Conexão com ${ip} perdida (${this.supervisor.reason()}); tentando de novo, sem reenviar comandos`;
      case 'STOPPED':
        return `Controle automático interrompido (${this.supervisor.reason()}). Use a interface oficial da Soundcraft.`;
      default:
        return `Desconectado da mesa (${ip})`;
    }
  }

  capabilities() {
    return this.caps;
  }

  read(key: ParamKey): ReadResult {
    return this.supervisor.read(key);
  }

  async write(key: ParamKey, value: ParamValue): Promise<WriteOutcome> {
    this.supervisor.write(key, value);
    return 'sent';
  }

  onParamChange(listener: (key: ParamKey, value: ParamValue, origin: ParamChangeOrigin) => void) {
    return this.supervisor.onParamChange(listener);
  }

  onVerification(listener: (reports: VerificationReport[]) => void) {
    return this.supervisor.onVerification(listener);
  }

  channelName(channel: number) {
    return this.supervisor.channelName(channel);
  }

  async listShows(): Promise<ShowList> {
    const ui = this.supervisor.currentUi();
    if (!ui) return {};
    try {
      const shows = await currentValue(ui.shows.shows$, 2000);
      const out: ShowList = {};
      for (const [name, details] of Object.entries(shows ?? {})) out[name] = [...(details?.snapshots ?? [])];
      return out;
    } catch {
      return {};
    }
  }

  async currentSnapshot() {
    const ui = this.supervisor.currentUi();
    if (!ui) return {};
    const [show, snapshot] = await Promise.all([
      currentValue(ui.shows.currentShow$, 800).catch(() => undefined),
      currentValue(ui.shows.currentSnapshot$, 800).catch(() => undefined),
    ]);
    return { show: show || undefined, snapshot: snapshot || undefined };
  }

  async loadSnapshot(show: string, snapshot: string): Promise<WriteOutcome> {
    this.supervisor.withReadyUi((ui) => ui.shows.loadSnapshot(show, snapshot));
    return 'sent';
  }
}

export { LinkUnavailableError };
