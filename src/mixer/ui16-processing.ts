import {
  eqGainDBToFaderValue,
  faderValueToEqGainDB,
  faderValueToFrequency,
  faderValueToQ,
  frequencyToFaderValue,
  qToFaderValue,
  type SoundcraftUI,
} from 'soundcraft-ui-connection';
import type { ParamKey, ParamValue } from '../core/revisions.js';
import { processingSpec } from '../core/processing-policy.js';
export {
  processingSpec,
  validProcessingValue,
  validProcessingChange,
} from '../core/processing-policy.js';

export function processingRaw(key: string, value: ParamValue): number {
  const s = processingSpec(key);
  if (!s) throw Error('PROCESSING_UNSUPPORTED');
  return s.field === 'bypass'
    ? value === true
      ? 1
      : 0
    : s.field === 'gain'
      ? eqGainDBToFaderValue(value as number)
      : s.field === 'q'
        ? qToFaderValue(value as number)
        : frequencyToFaderValue(value as number);
}
export function processingValue(key: string, raw: number): ParamValue {
  const s = processingSpec(key);
  if (
    !s ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    raw > 1 ||
    (s.field === 'bypass' && raw !== 0 && raw !== 1)
  )
    throw Error('PROCESSING_INVALID_SAMPLE');
  return s.field === 'bypass'
    ? raw === 1
    : s.field === 'gain'
      ? faderValueToEqGainDB(raw)
      : s.field === 'q'
        ? faderValueToQ(raw)
        : faderValueToFrequency(raw);
}
export function processingPath(key: string) {
  const s = processingSpec(key);
  return s ? `i.${s.channel - 1}.${key.split('.').slice(2).join('.')}` : undefined;
}
export function processingFrame(key: string, value: ParamValue) {
  return `3:::SETD^${processingPath(key)}^${processingRaw(key, value)}`;
}
/** Call only proven library setters; stereo fan-out must already have been denied by the gate. */
export function sendProcessing(ui: SoundcraftUI, key: ParamKey, value: ParamValue) {
  const s = processingSpec(key);
  if (!s) throw Error('PROCESSING_UNSUPPORTED');
  const eq = ui.master.input(s.channel).eq;
  if (s.field === 'bypass') eq.setBypass(value as boolean);
  else if (s.field === 'hpf') eq.hpf.setFrequency(value as number);
  else if (s.field === 'freq') eq.band(s.band!).setFrequency(value as number);
  else if (s.field === 'gain') eq.band(s.band!).setGainDB(value as number);
  else eq.band(s.band!).setQ(value as number);
}
export const processingCapabilities = Object.freeze({
  model: 'ui16',
  library: 'soundcraft-ui-connection@7.1.0',
  bands: [1, 2, 3, 4],
  eq: ['frequency', 'gain', 'q', 'bypass'],
  hpf: { frequency: true, bypass: 'frequency_20_hz', independentBypass: false, slope: false },
  compressor: 'unavailable_library_facade',
  gate: 'unavailable_library_facade',
  deEsser: 'unavailable_library_facade',
  lpf: false,
  physicalValidation: 'pending',
  causalAcknowledgement: false,
});
