import { z } from 'zod';
import { spectrumMeasurementSchema, type SpectrumMeasurement } from './contracts.js';

/**
 * Reconciliation of the #82 SpectrumFrame draft with the #84 SpectrumMeasurement (INTEGRATION-PLAN, step 1-2).
 * Pure and offline: no clock, no I/O, no source lifecycle. Time/generation fields are SUPPLIED by a future SpectrumSource,
 * never derived from the measurement. Only the origins that this adapter can honestly produce exist here; `measured`
 * origins (native_verified / audio_capture) are deliberately absent until a validated source exists.
 */
export const FRAME_VERSION = 'spectrum-frame-r1' as const;
/** Scale definition id referenced by every frame produced from the #84 engine. */
export const SCALE_DEFINITION_ID = 'fft-hann-v1/one_sided_power_window_energy' as const;
export const FRAME_LIMITS = Object.freeze({ maxBins: 4096, maxBytes: 262_144, maxInputChannels: 12 });
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const level = z.number().finite().nullable();

export const frameOriginSchema = z.discriminatedUnion('kind', [
  /** Synthetic/mock signal. Never measured. `seed` is unknown to the engine, hence null. */
  z.strictObject({ kind: z.literal('mock'), measurement: z.literal('simulated'), fixtureId: id, seed: z.null() }),
  /** Caller-supplied PCM. Analysed numbers are real, their physical origin is not verified. Never `measured`. */
  z.strictObject({ kind: z.literal('supplied_pcm'), measurement: z.literal('declared_unverified'), sourceId: id, conditionsId: id.nullable() }),
]);
export const frameSignalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('input'), channel: z.number().int().min(1).max(FRAME_LIMITS.maxInputChannels) }),
  z.strictObject({ kind: z.literal('bus'), bus: z.literal('aux1'), shared: z.literal(true) }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export const frameBandSchema = z.strictObject({
  id, lowHz: z.number().finite().nonnegative(), highHz: z.number().finite().positive(), binCount: z.number().int().nonnegative(),
  /** `unresolved`: the resolution has no bin centre in the band. That is NOT silence and carries no level. */
  coverage: z.enum(['resolved', 'unresolved']), level, fractionOfTotalPower: z.number().finite().min(0).max(1).nullable(),
}).superRefine((b, ctx) => {
  if (b.coverage === 'unresolved' && (b.level !== null || b.fractionOfTotalPower !== null || b.binCount !== 0)) ctx.addIssue({ code: 'custom', message: 'unresolved band must carry no level' });
  if (b.coverage === 'resolved' && b.binCount === 0) ctx.addIssue({ code: 'custom', message: 'resolved band needs bins' });
});
export const spectrumFrameSchema = z.strictObject({
  kind: z.literal('spectrum_frame'), schemaVersion: z.literal(1), frameVersion: z.literal(FRAME_VERSION),
  id, sourceId: id, generationId: id, sequence: z.number().int().nonnegative(), contextRevision: id,
  origin: frameOriginSchema, signal: frameSignalSchema,
  domain: z.enum(['electrical_line', 'acoustic', 'synthetic', 'unknown']), tap: z.enum(['pre_eq', 'post_eq', 'unknown']),
  processingContext: z.strictObject({ status: z.literal('unknown'), recordId: z.null() }),
  /** Always null here: a declared input timestamp is not an acquisition clock. */
  capturedAt: z.null(), receivedAtUtc: z.string().datetime(), receivedAtMonoMs: z.number().finite().nonnegative(), clockDomainId: id,
  acquisitionAgeUpperBoundMs: z.null(),
  sampleRateHz: z.number().int().min(8000).max(192000),
  resolution: z.strictObject({ kind: z.literal('fft'), fftSize: z.number().int(), binSpacingHz: z.number().finite().positive(), window: z.literal('hann_periodic'),
    hopSamples: z.number().int().positive(), aggregation: z.enum(['mean_power', 'ema_power']), smoothingAlpha: z.number().gt(0).max(1).nullable(), algorithmVersion: z.string().min(1).max(40) }),
  spectrum: z.strictObject({
    unit: z.enum(['dbfs_power_per_bin', 'relative_unknown']), calibration: z.enum(['digital_reference', 'uncalibrated']), scaleDefinitionId: z.literal(SCALE_DEFINITION_ID),
    /** null means exactly zero power (-infinity), never "missing sample". */
    nullMeans: z.literal('exact_zero_power'),
    grid: z.strictObject({ startHz: z.literal(0), spacingHz: z.number().finite().positive(), levels: z.array(level).min(129).max(FRAME_LIMITS.maxBins) }),
    bands: z.array(frameBandSchema).min(1).max(32),
  }).superRefine((s, ctx) => {
    if ((s.unit === 'dbfs_power_per_bin') !== (s.calibration === 'digital_reference')) ctx.addIssue({ code: 'custom', message: 'unit and calibration disagree' });
  }),
  quality: z.strictObject({ confidence: z.enum(['insufficient', 'limited']), reasons: z.array(z.string().max(60)).max(8),
    /** Unknown to the engine: null, not 0. */ droppedFrames: z.null(),
    digitalClippingEstimate: z.strictObject({ fraction: z.number().finite().min(0).max(1), thresholdDbfs: z.literal(0), point: z.literal('captured_pcm') }).nullable() }),
  limitations: z.array(z.string()).min(1).max(16),
});
export type SpectrumFrame = z.infer<typeof spectrumFrameSchema>;

/** Supplied by the future SpectrumSource lifecycle. Nothing here comes from the measurement. */
export const frameLifecycleSchema = z.strictObject({
  frameId: id, sourceId: id, generationId: id, sequence: z.number().int().nonnegative(), contextRevision: id,
  receivedAtUtc: z.string().datetime(), receivedAtMonoMs: z.number().finite().nonnegative(), clockDomainId: id,
});
/** Real UTF-8 size of the serialised value, not the string length (multi-byte text counts in full). */
export const frameByteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
export type FrameLifecycle = z.input<typeof frameLifecycleSchema>;
export type FrameErrorCode = 'INVALID_MEASUREMENT' | 'INVALID_LIFECYCLE' | 'ROUTE_NOT_SUPPORTED' | 'RESOURCE_LIMIT';
export class FrameError extends Error { constructor(readonly code: FrameErrorCode) { super(code); this.name = 'FrameError'; } }

/** Pure conversion. Throws FrameError; never fabricates time, validation, calibration or silence. */
export function measurementToFrame(rawMeasurement: unknown, rawLifecycle: unknown, options: { inputs?: number } = {}): SpectrumFrame {
  const m = spectrumMeasurementSchema.safeParse(rawMeasurement), lc = frameLifecycleSchema.safeParse(rawLifecycle);
  if (!m.success) throw new FrameError('INVALID_MEASUREMENT');
  if (!lc.success) throw new FrameError('INVALID_LIFECYCLE');
  const x: SpectrumMeasurement = m.data, life = lc.data, o = x.origin;
  const synthetic = o.kind === 'synthetic', referenced = x.representation.levelReference === 'full_scale';
  const inputs = Math.min(options.inputs ?? FRAME_LIMITS.maxInputChannels, FRAME_LIMITS.maxInputChannels);
  if (o.target?.kind === 'channel' && o.target.channel > inputs) throw new FrameError('ROUTE_NOT_SUPPORTED');
  const levels = x.bins.map(b => referenced ? b.dbFS : b.dbRelativeToUnit);
  if (levels.length > FRAME_LIMITS.maxBins) throw new FrameError('RESOURCE_LIMIT');
  const silent = x.totalSpectralPower.power === 0, clip = x.clipping;
  const reasons = ['declared_not_verified', ...(synthetic ? ['synthetic'] : []), ...(silent ? ['no_energy'] : []), ...(clip.status === 'possible' ? ['clipping_possible'] : []), ...(x.bands.some(b => b.binCount === 0) ? ['unresolved_band'] : [])];
  const frame: SpectrumFrame = {
    kind: 'spectrum_frame', schemaVersion: 1, frameVersion: FRAME_VERSION, id: life.frameId, sourceId: life.sourceId, generationId: life.generationId, sequence: life.sequence, contextRevision: life.contextRevision,
    origin: synthetic ? { kind: 'mock', measurement: 'simulated', fixtureId: o.sourceId, seed: null } : { kind: 'supplied_pcm', measurement: 'declared_unverified', sourceId: o.sourceId, conditionsId: o.conditionsId ?? null },
    signal: !o.target ? { kind: 'unknown' } : o.target.kind === 'channel' ? { kind: 'input', channel: o.target.channel } : { kind: 'bus', bus: 'aux1', shared: true },
    domain: synthetic ? 'synthetic' : o.path === 'electrical' ? 'electrical_line' : o.path, tap: o.tap,
    processingContext: { status: 'unknown', recordId: null }, capturedAt: null, receivedAtUtc: life.receivedAtUtc, receivedAtMonoMs: life.receivedAtMonoMs, clockDomainId: life.clockDomainId, acquisitionAgeUpperBoundMs: null,
    sampleRateHz: x.sampleRate,
    resolution: { kind: 'fft', fftSize: x.processing.fftSize, binSpacingHz: x.processing.binWidthHz, window: 'hann_periodic', hopSamples: x.processing.hopSize, aggregation: x.processing.aggregation, smoothingAlpha: x.processing.smoothingAlpha, algorithmVersion: x.algorithmVersion },
    spectrum: {
      unit: referenced ? 'dbfs_power_per_bin' : 'relative_unknown', calibration: referenced ? 'digital_reference' : 'uncalibrated', scaleDefinitionId: SCALE_DEFINITION_ID, nullMeans: 'exact_zero_power',
      grid: { startHz: 0, spacingHz: x.processing.binWidthHz, levels },
      bands: x.bands.map(b => b.binCount === 0
        ? { id: b.id, lowHz: b.lowHz, highHz: b.highHz, binCount: 0, coverage: 'unresolved' as const, level: null, fractionOfTotalPower: null }
        : { id: b.id, lowHz: b.lowHz, highHz: b.highHz, binCount: b.binCount, coverage: 'resolved' as const, level: referenced ? b.level.dbFS : b.level.dbRelativeToUnit, fractionOfTotalPower: b.fractionOfTotalPower }),
    },
    // `validated_for_point` is unreachable: it needs a physical validation record this engine cannot hold.
    quality: { confidence: silent || clip.status === 'possible' ? 'insufficient' : 'limited', reasons, droppedFrames: null,
      digitalClippingEstimate: clip.status === 'unavailable' || clip.fraction === null ? null : { fraction: clip.fraction, thresholdDbfs: 0, point: 'captured_pcm' } },
    limitations: x.limitations,
  };
  const parsed = spectrumFrameSchema.parse(frame);
  if (frameByteLength(parsed) > FRAME_LIMITS.maxBytes) throw new FrameError('RESOURCE_LIMIT');
  return parsed;
}
