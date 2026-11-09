import { z } from 'zod';

export const SPECTRUM_VERSION = 'fft-hann-v1' as const;
/** Hard bounds apply before scanning samples or allocating FFT working buffers. */
export const SPECTRUM_LIMITS = Object.freeze({ maxSamples: 262_144, minFftSize: 256, maxFftSize: 16_384, maxFrames: 256, maxBands: 32, maxPeaks: 32, maxFloatMagnitude: 1_000_000 });
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const spectrumOriginSchema = z.strictObject({
  kind: z.enum(['synthetic', 'supplied_pcm']),
  sourceId: id,
  /** Caller asserts unchanged capture setup, gain, routing and placement. Never verified here. */
  conditionsId: id.optional(),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('channel'), channel: z.number().int().min(1).max(64) }),
    z.strictObject({ kind: z.literal('bus'), bus: z.literal('AUX1') }),
  ]).optional(),
  path: z.enum(['unknown', 'electrical', 'acoustic']),
  tap: z.enum(['unknown', 'pre_eq', 'post_eq']),
});
export type SpectrumOrigin = z.infer<typeof spectrumOriginSchema>;
export const frequencyBandSchema = z.strictObject({ id, lowHz: z.number().finite().nonnegative(), highHz: z.number().finite().positive() });
export const spectrumSettingsSchema = z.strictObject({
  fftSize: z.number().int().min(SPECTRUM_LIMITS.minFftSize).max(SPECTRUM_LIMITS.maxFftSize).refine(n => (n & (n - 1)) === 0).default(2048),
  hopSize: z.number().int().positive().optional(),
  bands: z.array(frequencyBandSchema).min(1).max(SPECTRUM_LIMITS.maxBands).optional(),
  peakCount: z.number().int().min(0).max(SPECTRUM_LIMITS.maxPeaks).default(8),
  /** Omit for arithmetic mean. EMA is applied to POWER, independently within each call. */
  smoothingAlpha: z.number().finite().gt(0).max(1).optional(),
});
const common = {
  mode: z.literal('LAB'), channels: z.literal(1), sampleRate: z.number().int().min(8000).max(192000),
  origin: spectrumOriginSchema, inputTimestampMs: z.number().finite().nonnegative().optional(),
  settings: spectrumSettingsSchema.default({ fftSize: 2048, peakCount: 8 }),
};
export const pcmInputSchema = z.discriminatedUnion('format', [
  z.strictObject({ ...common, format: z.literal('s16'), samples: z.instanceof(Int16Array) }),
  z.strictObject({ ...common, format: z.literal('f32'), fullScale: z.union([z.literal(1), z.null()]), samples: z.instanceof(Float32Array) }),
  z.strictObject({ ...common, format: z.literal('f64'), fullScale: z.union([z.literal(1), z.null()]), samples: z.instanceof(Float64Array) }),
]);
export type PcmInput = z.input<typeof pcmInputSchema>;
/** Null logarithmic level means zero power (-infinity), never serialized Infinity. */
export const spectrumLevelSchema = z.strictObject({
  power: z.number().finite().nonnegative(), dbRelativeToUnit: z.number().finite().nullable(), dbFS: z.number().finite().nullable(),
});
export type SpectrumLevel = z.infer<typeof spectrumLevelSchema>;
export const spectrumMeasurementSchema = z.strictObject({
  schemaVersion: z.literal(1), algorithmVersion: z.literal(SPECTRUM_VERSION), mode: z.literal('LAB'),
  origin: spectrumOriginSchema, provenanceVerification: z.literal('caller_declared_not_verified'),
  inputTimestampMs: z.number().finite().nonnegative().optional(),
  representation: z.strictObject({ format: z.enum(['s16', 'f32', 'f64']), levelReference: z.enum(['full_scale', 'unreferenced_pcm']) }),
  sampleRate: z.number().int().min(8000).max(192000),
  processing: z.strictObject({
    fftSize: z.number().int().min(256).max(16384), hopSize: z.number().int().positive(), window: z.literal('periodic_hann'),
    normalization: z.literal('one_sided_power_window_energy'), dcRemoval: z.literal(false),
    aggregation: z.enum(['mean_power', 'ema_power']), smoothingAlpha: z.number().gt(0).max(1).nullable(), peakCount: z.number().int().min(0).max(32),
    binWidthHz: z.number().finite().positive(),
  }),
  coverage: z.strictObject({ inputSamples: z.number().int().min(256).max(262144), analyzedSamples: z.number().int().min(256).max(262144),
    discardedTailSamples: z.number().int().nonnegative(), frames: z.number().int().min(1).max(256), durationSeconds: z.number().finite().positive() }),
  rms: z.strictObject({ linear: z.number().finite().nonnegative(), dbRelativeToUnit: z.number().finite().nullable(), dbFS: z.number().finite().nullable() }),
  totalSpectralPower: spectrumLevelSchema,
  bins: z.array(spectrumLevelSchema.extend({ frequencyHz: z.number().finite().nonnegative() })).min(129).max(8193),
  bands: z.array(frequencyBandSchema.extend({ level: spectrumLevelSchema, fractionOfTotalPower: z.number().finite().min(0).max(1) })).min(1).max(32),
  peaks: z.array(z.strictObject({ frequencyHz: z.number().finite().nonnegative(), bin: z.number().int().nonnegative(), level: spectrumLevelSchema })).max(32),
  clipping: z.strictObject({ status: z.enum(['possible', 'not_indicated', 'unavailable']), basis: z.enum(['integer_rails', 'declared_unit_full_scale', 'unknown_float_scale']),
    atOrBeyondFullScaleSamples: z.number().int().nonnegative().nullable(), fraction: z.number().finite().min(0).max(1).nullable(), longestRun: z.number().int().nonnegative().nullable() }),
  limitations: z.array(z.string()).min(1).max(16),
});
export type SpectrumMeasurement = z.infer<typeof spectrumMeasurementSchema>;
export type SpectrumErrorCode = 'INVALID_PCM' | 'RESOURCE_LIMIT' | 'INSUFFICIENT_SAMPLES' | 'INVALID_SETTINGS';
export class SpectrumInputError extends Error {
  constructor(readonly code: SpectrumErrorCode) { super(code); this.name = 'SpectrumInputError'; }
}
