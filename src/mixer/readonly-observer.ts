import { ParamRegistry } from '../core/params.js';
import { isObserverPrivateIP, type ObserverTransport } from './observer-network.js';
import { sameValue, type ParamKey, type ParamValue } from '../core/revisions.js';
import { encodeValue } from '../core/state.js';
import { RealMixer } from './real.js';
import { observerSocketGate, type ObserverSocketCtor } from './readonly-socket.js';
import { MAX_OBSERVER_BYTES, observerKeys, parseCurrentObserverReport, ScopeSchema, type ObserverEvent, type ObserverReading, type ObserverReport, type ObserverScope, type ObserverStopReason } from './observer-report.js';
import type { LinkState } from './types.js';

type Target = { source: 'fake_websocket'; webSocketCtor: unknown; transport?: ObserverTransport; routeGuard?: () => boolean } |
  { source: 'manual_device_stream'; ethernetConfirmed: true; transport?: never; routeGuard?: never; audioDisconnected: true; webSocketCtor?: never } |
  { source: 'manual_device_stream'; transport: ObserverTransport; ipConfirmed: true; hotspotConfirmed?: true; routeGuard: () => boolean; ethernetConfirmed?: never; audioDisconnected: true; webSocketCtor?: never };
export type ObserverOptions = Target & {
  ip: string; scope: ObserverScope; appVersion: string;
  durationMs?: number; maxEvents?: number;
  /** Tempos/relógio injetáveis para ensaios determinísticos, nunca desabilitam gates. */
  clock?: () => number; connectTimeoutMs?: number; syncTimeoutMs?: number;
  reconnectBaseMs?: number; reconnectMaxDelayMs?: number; recoveryTimeoutMs?: number; zombieWatchMs?: number;
  onEvent?: (event: ObserverEvent) => void;
};

/** Alias retrocompatível: o endereço é privado, não comprova tipo de interface. */
export const isObserverEthernetIP = isObserverPrivateIP;

