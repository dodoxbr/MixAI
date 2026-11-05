import { ParamRegistry } from '../core/params.js';
import type { ParamKey, ParamValue } from '../core/revisions.js';
import {
  LinkUnavailableError,
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

export const UI16_CAPS: MixerCapabilities = { model: 'ui16', inputs: 12, aux: 6 };

/**
 * Base comum das mesas simuladas (MockMixer para testes, LabMixer persistente).
 * Não importa nada de rede nem da biblioteca da Soundcraft: é impossível uma mesa simulada
 * falar com a mesa física.
 */
export abstract class SimulatedMixer implements MixerAdapter {
  abstract readonly mode: 'mock' | 'lab';
  readonly registry: ParamRegistry;
  protected state: LinkState = 'DISCONNECTED';
  protected values = new Map<ParamKey, ParamValue>();
  protected shows: ShowList;
  protected current: { show?: string; snapshot?: string } = {};
  private changeListeners = new Set<ChangeListener>();
  private verificationListeners = new Set<(r: VerificationReport[]) => void>();
  private linkListeners = new Set<(s: LinkState) => void>();

  constructor(
    protected caps: MixerCapabilities = UI16_CAPS,
    shows: ShowList = { Pagode: ['Ensaio', 'Bar'] },
  ) {
    this.registry = new ParamRegistry(caps);
    this.shows = shows;
    for (const spec of this.registry.specs()) this.values.set(spec.key, spec.labDefault);
  }

  // ---------- contrato ----------

  async connect() {
    this.setLink('READY');
  }
  async disconnect() {
    this.setLink('DISCONNECTED');
  }
  link() {
    return this.state;
  }
  capabilities() {
    return this.caps;
  }
  abstract statusText(): string;

  read(key: ParamKey): ReadResult {
    if (this.state !== 'READY' && this.state !== 'DEGRADED_READ_ONLY') return { known: false };
    const v = this.values.get(key);
    return v === undefined ? { known: false } : { known: true, value: v };
  }

  async write(key: ParamKey, value: ParamValue): Promise<WriteOutcome> {
    if (this.state !== 'READY') throw new LinkUnavailableError(this.state);
    this.beforeWrite(key, value);
    const problem = this.registry.validate(key, value);
    if (problem) throw new Error(`Valor recusado pela mesa simulada: ${problem}`);
    this.values.set(key, value);
    this.afterWrite(key, value);
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
  onLinkChange(listener: (s: LinkState) => void) {
    this.linkListeners.add(listener);
    return () => this.linkListeners.delete(listener);
  }

  channelName(_channel: number): string | undefined {
    return undefined;
  }
  async listShows() {
    return this.shows;
  }
  async currentSnapshot() {
    return { ...this.current };
  }
  async loadSnapshot(show: string, snapshot: string): Promise<WriteOutcome> {
    if (this.state !== 'READY') throw new LinkUnavailableError(this.state);
    this.beforeSnapshot();
    if (!this.shows[show]?.includes(snapshot)) throw new Error(`Snapshot "${snapshot}" não existe no show "${show}"`);
    this.current = { show, snapshot };
    this.afterSnapshot(show, snapshot);
    return 'applied_simulated';
  }

  // ---------- ganchos para as subclasses ----------

  /** Pode lançar erro para simular falhas (MockMixer). */
  protected beforeWrite(_key: ParamKey, _value: ParamValue): void {}
  protected afterWrite(_key: ParamKey, _value: ParamValue): void {}
  protected beforeSnapshot(): void {}
  protected afterSnapshot(_show: string, _snapshot: string): void {}

  protected setLink(s: LinkState) {
    if (this.state === s) return;
    this.state = s;
    for (const l of this.linkListeners) l(s);
  }

  protected emitChange(key: ParamKey, value: ParamValue, origin: ParamChangeOrigin) {
    for (const l of this.changeListeners) l(key, value, origin);
  }

  protected emitVerification(reports: VerificationReport[]) {
    for (const l of this.verificationListeners) l(reports);
  }
}
