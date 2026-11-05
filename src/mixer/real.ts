import { ConnectionStatus, DEVICE_CAPABILITIES, SoundcraftUI } from 'soundcraft-ui-connection';
import type { Bus, MixerAdapter, MixerCapabilities, ShowList } from './types.js';

interface Subscribable<T> {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
}

/** Lê o valor atual de um stream da biblioteca (a mesa manda o estado ao conectar). */
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
  connectTimeoutMs?: number;
  /** Só para testes: troca o WebSocket usado pela biblioteca. */
  webSocketCtor?: unknown;
}

/** Mesa real, via biblioteca soundcraft-ui-connection (WebSocket da interface web). */
export class RealMixer implements MixerAdapter {
  readonly mode = 'real' as const;
  readonly ui: SoundcraftUI;
  private status: ConnectionStatus = ConnectionStatus.Close;
  private lastError: string | undefined;
  private caps: MixerCapabilities;

  constructor(private opts: RealMixerOptions) {
    const options: Record<string, unknown> = { targetIP: opts.ip };
    if (opts.webSocketCtor) options.webSocketCtor = opts.webSocketCtor;
    this.ui = new SoundcraftUI(options as never);
    this.ui.status$.subscribe((ev) => {
      this.status = ev.type;
      if (ev.type === ConnectionStatus.Error) {
        const payload = (ev as { payload?: unknown }).payload;
        this.lastError = payload instanceof Error ? payload.message : String(payload ?? 'erro desconhecido');
      }
      if (ev.type === ConnectionStatus.Open) this.lastError = undefined;
    });
    const c = DEVICE_CAPABILITIES[opts.model ?? 'ui16'];
    this.caps = { model: c.model, inputs: c.input, aux: c.aux };
  }

  async connect() {
    const timeout = this.opts.connectTimeoutMs ?? 8000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.ui.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Não consegui conectar na mesa em ${this.opts.ip} (tempo esgotado)`)),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async disconnect() {
    // Não deixa o encerramento travar se a mesa sumiu da rede.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.ui.disconnect().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
    clearTimeout(timer);
    this.status = ConnectionStatus.Close;
  }

  isConnected() {
    return this.status === ConnectionStatus.Open;
  }

  statusText() {
    switch (this.status) {
      case ConnectionStatus.Open:
        return `Conectado à mesa em ${this.opts.ip}`;
      case ConnectionStatus.Opening:
        return `Conectando à mesa em ${this.opts.ip}...`;
      case ConnectionStatus.Reconnecting:
        return `Reconectando à mesa em ${this.opts.ip}...`;
      case ConnectionStatus.Error:
        return `Erro na conexão com ${this.opts.ip}: ${this.lastError ?? 'desconhecido'}`;
      default:
        return `Desconectado da mesa (${this.opts.ip})`;
    }
  }

  capabilities() {
    return this.caps;
  }

  private channel(channel: number, bus: Bus) {
    return bus.kind === 'master' ? this.ui.master.input(channel) : this.ui.aux(bus.aux).input(channel);
  }

  async getLevelDB(channel: number, bus: Bus) {
    return currentValue(this.channel(channel, bus).faderLevelDB$);
  }
  async setLevelDB(channel: number, bus: Bus, db: number) {
    this.channel(channel, bus).setFaderLevelDB(db);
  }
  async getMute(channel: number, bus: Bus) {
    return currentValue(this.channel(channel, bus).mute$);
  }
  async setMute(channel: number, bus: Bus, muted: boolean) {
    this.channel(channel, bus).setMute(muted);
  }
  async getChannelName(channel: number) {
    try {
      const name = await currentValue(this.ui.master.input(channel).name$, 500);
      return name || undefined;
    } catch {
      return undefined;
    }
  }
  async getMasterDB() {
    return currentValue(this.ui.master.faderLevelDB$);
  }
  async setMasterDB(db: number) {
    this.ui.master.setFaderLevelDB(db);
  }
  async listShows() {
    try {
      const shows = await currentValue(this.ui.shows.shows$, 2000);
      const out: ShowList = {};
      for (const [name, details] of Object.entries(shows ?? {})) out[name] = [...(details?.snapshots ?? [])];
      return out;
    } catch {
      return {};
    }
  }
  async currentSnapshot() {
    const [show, snapshot] = await Promise.all([
      currentValue(this.ui.shows.currentShow$, 800).catch(() => undefined),
      currentValue(this.ui.shows.currentSnapshot$, 800).catch(() => undefined),
    ]);
    return { show: show || undefined, snapshot: snapshot || undefined };
  }
  async loadSnapshot(show: string, snapshot: string) {
    this.ui.shows.loadSnapshot(show, snapshot);
  }
}
