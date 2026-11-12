import {
  controlCategory,
  controlFrame,
  validControlChange,
  type Ui16ControlCategory,
  type Ui16ControlGates,
} from './ui16-controls.js';
import { sameValue, type ParamKey, type ParamValue } from '../core/revisions.js';
import { LinkUnavailableError, type LinkState } from './types.js';

/** Bootstrap capability, never read from HTTP, an AI response or mixer state. Absent by default. */
export interface FirstRealAuxGate {
  validation: 'simulated_transport' | 'supervised_protocol';
  validationReference: string;
  routeGuard: () => boolean;
  freshnessMs?: number;
  confirmationTimeoutMs?: number;
}
export interface AuxObservation<T extends ParamValue = ParamValue> {
  value: T;
  raw?: number;
  at: number;
  generation: number;
  sequence: number;
}
export interface AuxAuthorization<T extends ParamValue = ParamValue> {
  id: string;
  key: ParamKey;
  previous: AuxObservation<T>;
  requested: T;
  authorized: () => boolean;
}
export interface AuxWriteReport<T extends ParamValue = ParamValue> {
  category: Ui16ControlCategory | 'processing';
  id: string;
  key: ParamKey;
  previous: T;
  requested: T;
  observed: T | '-inf' | null;
  status: 'observed_target' | 'unconfirmed' | 'not_sent';
  reason:
    | 'new_inbound_sample'
    | 'timeout'
    | 'different_value'
    | 'connection_changed'
    | 'authorization_revoked'
    | 'send_error'
    | 'configuration_changed';
  generation: number;
  source: 'independent_socket_input';
  validation: FirstRealAuxGate['validation'];
  /** No wire ACK, operation ID or device timestamp: convergence is not proof of causality. */
  causalAcknowledgement: false;
}
export class AuxNotSentError extends LinkUnavailableError {
  constructor(reason = 'F0_READ_ONLY: BRIDGE_PHYSICAL_WRITE_UNVALIDATED') {
    super('DEGRADED_READ_ONLY');
    this.message = reason;
  }
}
export class AuxUnconfirmedError<T extends ParamValue = ParamValue> extends Error {
  constructor(readonly report: AuxWriteReport<T>) {
    super(
      `${report.category === 'processing' ? 'PROCESSING' : 'AUX'}_WRITE_UNCONFIRMED:${report.reason}`,
    );
  }
}
export const isAuxLevel = (key: ParamKey) => /^ch\.[1-9]\d*\.aux\.[1-9]\d*\.level$/.test(key);

/** Shared PR #100 handshake, extended by category. Historical name preserves its single implementation.
 * Execution/serialization/undo remain owned by MixController/ServerCore. */
