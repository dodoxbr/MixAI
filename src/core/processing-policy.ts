import type { ParamKey, ParamValue } from './revisions.js';

/** Pure policy: LAB/MOCK must not load the physical library. */
/** Library 7.1.0 input EQ only. No LPF, slope, dynamics path or arbitrary SETD. */
export const PROCESSING_KEY =
  /^ch\.([1-9]|1[0-2])\.eq\.(?:b([1-4])\.(freq|gain|q)|hpf\.(freq)|(bypass))$/;
export function processingSpec(key: string) {
  const m = PROCESSING_KEY.exec(key);
  if (!m) return undefined;
  const field = m[3] ?? (m[4] ? 'hpf' : 'bypass');
  const range =
    field === 'freq'
      ? [20, 20000]
      : field === 'gain'
        ? [-6, 6]
        : field === 'q'
          ? [0.1, 10]
          : field === 'hpf'
            ? [20, 300]
            : undefined;
  return {
    key: key as ParamKey,
    channel: Number(m[1]),
    band: m[2] ? Number(m[2]) : undefined,
    field,
    unit: (field === 'bypass'
      ? 'boolean'
      : field === 'gain'
        ? 'dB'
        : field === 'q'
          ? 'Q'
          : 'Hz') as 'boolean' | 'dB' | 'Q' | 'Hz',
    range,
    scope: 'input_channel_processing_not_destination_specific' as const,
  };
}
export function validProcessingValue(key: string, value: unknown): value is ParamValue {
  const s = processingSpec(key);
  if (!s) return false;
  if (s.field === 'bypass') return typeof value === 'boolean';
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < s.range![0]! ||
    value > s.range![1]!
  )
    return false;
  const precision = s.field === 'gain' ? 1 : s.field === 'q' ? 2 : 0;
  return Number(value.toFixed(precision)) === value;
}
export function validProcessingChange(key: string, previous: ParamValue, target: ParamValue) {
  if (
    !validProcessingValue(key, previous) ||
    !validProcessingValue(key, target) ||
    previous === target
  )
    return false;
  const s = processingSpec(key)!;
  if (s.field === 'gain') return Math.abs((target as number) - (previous as number)) <= 1;
  if (s.field === 'bypass' || (s.field === 'hpf' && (target === 20 || previous === 20)))
    return true;
  return (
    Math.max(target as number, previous as number) /
      Math.min(target as number, previous as number) <=
    2
  );
}
