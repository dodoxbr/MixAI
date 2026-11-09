import type { PcmInput, SpectrumOrigin } from '../../../src/audio-intelligence/index.js';
export function tones(frequencies: Array<[number, number]>, sampleRate = 48000, length = 4096): Float64Array<ArrayBuffer> {
  return Float64Array.from({ length }, (_, i) => frequencies.reduce((s, [hz, amplitude]) => s + amplitude * Math.sin(2 * Math.PI * hz * i / sampleRate), 0));
}
export function pcm(samples = tones([[1500, 0.5]]), extra: Partial<Omit<Extract<PcmInput, { format: 'f64' }>, 'samples'>> = {}): PcmInput {
  return { mode: 'LAB', channels: 1, format: 'f64', fullScale: 1, sampleRate: 48000,
    samples, origin: { kind: 'synthetic', sourceId: 'fixture', conditionsId: 'same_synthetic_setup', path: 'unknown', tap: 'unknown' },
    settings: { fftSize: 4096 }, ...extra };
}
/** Deterministic noise: never reads microphone or external files. */
export function noise(length: number, amplitude = 0.25): Float64Array<ArrayBuffer> {
  let seed = 1234567;
  return Float64Array.from({ length }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return amplitude * (2 * seed / 0x100000000 - 1); });
}
export const pilotOrigins: Record<'surdo' | 'voz' | 'cavaco' | 'aux1', SpectrumOrigin> = {
  surdo: { kind: 'synthetic', sourceId: 'pilot_surdo', conditionsId: 'surdo_fixture_v1', target: { kind: 'channel', channel: 8 }, path: 'unknown', tap: 'unknown' },
  voz: { kind: 'synthetic', sourceId: 'pilot_voz', conditionsId: 'voz_fixture_v1', target: { kind: 'channel', channel: 3 }, path: 'unknown', tap: 'unknown' },
  cavaco: { kind: 'synthetic', sourceId: 'pilot_cavaco', conditionsId: 'cavaco_fixture_v1', target: { kind: 'channel', channel: 1 }, path: 'unknown', tap: 'unknown' },
  aux1: { kind: 'synthetic', sourceId: 'pilot_aux1', conditionsId: 'aux1_fixture_v1', target: { kind: 'bus', bus: 'AUX1' }, path: 'unknown', tap: 'unknown' },
};