export class Ui16AuxHandshake<T extends ParamValue = ParamValue> {
  private permit?: AuxAuthorization<T>;
  private flight?: {
    permit: AuxAuthorization<T>;
    sent: boolean;
    deadline: number;
    candidate?: AuxObservation<T>;
    frame: string;
    resolve: () => void;
    reject: (e: Error) => void;
    timer?: NodeJS.Timeout;
  };
  private reports = new Map<string, AuxWriteReport<T>>();
  private uncertain = new Map<ParamKey, number>();
  constructor(
    gate: FirstRealAuxGate | undefined,
    private ports: {
      now(): number;
      connected(): boolean;
      link(): LinkState;
      identified(): boolean;
      monophonic(key: ParamKey): boolean;
      observation(key: ParamKey): AuxObservation<T> | undefined;
      send(key: ParamKey, value: T): void;
    },
    controls: Ui16ControlGates = {},
    private profile?: {
      category: 'processing';
      accepts(key: ParamKey): boolean;
      probeKey: ParamKey;
      valid(key: ParamKey, previous: T, target: T): boolean;
      frame(key: ParamKey, value: T): string;
      same(a: T, b: T): boolean;
    },
  ) {
    if (profile && Object.keys(controls).length)
      throw Error('PROCESSING_CONTROL_GATES_MUST_BE_SEPARATE');
    if (gate && controls.aux_level) throw Error('AUX_DUPLICATE_BOOTSTRAP_GATE');
    const entries = { ...controls, ...(gate ? { aux_level: gate } : {}) };
    if (controls.master_level && controls.master_level.enabled !== false)
      throw Error('MASTER_CONTROL_DISABLED');
    for (const category of Object.keys(entries))
      if (!['pa_level', 'pa_mute', 'aux_level', 'aux_mute', 'master_level'].includes(category))
        throw Error('UI16_UNKNOWN_CAPABILITY');
    const validated: Ui16ControlGates = {};
    for (const category of ['pa_level', 'pa_mute', 'aux_level', 'aux_mute'] as const) {
      const gate = entries[category];
      if (
        gate &&
        (!['simulated_transport', 'supervised_protocol'].includes(gate.validation) ||
          !/^[A-Za-z0-9._/-]{1,120}$/.test(gate.validationReference) ||
          typeof gate.routeGuard !== 'function' ||
          !Number.isInteger(gate.freshnessMs ?? 3000) ||
          (gate.freshnessMs ?? 3000) < 10 ||
          (gate.freshnessMs ?? 3000) > 30000 ||
          !Number.isInteger(gate.confirmationTimeoutMs ?? 1500) ||
          (gate.confirmationTimeoutMs ?? 1500) < 10 ||
          (gate.confirmationTimeoutMs ?? 1500) > 10000)
      )
        throw Error('AUX_INVALID_BOOTSTRAP_GATE');
      if (gate) validated[category] = Object.freeze({ ...gate });
    }
    // Validate using the same gate rules, but never install a processing gate as AUX.
    this.gates = Object.freeze(profile ? {} : validated);
    this.gate = profile ? validated.aux_level : this.gates.aux_level;
  }
  readonly gate: FirstRealAuxGate | undefined;
  private readonly gates: Ui16ControlGates;
  private equal(a: T, b: T) {
    return this.profile ? this.profile.same(a, b) : sameValue(a, b);
  }
  private frame(key: ParamKey, value: T) {
    return this.profile
      ? this.profile.accepts(key)
        ? this.profile.frame(key, value)
        : undefined
      : controlFrame(key, value);
  }
  gateFor(key: ParamKey): FirstRealAuxGate | undefined {
    if (this.profile) return this.profile.accepts(key) ? this.gate : undefined;
    const category = controlCategory(key);
    return category && category !== 'master_level' ? this.gates[category] : undefined;
  }
  enabled(key?: ParamKey) {
    return key
      ? !!this.gateFor(key)
      : this.profile
        ? !!this.gate
        : Object.keys(this.gates).length > 0;
  }
  available(key?: ParamKey): boolean {
    if (!key && this.profile) return this.available(this.profile.probeKey);
    if (!key)
      return ['ch.1.main.level', 'ch.1.main.mute', 'ch.1.aux.1.level', 'ch.1.aux.1.mute'].some(
        (k) => this.available(k as ParamKey),
      );
    const gate = this.gateFor(key);
    if (
      !gate ||
      this.ports.link() !== 'READY' ||
      !this.ports.connected() ||
      !this.ports.identified()
    )
      return false;
    try {
      return gate.routeGuard() === true;
    } catch {
      return false;
    }
  }
  current(key: ParamKey): AuxObservation<T> | undefined {
    const sample = this.ports.observation(key);
    return this.available(key) &&
      this.ports.monophonic(key) &&
      sample &&
      this.ports.now() - sample.at >= 0 &&
      this.ports.now() - sample.at <= (this.gateFor(key)?.freshnessMs ?? 3000) &&
      !this.stale(key, sample.sequence)
      ? { ...sample }
      : undefined;
  }
  stale(key: ParamKey, sequence: number) {
    return sequence <= (this.uncertain.get(key) ?? -Infinity);
  }
  pending(key: ParamKey) {
    return this.flight?.permit.key === key;
  }
  authorize(p: AuxAuthorization<T>) {
    const sample = this.current(p.key);
    if (
      this.permit ||
      this.flight ||
      !this.frame(p.key, p.requested) ||
      !sample ||
      !p.authorized() ||
      sample.generation !== p.previous.generation ||
      sample.sequence !== p.previous.sequence ||
      !this.equal(sample.value, p.previous.value) ||
      !(this.profile
        ? this.profile.valid(p.key, p.previous.value, p.requested)
        : validControlChange(p.key, p.previous.value, p.requested)) ||
      this.equal(p.requested, p.previous.value)
    )
      throw new AuxNotSentError('AUX_AUTHORIZATION_STALE');
    const permit = { ...p, previous: { ...p.previous } };
    this.permit = permit;
    // Issued inside the existing queue: consume synchronously or expire before another task.
    queueMicrotask(() => {
      if (this.permit === permit) this.permit = undefined;
    });
  }
  /** The transport consumes precisely ONE precomputed SETD, never a free-form client payload. */
  allowFrame(data: unknown) {
    const f = this.flight;
    if (!f || f.sent || data !== f.frame || !this.available(f.permit.key) || !f.permit.authorized())
      return false;
    const sample = this.current(f.permit.key);
    if (
      !sample ||
      sample.sequence !== f.permit.previous.sequence ||
      sample.generation !== f.permit.previous.generation
    )
      return false;
    f.sent = true;
    return true;
  }
  async write(key: ParamKey, value: T): Promise<'observed'> {
    const p = this.permit;
    this.permit = undefined;
    if (
      !p ||
      this.flight ||
      p.key !== key ||
      value !== p.requested ||
      !this.current(key) ||
      !p.authorized()
    )
      throw new AuxNotSentError();
    const sample = this.current(key)!;
    if (sample.sequence !== p.previous.sequence || sample.generation !== p.previous.generation)
      throw new AuxNotSentError('AUX_AUTHORIZATION_STALE');
    const frame = this.frame(key, value);
    if (!frame) throw new AuxNotSentError();
    const completed = new Promise<void>((resolve, reject) => {
      this.flight = {
        permit: p,
        sent: false,
        deadline: this.ports.now() + (this.gateFor(key)!.confirmationTimeoutMs ?? 1500),
        frame,
        resolve,
        reject,
      };
    });
    const f = this.flight!;
    f.timer = setTimeout(
      () => this.finish('timeout'),
      this.gateFor(key)!.confirmationTimeoutMs ?? 1500,
    );
    try {
      this.ports.send(key, value);
    } catch {
      this.finish('send_error');
    }
    await completed;
    return 'observed';
  }
  observe(key: ParamKey, sample: AuxObservation<T>) {
    const f = this.flight;
    if (!f || !f.sent || key !== f.permit.key || sample.sequence <= f.permit.previous.sequence)
      return;
    if (sample.at >= f.deadline) {
      this.finish('timeout', sample);
      return;
    }
    if (sample.generation !== f.permit.previous.generation) {
      this.finish('connection_changed');
      return;
    }
    if (!this.ports.monophonic(key)) {
      this.finish('configuration_changed', sample);
      return;
    }
    if (!f.permit.authorized()) {
      this.finish('authorization_revoked', sample);
      return;
    }
    if (!this.equal(sample.value, f.permit.requested)) {
      this.finish('different_value', sample);
      return;
    }
    // Coalesce a complete incoming batch before success; another field update can invalidate it.
    f.candidate = sample;
    queueMicrotask(() => {
      if (this.flight !== f || f.candidate !== sample) return;
      const latest = this.ports.observation(key);
      if (this.ports.now() >= f.deadline) {
        this.finish('timeout', latest);
        return;
      }
      if (!f.permit.authorized()) {
        this.finish('authorization_revoked', latest);
        return;
      }
      if (!this.available(key)) {
        this.finish('connection_changed', latest);
        return;
      }
      if (!this.ports.monophonic(key)) {
        this.finish('configuration_changed', latest);
        return;
      }
      this.finish(
        latest &&
          latest.generation === sample.generation &&
          this.equal(latest.value, f.permit.requested)
          ? 'new_inbound_sample'
          : 'different_value',
        latest,
      );
    });
  }
  cancelAuthorization(id: string) {
    if (this.permit?.id === id) this.permit = undefined;
  }
  configurationChanged() {
    if (this.flight && !this.ports.monophonic(this.flight.permit.key))
      this.finish('configuration_changed');
  }
  connectionChanged() {
    this.permit = undefined;
    if (this.flight) this.finish('connection_changed');
  }
  report(id: string) {
    const r = this.reports.get(id);
    return r ? { ...r } : undefined;
  }
  private finish(reason: AuxWriteReport['reason'], sample?: AuxObservation<T>) {
    const f = this.flight;
    if (!f) return;
    clearTimeout(f.timer);
    this.flight = undefined;
    const status =
      reason === 'new_inbound_sample' ? 'observed_target' : f.sent ? 'unconfirmed' : 'not_sent';
    const report: AuxWriteReport<T> = {
      id: f.permit.id,
      category: this.profile?.category ?? controlCategory(f.permit.key)!,
      key: f.permit.key,
      previous: f.permit.previous.value,
      requested: f.permit.requested,
      observed: sample ? (sample.value === -Infinity ? '-inf' : sample.value) : null,
      status,
      reason,
      generation: f.permit.previous.generation,
      source: 'independent_socket_input',
      validation: this.gateFor(f.permit.key)!.validation,
      causalAcknowledgement: false,
    };
    this.reports.set(report.id, report);
    if (this.reports.size > 100) this.reports.delete(this.reports.keys().next().value!);
    if (status === 'observed_target') {
      f.resolve();
      return;
    }
    this.uncertain.set(report.key, sample?.sequence ?? f.permit.previous.sequence);
    if (!f.sent) {
      f.reject(new AuxNotSentError('AUX_NOT_SENT'));
      return;
    }
    f.reject(new AuxUnconfirmedError(report));
  }
}
