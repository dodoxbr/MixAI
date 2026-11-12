import { ConnectionStatus, faderValueToDB } from 'soundcraft-ui-connection';
import {
  Ui16AuxHandshake,
  isAuxLevel,
  type FirstRealAuxGate,
  type AuxObservation,
} from './ui16-aux-write.js';
import { parseKey, type ParamKey, type ParamValue } from '../core/revisions.js';
import { ParamRegistry } from '../core/params.js';
import { RealMixer, type RealMixerOptions } from './real.js';
import {
  observerSocketGate,
  type ObserverSocketCtor,
} from './readonly-socket.js';
import {
  LinkUnavailableError,
  type LinkState,
  type ReadResult,
} from './types.js';

/** Known not-sent refusal: preserve controller revisions/undo instead of claiming uncertainty. */
class PhysicalWriteBlockedError extends LinkUnavailableError {
  constructor() {
    super('DEGRADED_READ_ONLY');
    this.message = 'F0_READ_ONLY: BRIDGE_PHYSICAL_WRITE_UNVALIDATED';
  }
}

export interface BridgeReading {
  state: 'confirmed' | 'pending' | 'stale' | 'unavailable';
  key: ParamKey;
  generation: number;
  value?: ParamValue;
  lastObserved?: { value: ParamValue; at: number; generation: number };
  reason?:
    | 'write_pending'
    | 'write_unconfirmed'
    | 'not_received'
    | 'unsupported'
    | 'disconnected'
    | 'inbound_silence'
    | 'invalid_sample'
    | 'model_mismatch'
    | 'outbound_blocked';
  source: 'device_stream';
  hardwareValidation: 'pending';
}
export interface Ui16BridgeOptions extends Omit<
  RealMixerOptions,
  'readOnly' | 'model'
> {
  /** Silence is quarantined, not a claim that unchanged parameters should periodically emit. */
  inboundSilenceMs?: number;
  clock?: () => number;
  routeGuard?: () => boolean;
  /** Server bootstrap only; omitted by default. */
  firstRealAux?: FirstRealAuxGate;
}
interface Seen {
  at: number;
  generation: number;
  sequence: number;
}

/** Read-only by default. AUX writes need trusted bootstrap plus a queued human authorization. */
export class Ui16RealBridge extends RealMixer {
  readonly auxHandshake: Ui16AuxHandshake;
  private readonly stereo = new Map<
    string,
    { value: number; at: number; generation: number }
  >();
  private readonly independentAux = new Map<ParamKey, AuxObservation>();
  private readonly paramListeners = new Set<
    (
      key: ParamKey,
      value: ParamValue,
      origin: import('./types.js').ParamChangeOrigin,
    ) => void
  >();
  private readonly received = new Map<ParamKey, Seen>();
  private readonly history = new Map<
    ParamKey,
    { value: ParamValue; at: number; generation: number }
  >();
  private readonly listeners = new Set<(state: LinkState) => void>();
  private readonly registry = new ParamRegistry({
    model: 'ui16',
    inputs: 12,
    aux: 6,
  });
  private readonly now: () => number;
  private readonly silenceMs: number;
  private readonly watched: Set<ParamKey>;
  private readonly required: ParamKey[];
  private fault?: BridgeReading['reason'];
  private lastInbound = 0;
  private quarantined = false;
  private fence = -Infinity;
  private sequence = 0;
  private announced: LinkState = 'DISCONNECTED';
  private timer?: NodeJS.Timeout;
  private reported?: 'ui12' | 'ui16' | 'ui24';

