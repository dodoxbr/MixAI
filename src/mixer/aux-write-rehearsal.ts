import {
  sameValue,
  type ParamKey,
  type ParamValue,
} from '../core/revisions.js';
import { SimulatedMixer } from './simulated.js';
import type { MixerAdapter, WriteOutcome } from './types.js';

export interface AuxRehearsalPermit {
  requestId: string;
  role: 'operator';
  humanConfirmed: true;
  channel: number;
  aux: number;
  fromDB: number;
  toDB: number;
  /** Server-owned check of the authenticated session/permission, never supplied by model/client. */
  authorized: () => boolean;
}

/**
 * Unwired rehearsal infrastructure. Feed `mixer` to the existing controller to retain
 * its queue, ceilings, revisions and undo. No transport, HTTP route or REAL capability.
 * An undo needs a NEW human permit for the reverse AUX change, through the same controller.
 */
export function createAuxWriteRehearsal(simulated: SimulatedMixer) {
  if (
    !(simulated instanceof SimulatedMixer) ||
    !['lab', 'mock'].includes(simulated.mode)
  )
    throw Error('SIMULATION_ONLY');
  let permit: AuxRehearsalPermit | undefined;
  let busy = false;
  let uncertain = false;
  let expiresAt = 0;
  const used = new Set<string>();
  const write = async (
    key: ParamKey,
    value: ParamValue,
  ): Promise<WriteOutcome> => {
    const p = permit;
    permit = undefined; // one attempt, including uncertain and rejected attempts
    if (
      !p ||
      busy ||
      uncertain ||
      performance.now() > expiresAt ||
      !p.authorized() ||
      simulated.link() !== 'READY'
    )
      throw Error('AUX_REHEARSAL_NOT_AUTHORIZED');
    const expected: ParamKey = `ch.${p.channel}.aux.${p.aux}.level`;
    const before = simulated.read(key);
    if (
      key !== expected ||
      value !== p.toDB ||
      !before.known ||
      !sameValue(before.value, p.fromDB)
    )
      throw Error('AUX_REHEARSAL_STATE_CHANGED');
    busy = true;
    try {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          simulated.write(key, value),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(Error('AUX_REHEARSAL_UNCERTAIN: timeout; do not retry')),
              1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      // Read only after the simulated write completes; never count a promise as confirmation.
      const observed = simulated.read(key);
      if (
        !p.authorized() ||
        simulated.link() !== 'READY' ||
        !observed.known ||
        !sameValue(observed.value, value)
      ) {
        throw Error('AUX_REHEARSAL_UNCERTAIN: inspect state; do not retry');
      }
      return 'applied_simulated';
    } catch (error) {
      uncertain = true;
      throw error;
    } finally {
      busy = false;
    }
  };
  const mixer = new Proxy(simulated as MixerAdapter, {
    get(target, property) {
      if (property === 'write') return write;
      if (property === 'loadSnapshot')
        return async () => {
          throw Error('AUX_REHEARSAL_ONLY');
        };
      const v = Reflect.get(target, property);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    mixer,
    prepare(input: AuxRehearsalPermit) {
      const caps = simulated.capabilities();
      if (
        busy ||
        uncertain ||
        permit ||
        input.role !== 'operator' ||
        input.humanConfirmed !== true ||
        typeof input.requestId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) ||
        used.has(input.requestId) ||
        used.size >= 1000 ||
        typeof input.authorized !== 'function' ||
        !input.authorized() ||
        !Number.isInteger(input.channel) ||
        input.channel < 1 ||
        input.channel > caps.inputs ||
        !Number.isInteger(input.aux) ||
        input.aux < 1 ||
        input.aux > caps.aux ||
        !Number.isFinite(input.fromDB) ||
        !Number.isFinite(input.toDB) ||
        Math.abs(input.toDB - input.fromDB) > 1 ||
        input.fromDB === input.toDB ||
        simulated.registry.validate(
          `ch.${input.channel}.aux.${input.aux}.level`,
          input.toDB,
        )
      )
        throw Error('AUX_REHEARSAL_INVALID_PERMIT');
      used.add(input.requestId);
      expiresAt = performance.now() + 15_000;
      permit = { ...input }; // caller cannot mutate the approved scope/target after preparation
    },
    cancel() {
      permit = undefined;
    },
  };
}
