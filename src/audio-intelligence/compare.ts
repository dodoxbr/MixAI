import { spectrumMeasurementSchema, type SpectrumMeasurement } from './contracts.js';

export interface LevelDifference {
  before: number;
  after: number;
  deltaDB: number | null;
  transition: 'finite' | 'both_zero' | 'from_zero' | 'to_zero';
}
export type SpectrumIncompatibility = 'invalid_measurement' | 'conditions_not_declared' | 'origin' | 'representation' | 'sample_rate' | 'processing' | 'coverage' | 'bands' | 'invalid_grid_or_coverage';
export type SpectrumComparison =
  | { kind: 'incomparable'; reasons: SpectrumIncompatibility[] }
  | { kind: 'comparison'; mode: 'LAB'; comparability: 'caller_declared_conditions_match';
      origin: SpectrumMeasurement['origin']; rms: LevelDifference;
      bands: Array<{ id: string; lowHz: number; highHz: number; binCount: number; power: LevelDifference | null }>;
      dominantPeakHz: { before: number | null; after: number | null };
      limitations: string[] };
function difference(before: number, after: number, multiplier: number): LevelDifference {
  return { before, after, deltaDB: before === 0 || after === 0 ? null : multiplier * (Math.log10(after) - Math.log10(before)),
    transition: before === 0 ? after === 0 ? 'both_zero' : 'from_zero' : after === 0 ? 'to_zero' : 'finite' };
}
/** Validates serialized results, not their physical authenticity. Conditions must be explicitly supplied. */
export function compareSpectra(before: unknown, after: unknown): SpectrumComparison {
  for (const raw of [before, after]) {
    if (!raw || typeof raw !== 'object') return { kind: 'incomparable', reasons: ['invalid_measurement'] };
    const value = raw as Record<string, unknown>;
    for (const [field, max] of [['bins', 8193], ['bands', 32], ['peaks', 32], ['limitations', 16]] as const) {
      if (!Array.isArray(value[field]) || value[field].length > max) return { kind: 'incomparable', reasons: ['invalid_measurement'] };
    }
  }
  const a = spectrumMeasurementSchema.safeParse(before), b = spectrumMeasurementSchema.safeParse(after);
  if (!a.success || !b.success) return { kind: 'incomparable', reasons: ['invalid_measurement'] };
  const x = a.data, y = b.data, reasons: SpectrumIncompatibility[] = [];
  if (!x.origin.conditionsId || !y.origin.conditionsId) reasons.push('conditions_not_declared');
  const equal = (field: SpectrumIncompatibility, left: unknown, right: unknown) => { if (JSON.stringify(left) !== JSON.stringify(right)) reasons.push(field); };
  equal('origin', x.origin, y.origin);
  equal('representation', x.representation, y.representation);
  equal('sample_rate', x.sampleRate, y.sampleRate);
  equal('processing', x.processing, y.processing);
  equal('coverage', x.coverage, y.coverage);
  equal('bands', x.bands.map(({ id, lowHz, highHz, binCount }) => ({ id, lowHz, highHz, binCount })), y.bands.map(({ id, lowHz, highHz, binCount }) => ({ id, lowHz, highHz, binCount })));
  // Keep malformed serialized shapes from posing as a different frequency grid.
  for (const m of [x, y]) {
    const n = m.processing.fftSize;
    if ((n & (n - 1)) !== 0 || m.processing.hopSize < n / 4 || m.processing.hopSize > n || m.bins.length !== n / 2 + 1 || m.processing.binWidthHz !== m.sampleRate / n ||
        m.bins.some((bin, i) => bin.frequencyHz !== i * m.sampleRate / n) ||
        m.coverage.analyzedSamples !== n + (m.coverage.frames - 1) * m.processing.hopSize ||
        m.coverage.analyzedSamples + m.coverage.discardedTailSamples !== m.coverage.inputSamples ||
        m.coverage.durationSeconds !== m.coverage.analyzedSamples / m.sampleRate ||
        m.bands.some(band => band.binCount !== m.bins.filter(bin => bin.frequencyHz >= band.lowHz && (bin.frequencyHz < band.highHz || (band.highHz === m.sampleRate / 2 && bin.frequencyHz === band.highHz))).length)) reasons.push('invalid_grid_or_coverage');
  }
  if (reasons.length) return { kind: 'incomparable', reasons: [...new Set(reasons)] };
  return { kind: 'comparison', mode: 'LAB', comparability: 'caller_declared_conditions_match', origin: x.origin,
    rms: difference(x.rms.linear, y.rms.linear, 20),
    bands: x.bands.map((band, i) => ({ id: band.id, lowHz: band.lowHz, highHz: band.highHz, binCount: band.binCount, power: band.binCount === 0 ? null : difference(band.level.power, y.bands[i].level.power, 10) })),
    dominantPeakHz: { before: x.peaks[0]?.frequencyHz ?? null, after: y.peaks[0]?.frequencyHz ?? null },
    limitations: ['Comparison relies on caller-declared conditions, not verified capture metadata.',
      'No resampling, gain compensation, calibration or interpolation. Unknown physical differences invalidate interpretation.',
      'Changes describe supplied PCM only; they do not establish improvement, a defect, causality or an EQ adjustment.',
      'Null deltaDB with a zero transition represents an unbounded or undefined logarithmic difference, not zero change.'],
  };
}