  constructor(opts: Ui16BridgeOptions) {
    const silenceMs = opts.inboundSilenceMs ?? 30000;
    if (!Number.isInteger(silenceMs) || silenceMs < 10 || silenceMs > 900000)
      throw Error('BRIDGE_INVALID_OPTIONS');
    const keys = [...new Set([...opts.requiredKeys, ...opts.watchedKeys])];
    // Observe optional library streams without making unvalidated EQ fields a READY prerequisite.
    const channels = new Set(
      keys.flatMap((k) => {
        const p = parseKey(k);
        return p.kind === 'master' ? [] : [p.channel];
      }),
    );
    for (const ch of channels) {
      for (const band of [1, 2, 3, 4] as const)
        for (const field of ['freq', 'q', 'gain'] as const)
          keys.push(`ch.${ch}.eq.b${band}.${field}`);
      keys.push(`ch.${ch}.eq.hpf.freq`, `ch.${ch}.eq.bypass`);
    }
    const registry = new ParamRegistry({ model: 'ui16', inputs: 12, aux: 6 });
    for (const k of keys)
      if (!registry.has(k)) throw Error('BRIDGE_INVALID_KEY');
    const supported = [
      ...new Set(
        keys.filter((k) => {
          const p = parseKey(k);
          return p.kind !== 'hpf' || p.param !== 'slope';
        }),
      ),
    ];
    if (opts.requiredKeys.some((k) => !supported.includes(k)))
      throw Error('BRIDGE_UNSUPPORTED_REQUIRED_KEY');
    if (
      opts.firstRealAux?.validation === 'simulated_transport' &&
      !opts.webSocketCtor
    )
      throw Error('AUX_SIMULATION_REQUIRES_INJECTED_TRANSPORT');
    const Base = (opts.webSocketCtor ??
      globalThis.WebSocket) as ObserverSocketCtor;
    let bridge: Ui16RealBridge | undefined;
    const routeGuard = opts.routeGuard ?? opts.firstRealAux?.routeGuard;
    const gate = observerSocketGate(
      Base,
      () => bridge?.fail('outbound_blocked'),
      {
        keys: supported,
        onInvalid: () => bridge?.fail('invalid_sample'),
        beforeReceive: (data) => bridge?.incoming(data) ?? false,
        afterValidatedReceive: (data) => bridge?.independentInput(data),
      },
      routeGuard
        ? {
            check: routeGuard,
            onMismatch: () => bridge?.fail('disconnected'),
          }
        : undefined,
      (data) => bridge?.auxHandshake?.allowFrame(data) ?? false,
    );
    super({
      ...opts,
      model: 'ui16',
      readOnly: true,
      requiredKeys: opts.requiredKeys,
      watchedKeys: supported,
      webSocketCtor: gate.Ctor,
    });
    bridge = this;
    this.now = opts.clock ?? (() => performance.now());
    this.silenceMs = silenceMs;
    this.auxHandshake = new Ui16AuxHandshake(opts.firstRealAux, {
      now: () => this.now(),
      connected: () => gate.isOpen(),
      link: () => this.link(),
      identified: () => this.reported === 'ui16',
      observation: (key) => this.required.includes(key)?this.independentAux.get(key):undefined,
      monophonic: (key) => this.monophonic(key),
      send: (key, value) => {
        const p = parseKey(key);
        const ui = this.supervisor.currentUi();
        if (
          !ui ||
          ui.conn.status !== ConnectionStatus.Open ||
          p.kind !== 'channel' ||
          !p.aux ||
          p.param !== 'level'
        )
          throw new PhysicalWriteBlockedError();
        ui.aux(p.aux).input(p.channel).setFaderLevelDB(value);
      },
    });
    this.watched = new Set(keys);
    this.required = [...opts.requiredKeys];
    super.onLinkChange((state) => {
      if (state === 'CONNECTING') {
        this.received.clear();
        this.independentAux.clear();
        this.stereo.clear();
        this.reported = undefined;
        this.quarantined = false;
        this.fence = -Infinity;
        this.lastInbound = this.now();
      }
      if (['LOST', 'DISCONNECTED', 'STOPPED', 'CONNECTING'].includes(state)) {
        this.auxHandshake.connectionChanged();
        if (state !== 'CONNECTING') this.reported = undefined;
      }
      this.announce();
    });
    super.onParamChange((key, value, origin) => {
      if (isAuxLevel(key)) return; // Only raw inbound AUX samples may notify consumers; no library echo.
      const seen = this.received.get(key);
      if (seen && !this.registry.validate(key, value))
        this.history.set(key, {
          value,
          at: seen.at,
          generation: seen.generation,
        });
      for (const listener of this.paramListeners) listener(key, value, origin);
      this.announce();
    });
  }
  private fail(reason: BridgeReading['reason']) {
    clearInterval(this.timer);
    this.timer = undefined;
    this.fault = reason;
    this.auxHandshake.connectionChanged();
    this.announce();
    void super.disconnect();
  }
  private incoming(data: unknown): boolean {
    if (this.fault) return false;
    if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) {
      this.fail('invalid_sample');
      return false;
    }
    this.checkSilence();
    const at = this.now();
    this.lastInbound = at;
    const sequence = ++this.sequence;
    if (data.startsWith('3:::'))
      for (const line of data.slice(4).split('\n')) {
        const [kind, path, value, ...extra] = line.split('^');
        if (path === 'model') {
          if (
            kind !== 'SETS' ||
            extra.length ||
            !['ui12', 'ui16', 'ui24'].includes(value ?? '')
          ) {
            this.fail('model_mismatch');
            return false;
          }
          this.reported = value as 'ui12' | 'ui16' | 'ui24';
          if (this.reported !== 'ui16') {
            this.fail('model_mismatch');
            return false;
          }
        }
        if (kind === 'SETD') {
          // Exact names come from library 7.1.0. No GET/read-back message is invented.
          for (const key of this.watched)
            if (this.path(key) === path)
              this.received.set(key, {
                at,
                generation: this.supervisor.generation(),
                sequence,
              });
        }
      }
    queueMicrotask(() => this.announce());
    return true;
  }
  private monophonic(key: ParamKey) {
    const p = parseKey(key);
    if (p.kind !== 'channel' || !p.aux) return false;
    return [
      `i.${p.channel - 1}.stereoIndex`,
      `a.${p.aux - 1}.stereoIndex`,
    ].every((path) => {
      const sample = this.stereo.get(path);
      return (
        sample?.value === -1 &&
        sample.generation === this.supervisor.generation() &&
        this.now() - sample.at >= 0 &&
        this.now() - sample.at <= (this.auxHandshake.gate?.freshnessMs ?? 3000)
      );
    });
  }
  private independentInput(data: unknown) {
    if (typeof data !== 'string' || !data.startsWith('3:::')) return;
    for (const line of data.slice(4).split('\n')) {
      const [kind, path, raw, ...extra] = line.split('^');
      if (!/^[ia]\.\d+\.stereoIndex$/.test(path ?? '')) continue;
      if (
        kind !== 'SETD' ||
        extra.length ||
        !['-1', '0', '1'].includes(raw ?? '')
      ) {
        this.fail('invalid_sample');
        return;
      }
      this.stereo.set(path!, {
        value: Number(raw),
        at: this.now(),
        generation: this.supervisor.generation(),
      });
    }
    this.auxHandshake.configurationChanged();
    for (const line of data.slice(4).split('\n')) {
      const match = /^SETD\^i\.(\d+)\.aux\.(\d+)\.value\^(.+)$/.exec(line);
      if (!match) continue;
      const key: ParamKey = `ch.${Number(match[1]) + 1}.aux.${Number(match[2]) + 1}.level`;
      if (!this.watched.has(key)) continue;
      const seen = this.received.get(key);
      if (!seen) continue;
      const sample: AuxObservation = {
        ...seen,
        value: faderValueToDB(Number(match[3])),
      };
      const previous = this.independentAux.get(key);
      this.independentAux.set(key, sample);
      this.history.set(key, {
        value: sample.value,
        at: sample.at,
        generation: sample.generation,
      });
      this.auxHandshake.observe(key, sample);
      {
        if (this.supervisor.generation() !== sample.generation || this.fault)
          return;
        if (
          !previous ||
          previous.value !== sample.value ||
          previous.generation !== sample.generation
        )
          for (const listener of this.paramListeners)
            listener(
              key,
              sample.value,
              previous?.generation === sample.generation
                ? 'external'
                : 'resync',
            );
      }
    }
  }
  override onParamChange(
    listener: (
      key: ParamKey,
      value: ParamValue,
      origin: import('./types.js').ParamChangeOrigin,
    ) => void,
  ) {
    this.paramListeners.add(listener);
    return () => this.paramListeners.delete(listener);
  }
  private path(key: ParamKey): string | undefined {
    const p = parseKey(key);
    if (p.kind === 'master') return 'm.mix';
    if (p.kind === 'channel')
      return `i.${p.channel - 1}.${p.aux ? `aux.${p.aux - 1}.${p.param === 'level' ? 'value' : 'mute'}` : p.param === 'level' ? 'mix' : 'mute'}`;
    if (p.kind === 'eq') return `i.${p.channel - 1}.eq.b${p.band}.${p.param}`;
    if (p.kind === 'eqBypass') return `i.${p.channel - 1}.eq.bypass`;
    if (p.kind === 'hpf' && p.param === 'freq')
      return `i.${p.channel - 1}.eq.hpf.freq`;
    return undefined;
  }
  private checkSilence() {
    const base = super.link();
    if (
      ['READY', 'DEGRADED_READ_ONLY', 'SYNCING'].includes(base) &&
      this.now() - this.lastInbound > this.silenceMs &&
      !this.quarantined
    ) {
      this.quarantined = true;
      this.fence = this.sequence + 1;
    }
    if (
      this.quarantined &&
      this.required.length > 0 &&
      this.required.every(
        (k) => (this.received.get(k)?.sequence ?? -Infinity) >= this.fence,
      )
    )
      this.quarantined = false;
  }
  override link(): LinkState {
    this.checkSilence();
    return this.fault ? 'STOPPED' : this.quarantined ? 'SYNCING' : super.link();
  }
  private announce() {
    const state = this.link();
    if (state !== this.announced) {
      this.announced = state;
      for (const l of this.listeners) l(state);
    }
  }
  override onLinkChange(listener: (state: LinkState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  override async connect() {
    if (this.fault) throw Error('BRIDGE_SEALED');
    if (!this.timer)
      this.timer = setInterval(
        () => this.announce(),
        Math.min(1000, this.silenceMs),
      );
    await super.connect();
  }
  override async disconnect() {
    clearInterval(this.timer);
    this.timer = undefined;
    await super.disconnect();
  }
  async resynchronize() {
    if (this.fault) throw Error('BRIDGE_SEALED');
    await this.disconnect();
    await this.connect();
  }
  identity() {
    return {
      configuredModel: 'ui16' as const,
      reportedModel: this.reported ?? 'unknown',
      verification:
        this.reported === 'ui16'
          ? 'device_reported_not_authenticated'
          : 'unconfirmed',
      physicalWrite: this.auxHandshake.enabled()
        ? 'aux_only_bootstrap_gate'
        : 'blocked',
    };
  }
  reading(key: ParamKey): BridgeReading {
    const base = {
      key,
      generation: this.supervisor.generation(),
      source: 'device_stream' as const,
      hardwareValidation: 'pending' as const,
    };
    const lastObserved = this.history.get(key);
    if (this.fault)
      return { ...base, state: 'unavailable', reason: this.fault };
    if (!this.watched.has(key) || !this.path(key))
      return { ...base, state: 'unavailable', reason: 'unsupported' };
    const link = super.link();
    if (!['READY', 'DEGRADED_READ_ONLY', 'SYNCING'].includes(link))
      return lastObserved
        ? { ...base, state: 'stale', lastObserved, reason: 'disconnected' }
        : { ...base, state: 'unavailable', reason: 'disconnected' };
    this.checkSilence();
    const seen = this.received.get(key);
    if (this.fence !== -Infinity && (!seen || seen.sequence < this.fence))
      return {
        ...base,
        state: lastObserved ? 'stale' : 'unavailable',
        ...(lastObserved ? { lastObserved } : {}),
        reason: 'inbound_silence',
      };
    if (this.auxHandshake.pending(key))
      return {
        ...base,
        state: 'pending',
        ...(lastObserved ? { lastObserved } : {}),
        reason: 'write_pending',
      };
    if (seen && this.auxHandshake.stale(key, seen.sequence))
      return {
        ...base,
        state: 'stale',
        ...(lastObserved ? { lastObserved } : {}),
        reason: 'write_unconfirmed',
      };
    const rawAux = this.independentAux.get(key);
    const value = isAuxLevel(key)
      ? rawAux
        ? { known: true as const, value: rawAux.value }
        : { known: false as const }
      : super.read(key);
    if (!seen || !value.known)
      return {
        ...base,
        state: 'pending',
        ...(lastObserved ? { lastObserved } : {}),
        reason: 'not_received',
      };
    if (this.registry.validate(key, value.value))
      return { ...base, state: 'unavailable', reason: 'invalid_sample' };
    const observation = {
      value: value.value,
      at: seen.at,
      generation: seen.generation,
    };
    this.history.set(key, observation);
    return {
      ...base,
      state: 'confirmed',
      value: value.value,
      lastObserved: observation,
    };
  }
  override read(key: ParamKey): ReadResult {
    const r = this.reading(key);
    return r.state === 'confirmed'
      ? { known: true, value: r.value! }
      : { known: false };
  }
  override channelName(channel: number) {
    return ['READY', 'DEGRADED_READ_ONLY'].includes(this.link()) &&
      !this.quarantined
      ? super.channelName(channel)
      : undefined;
  }
  override statusText() {
    return `Ui16 bridge · ${this.link()} · identificação ${this.identity().verification} · ${this.auxHandshake.enabled() ? 'AUX 1 dB: confirmação humana obrigatória' : 'SOMENTE LEITURA'}`;
  }
  override async write(key: ParamKey, value: ParamValue): Promise<'observed'> {
    if (
      !this.auxHandshake.enabled() ||
      !isAuxLevel(key) ||
      typeof value !== 'number' ||
      this.registry.validate(key, value)
    )
      throw new PhysicalWriteBlockedError();
    return this.auxHandshake.write(key, value);
  }
  override async loadSnapshot(
    _show: string,
    _snapshot: string,
  ): Promise<never> {
    throw new PhysicalWriteBlockedError();
  }
}