/** Sessão de observação, sem API de escrita e sem segundo controlador/implementação RealMixer. */
export class Ui16ReadOnlyObserver {
  #mixer: RealMixer;
  #gate: ReturnType<typeof observerSocketGate>;
  #opts: ObserverOptions;
  #keys: ParamKey[];
  #scope: ObserverScope;
  #registry = new ParamRegistry({ model: 'ui16', inputs: 12, aux: 6 });
  #values = new Map<ParamKey, ParamValue>();
  #invalid = new Set<ParamKey>();
  #events: ObserverEvent[] = [];
  #bytes = 0;
  #generation = 0;
  #duplicates = 0;
  #started = false;
  #stopping: Promise<void> | undefined;
  #ended = false;
  #reason: ObserverStopReason | null = null;
  #startTime = 0;
  #elapsed = 0;
  #clock: () => number;
  #duration: number;
  #limit: number;
  #timer: NodeJS.Timeout | undefined;
  #recovery: NodeJS.Timeout | undefined;
  #unsub: Array<() => void> = [];
  #resolveEnd!: () => void;
  readonly done = new Promise<void>((resolve) => { this.#resolveEnd = resolve; });

  constructor(opts: ObserverOptions) {
    const scope = ScopeSchema.safeParse(opts.scope);
    const duration = opts.durationMs ?? 60_000, limit = opts.maxEvents ?? 500;
    if (!scope.success || !/^\d+\.\d+\.\d+$/.test(opts.appVersion) || opts.appVersion.length > 32 ||
      !Number.isInteger(duration) || duration < 1 || duration > 900_000 || !Number.isInteger(limit) || limit < 8 || limit > 2000) throw new Error('F0C_INVALID_OPTIONS');
    if (opts.transport !== undefined && !['ethernet', 'wifi'].includes(opts.transport)) throw new Error('F0D_INVALID_TRANSPORT');
    if (opts.source === 'manual_device_stream') {
      const legacy = opts.transport === undefined && opts.ethernetConfirmed === true && opts.routeGuard === undefined && !('ipConfirmed' in opts) && !('hotspotConfirmed' in opts);
      const explicit = opts.ethernetConfirmed === undefined && 'ipConfirmed' in opts && opts.ipConfirmed === true &&
        typeof opts.routeGuard === 'function' && (opts.transport === 'ethernet' && opts.hotspotConfirmed === undefined || opts.transport === 'wifi' && opts.hotspotConfirmed === true);
      if ((!legacy && !explicit) || opts.audioDisconnected !== true || opts.webSocketCtor !== undefined || !isObserverPrivateIP(opts.ip)) throw new Error('F0C_MANUAL_GATE_REQUIRED');
    }
    for (const time of [opts.connectTimeoutMs, opts.syncTimeoutMs, opts.reconnectBaseMs, opts.reconnectMaxDelayMs, opts.recoveryTimeoutMs]) {
      if (time !== undefined && (!Number.isInteger(time) || time < 1 || time > 900_000)) throw new Error('F0C_INVALID_OPTIONS');
    }
    if (opts.source !== 'fake_websocket' && opts.source !== 'manual_device_stream') throw new Error('F0C_INVALID_SOURCE');
    const Base = opts.source === 'fake_websocket' ? opts.webSocketCtor : globalThis.WebSocket;
    if (typeof Base !== 'function') throw new Error('F0C_SOCKET_REQUIRED');
    this.#opts = { ...opts }; this.#scope = scope.data; this.#keys = observerKeys(scope.data);
    this.#duration = duration; this.#limit = limit; this.#clock = opts.clock ?? (() => performance.now());
    this.#gate = observerSocketGate(Base as ObserverSocketCtor, () => {
      this.#record({ type: 'safety', reason: 'outbound_blocked' });
      void this.stop('outbound_blocked');
    }, { keys: this.#keys, onInvalid: (key) => {
      this.#values.delete(key); this.#invalid.add(key);
      this.#record({ type: 'parameter', origin: this.#mixer.link() === 'READY' ? 'external' : 'resync', sample: { key, reading: { state: 'unknown', reason: 'invalid_value' } } });
      this.#record({ type: 'safety', reason: 'invalid_sample' });
      void this.stop('invalid_sample');
    } }, opts.routeGuard ? { check: opts.routeGuard, onMismatch: () => {
      this.#record({ type: 'safety', reason: 'route_mismatch' });
      void this.stop('route_mismatch');
    } } : undefined);
    this.#mixer = new RealMixer({ ip: opts.ip, model: 'ui16', readOnly: true,
      requiredKeys: [...this.#keys], watchedKeys: [...this.#keys], nameChannels: [], webSocketCtor: this.#gate.Ctor,
      connectTimeoutMs: opts.connectTimeoutMs, syncTimeoutMs: opts.syncTimeoutMs,
      reconnectBaseMs: opts.reconnectBaseMs, reconnectMaxDelayMs: opts.reconnectMaxDelayMs, zombieWatchMs: opts.zombieWatchMs });
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopping) throw new Error('F0C_SESSION_ALREADY_USED');
    this.#started = true; this.#startTime = this.#clock();
    this.#unsub.push(this.#mixer.onLinkChange((link) => this.#link(link)));
    this.#unsub.push(this.#mixer.onParamChange((key, value, origin) => {
      if (this.#stopping || !this.#keys.includes(key)) return;
      if (this.#registry.validate(key, value)) {
        this.#values.delete(key); this.#invalid.add(key);
      } else {
        if (this.#values.has(key) && sameValue(this.#values.get(key), value)) { this.#duplicates++; return; }
        this.#invalid.delete(key); this.#values.set(key, value);
      }
      this.#record({ type: 'parameter', origin, sample: { key, reading: this.#reading(key) } });
    }));
    this.#timer = setTimeout(() => { void this.stop('duration'); }, this.#duration);
    try { await this.#mixer.connect(); }
    catch { await this.stop('connect_failed'); throw new Error('F0C_CONNECT_FAILED'); }
  }

  stop(reason: ObserverStopReason = 'operator'): Promise<void> {
    if (this.#stopping) return this.#stopping;
    // Promise adiada: sela e desassina antes do disconnect, sem reentrância no callback de link.
    this.#stopping = Promise.resolve().then(async () => {
      await this.#mixer.disconnect();
      this.#events.push({ index: this.#events.length, elapsedMs: this.#time(), generation: this.#generation, type: 'end', reason, link: 'DISCONNECTED' });
      this.#ended = true; this.#reason = reason; this.#values.clear(); this.#invalid.clear(); this.#resolveEnd();
    });
    this.#gate.seal();
    clearTimeout(this.#timer); clearTimeout(this.#recovery);
    for (const off of this.#unsub.splice(0)) off();
    return this.#stopping;
  }

  report(): ObserverReport {
    const counters = { link: 0, parameter: 0, snapshot: 0, safety: 0, end: 0, duplicatesSuppressed: this.#duplicates };
    for (const e of this.#events) counters[e.type]++;
    return parseCurrentObserverReport({ schemaVersion: 2, kind: 'mixai-f0c-readonly-evidence',
      transport: this.#opts.transport ?? 'ethernet', routeCheck: this.#opts.source === 'fake_websocket' ? 'simulated' : this.#opts.routeGuard ? 'each_connection_gate' : 'legacy_ethernet_declaration',
      appVersion: this.#opts.appVersion, libraryVersion: '7.1.0', source: this.#opts.source, readOnly: true,
      hardwareValidation: 'pending', configuredModel: 'ui16', auxPhysicalSupport: 'not_verified', scope: this.#scope,
      excludedCapabilities: ['eq_hpf_simulated_only', 'preamp_phantom_not_monitored', 'physical_aux_routing_unverified'],
      ended: this.#ended, stopReason: this.#reason, elapsedMs: this.#time(), maxEvents: this.#limit, counters, events: this.#events });
  }

  #time() {
    if (this.#ended) return this.#elapsed;
    const delta = this.#started ? this.#clock() - this.#startTime : 0;
    this.#elapsed = Math.max(this.#elapsed, Number.isFinite(delta) ? Math.round(delta) : 0);
    return this.#elapsed;
  }
  #reading(key: ParamKey): ObserverReading {
    if (this.#invalid.has(key)) return { state: 'unknown', reason: 'invalid_value' };
    const value = this.#values.get(key);
    return value === undefined ? { state: 'unknown', reason: 'not_received' } : { state: 'observed', value: encodeValue(value) };
  }
  #link(link: LinkState) {
    if (this.#stopping) return;
    if (link === 'CONNECTING') { this.#generation++; this.#values.clear(); this.#invalid.clear(); }
    if (['LOST', 'STOPPED', 'DISCONNECTED'].includes(link)) { this.#values.clear(); this.#invalid.clear(); }
    this.#record({ type: 'link', link });
    if (this.#stopping) return;
    if (link === 'LOST' || link === 'STOPPED') this.#gate.closeSockets();
    if (['READY', 'DEGRADED_READ_ONLY', 'LOST', 'STOPPED', 'DISCONNECTED'].includes(link)) {
      const readable = link === 'READY' || link === 'DEGRADED_READ_ONLY';
      const samples = this.#keys.map((key) => ({ key, reading: readable ? this.#reading(key) : { state: 'unavailable' as const } }));
      this.#record({ type: 'snapshot', link, complete: samples.every((s) => s.reading.state === 'observed'), samples });
    }
    if (this.#stopping) return;
    if (link === 'LOST') {
      this.#recovery ??= setTimeout(() => { void this.stop('recovery_timeout'); }, this.#opts.recoveryTimeoutMs ?? 30_000);
    } else if (link === 'READY' || link === 'DEGRADED_READ_ONLY') { clearTimeout(this.#recovery); this.#recovery = undefined; }
    if (link === 'STOPPED') void this.stop('supervisor_stopped');
  }
  #record(data: ObserverEvent extends infer E ? E extends ObserverEvent ? Omit<E, 'index' | 'elapsedMs' | 'generation'> : never : never) {
    if (this.#stopping) return;
    if (this.#events.length >= this.#limit - 1) { void this.stop('event_limit'); return; }
    const event = { ...data, index: this.#events.length, elapsedMs: this.#time(), generation: this.#generation } as ObserverEvent;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (this.#bytes + size > MAX_OBSERVER_BYTES - 8192) { void this.stop('event_limit'); return; }
    this.#bytes += size;
    this.#events.push(event);
    try { this.#opts.onEvent?.(structuredClone(event)); }
    catch { void this.stop('output_error'); }
  }
}
