/** Estimated digital RBJ response at 48 kHz; not a Ui16 transfer measurement. */
export const EQ_SAMPLE_RATE = 48000;
export interface EqBandResponse {
  freq: number;
  q: number;
  gain: number;
}
export interface EqResponse {
  bands: EqBandResponse[];
  hpf: { freq: number; slope: number };
  bypass: boolean;
}
export type Biquad = { b: [number, number, number]; a: [number, number, number] };
export function peakCoefficients(band: EqBandResponse): Biquad {
  const w = (2 * Math.PI * band.freq) / EQ_SAMPLE_RATE;
  const alpha = Math.sin(w) / (2 * band.q),
    A = 10 ** (band.gain / 40),
    c = Math.cos(w);
  return { b: [1 + alpha * A, -2 * c, 1 - alpha * A], a: [1 + alpha / A, -2 * c, 1 - alpha / A] };
}
export function highpassCoefficients(freq: number, q: number): Biquad {
  const w = (2 * Math.PI * freq) / EQ_SAMPLE_RATE,
    c = Math.cos(w),
    alpha = Math.sin(w) / (2 * q);
  return { b: [(1 + c) / 2, -(1 + c), (1 + c) / 2], a: [1 + alpha, -2 * c, 1 - alpha] };
}
/** Even-order Butterworth cascade: -3.0103 dB at cutoff for every slope. 20 Hz = off. */
export function eqFilters(eq: EqResponse): Biquad[] {
  if (eq.bypass) return [];
  const filters = eq.bands.map(peakCoefficients);
  if (eq.hpf.freq > 20) {
    const order = eq.hpf.slope / 6;
    for (let k = 1; k <= order / 2; k++) {
      const q = 1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * order)));
      filters.push(highpassCoefficients(eq.hpf.freq, q));
    }
  }
  return filters;
}
export function magnitudeDB(filters: Biquad[], frequency: number): number {
  const w = (2 * Math.PI * frequency) / EQ_SAMPLE_RATE;
  const power = (v: number[]) =>
    (v[0]! + v[1]! * Math.cos(w) + v[2]! * Math.cos(2 * w)) ** 2 + (v[1]! * Math.sin(w) + v[2]! * Math.sin(2 * w)) ** 2;
  return filters.reduce((db, f) => db + 10 * Math.log10(Math.max(1e-30, power(f.b)) / Math.max(1e-30, power(f.a))), 0);
}
export const plotFrequency = (x: number) => 20 * (22050 / 20) ** Math.max(0, Math.min(1, x));
export const plotPosition = (freq: number) => Math.log(freq / 20) / Math.log(22050 / 20);
