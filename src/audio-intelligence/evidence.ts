import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FRAME_LIMITS, FRAME_VERSION, frameByteLength, SCALE_DEFINITION_ID, frameSignalSchema, spectrumFrameSchema, type SpectrumFrame } from './frame.js';

/**
 * SpectrumEvidence r1: a small, typed, non-interpretive summary of ONE SpectrumFrame.
 * Pure and deterministic: no clock, I/O, randomness, hardware, model or mixer. It never diagnoses, never recommends
 * an EQ value and never authorizes anything. Spectral energy does not prove sound quality, and an electrical-line
 * signal does not represent the room acoustics.
 */
export const EVIDENCE_VERSION = 'spectrum-evidence-r1' as const;
export const SUMMARY_ALGORITHM = 'spectrum-summary-r1' as const;
/** `measured_verified` is RESERVED: no producer in this codebase can emit it, and the schema rejects it. */
export const PROVENANCE = Object.freeze(['simulated', 'declared_unverified', 'measured_verified'] as const);
export type Provenance = typeof PROVENANCE[number];
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);

/** Presentation settings. They change what is highlighted, never the original levels. */
export const summaryConfigSchema = z.strictObject({
  /** Presentation floor in dBFS per bin. Default -120: ~11 dB above 16-bit quantisation noise per bin at N=4096 (-131 dB). */
  floorDbfs: z.number().finite().min(-200).max(-20).default(-120),
  minProminenceDb: z.number().finite().min(6).max(60).default(20),
  maxPeaks: z.number().int().min(0).max(8).default(3),
  guardBins: z.number().int().min(1).max(16).default(4),
  maxDropDb: z.number().finite().min(20).max(120).default(50),
  /** Peaks are omitted when the bin spacing is coarser than this. */
  maxPeakBinSpacingHz: z.number().finite().min(5).max(200).default(50),
});
export type SummaryConfig = z.infer<typeof summaryConfigSchema>;

export const bandStateSchema = z.enum(['resolved_level', 'exact_zero', 'below_floor', 'unresolved']);
export const insufficientReasonSchema = z.enum(['no_energy', 'quality_insufficient', 'no_resolved_band_above_floor']);
export const peakOmissionSchema = z.enum(['scale_uncalibrated', 'resolution_too_coarse', 'quality_insufficient', 'no_energy', 'no_prominent_peak', 'peaks_disabled']);
export const noticeSchema = z.enum(['energy_is_not_quality', 'levels_are_digital_not_spl', 'peaks_are_local_maxima', 'electrical_not_acoustic', 'synthetic_not_measured', 'declared_origin_unverified', 'shared_bus_not_isolated', 'route_unknown', 'scale_uncalibrated', 'unresolved_bands_present']);
export type Notice = z.infer<typeof noticeSchema>;
export const NOTICE_TEXT_PT: Readonly<Record<Notice, string>> = Object.freeze({
  energy_is_not_quality: 'Energia espectral não comprova qualidade sonora, inteligibilidade nem defeito.',
  levels_are_digital_not_spl: 'Níveis são digitais (potência por bin), não SPL nem dBu.',
  peaks_are_local_maxima: 'Pico é máximo local de bin, não microfonia, ressonância ou frequência a cortar.',
  electrical_not_acoustic: 'Sinal elétrico/não declarado não representa necessariamente a acústica do ambiente.',
  synthetic_not_measured: 'Sinal sintético de laboratório: não é medição real.',
  declared_origin_unverified: 'PCM fornecido: origem física não verificada.',
  shared_bus_not_isolated: 'Barramento compartilhado: não isola um canal ou músico.',
  route_unknown: 'Rota desconhecida: não é possível atribuir a um canal.',
  scale_uncalibrated: 'Escala sem referência digital: níveis só são comparáveis dentro do mesmo quadro.',
  unresolved_bands_present: 'Há faixas sem resolução: ausência de nível ali não é silêncio.',
});
const bandSchema = z.strictObject({
  id, lowHz: z.number().finite().nonnegative(), highHz: z.number().finite().positive(), binCount: z.number().int().nonnegative(), state: bandStateSchema,
  /** Original level, unchanged. null for exact_zero and unresolved. */
  levelDb: z.number().finite().nullable(),
  /** Level clamped to the presentation floor, for drawing only. null for exact_zero and unresolved. */
  displayLevelDb: z.number().finite().nullable(), fractionOfTotalPower: z.number().finite().min(0).max(1).nullable(),
}).superRefine((b, ctx) => {
  const none = b.state === 'exact_zero' || b.state === 'unresolved';
  if (none !== (b.levelDb === null) || none !== (b.displayLevelDb === null)) ctx.addIssue({ code: 'custom', message: 'band level and state disagree' });
  if (b.state === 'unresolved' && (b.binCount !== 0 || b.fractionOfTotalPower !== null)) ctx.addIssue({ code: 'custom', message: 'unresolved band carries no data' });
});
const peakSchema = z.strictObject({ bin: z.number().int().positive(), frequencyHz: z.number().finite().positive(), levelDb: z.number().finite(), prominenceDb: z.number().finite().positive() });
export const spectrumEvidenceSchema = z.strictObject({
  kind: z.literal('spectrum_evidence'), schemaVersion: z.literal(1), evidenceVersion: z.literal(EVIDENCE_VERSION), summaryAlgorithm: z.literal(SUMMARY_ALGORITHM), id,
  frameRef: z.strictObject({ frameId: id, sourceId: id, generationId: id, sequence: z.number().int().nonnegative(), contextRevision: id, frameVersion: z.literal(FRAME_VERSION) }),
  availability: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('available') }),
    z.strictObject({ state: z.literal('insufficient_evidence'), reasons: z.array(insufficientReasonSchema).min(1).max(3) }),
  ]),
  /** `measured_verified` is intentionally not accepted: no current producer can justify it. */
  provenance: z.enum(['simulated', 'declared_unverified']),
  signal: frameSignalSchema, domain: z.enum(['electrical_line', 'acoustic', 'synthetic', 'unknown']), tap: z.enum(['pre_eq', 'post_eq', 'unknown']),
  routeCaveat: z.enum(['none', 'shared_bus_not_isolated', 'route_unknown']),
  scale: z.strictObject({ unit: z.enum(['dbfs_power_per_bin', 'relative_unknown']), calibration: z.enum(['digital_reference', 'uncalibrated']), scaleDefinitionId: z.literal(SCALE_DEFINITION_ID), nullMeans: z.literal('exact_zero_power') })
    .superRefine((s, ctx) => { if ((s.unit === 'dbfs_power_per_bin') !== (s.calibration === 'digital_reference')) ctx.addIssue({ code: 'custom', message: 'unit and calibration disagree' }); }),
  resolution: z.strictObject({ sampleRateHz: z.number().int().min(8000).max(192000), fftSize: z.number().int(), binSpacingHz: z.number().finite().positive(), nyquistHz: z.number().finite().positive() }),
  presentation: z.strictObject({ config: summaryConfigSchema, floorApplied: z.boolean() }),
  bands: z.array(bandSchema).min(1).max(32),
  levels: z.strictObject({ totalBins: z.number().int().positive(), aboveFloor: z.number().int().nonnegative(), belowFloor: z.number().int().nonnegative(), exactZero: z.number().int().nonnegative() }),
  peaks: z.strictObject({ meaning: z.literal('local_spectral_maximum'), state: z.enum(['reported', 'omitted']), omissionReason: peakOmissionSchema.nullable(), items: z.array(peakSchema).max(8) }),
  quality: z.strictObject({ frameConfidence: z.enum(['insufficient', 'limited']), clippingPossible: z.boolean().nullable(), clippingFraction: z.number().finite().min(0).max(1).nullable(), reasons: z.array(z.string().max(60)).max(8) }),
  notices: z.array(noticeSchema).min(1).max(10), limitations: z.array(z.string()).min(1).max(16),
  /** Fixed. Evidence is descriptive only. */
  guards: z.strictObject({ diagnosis: z.literal('none'), eqRecommendation: z.literal('none'), authorization: z.literal('not_granted'), execution: z.literal('not_executable'), realWrites: z.literal(false) }),
}).superRefine((e, ctx) => {
  if ((e.scale.unit === 'dbfs_power_per_bin') !== e.presentation.floorApplied) ctx.addIssue({ code: 'custom', message: 'floor only applies to a digital reference' });
  if ((e.peaks.state === 'reported') !== (e.peaks.items.length > 0) || (e.peaks.state === 'omitted') !== (e.peaks.omissionReason !== null)) ctx.addIssue({ code: 'custom', message: 'peaks state inconsistent' });
  if (e.peaks.state === 'reported' && e.availability.state !== 'available') ctx.addIssue({ code: 'custom', message: 'peaks need available evidence' });
  if (e.availability.state === 'available' && !e.bands.some(b => b.state === 'resolved_level')) ctx.addIssue({ code: 'custom', message: 'available evidence needs a resolved level' });
});
export type SpectrumEvidence = z.infer<typeof spectrumEvidenceSchema>;
export type EvidenceErrorCode = 'INVALID_FRAME' | 'INVALID_CONFIG' | 'RESOURCE_LIMIT';
export class EvidenceError extends Error { constructor(readonly code: EvidenceErrorCode) { super(code); this.name = 'EvidenceError'; } }

/** Cross-field checks that the structural schema cannot express. */
function consistent(f: SpectrumFrame): boolean {
  const g = f.spectrum.grid, n = f.resolution.fftSize, nyquist = f.sampleRateHz / 2, tol = 1e-9 * f.sampleRateHz;
  if (n < 256 || n > 4096 || (n & (n - 1)) !== 0 || g.levels.length !== n / 2 + 1) return false;
  if (Math.abs(g.spacingHz * n - f.sampleRateHz) > tol || Math.abs(f.resolution.binSpacingHz - g.spacingHz) > 1e-9) return false;
  if ((f.origin.kind === 'mock') !== (f.domain === 'synthetic')) return false;
  if (f.signal.kind === 'input' && f.signal.channel > FRAME_LIMITS.maxInputChannels) return false;
  let prevHigh = 0;
  for (const [i, b] of f.spectrum.bands.entries()) {
    if (b.lowHz >= b.highHz || b.highHz > nyquist + 1e-9 || (i > 0 && b.lowHz < prevHigh)) return false;
    prevHigh = b.highHz;
    let count = 0;
    for (let k = Math.max(0, Math.ceil(b.lowHz / g.spacingHz - 1e-9)); k < g.levels.length; k++) {
      const hz = k * g.spacingHz;
      if (hz >= b.highHz - 1e-9 && !(Math.abs(b.highHz - nyquist) < 1e-9 && k === g.levels.length - 1)) break;
      count++;
    }
    if (count !== b.binCount) return false;
  }
  return true;
}

/**
 * Peak = interior local maximum at/above the floor that (1) has topographic prominence >= minProminenceDb and (2) stands >= minProminenceDb above
 * the MEDIAN of its neighbourhood (CONTRAST_HALF_WINDOW bins each side, excluding guardBins), (3) is not within guardBins of a stronger reported peak and
 * (4) is within maxDropDb of the strongest one. Levels are clamped to the floor; exact zero counts as the floor. Criterion (2) exists because the
 * topographic prominence of the largest bin of plain noise is large (its neighbours include deep random nulls).
 * Cost: O(n) scan + O(c*(n+W log W)) for c candidates above floor+minProminence (n <= 4096, W = 2*CONTRAST_HALF_WINDOW).
 */
export const CONTRAST_HALF_WINDOW = 32;
function localMedian(v: readonly number[], k: number, guard: number): number {
  const w: number[] = [];
  for (let i = Math.max(0, k - CONTRAST_HALF_WINDOW); i <= Math.min(v.length - 1, k + CONTRAST_HALF_WINDOW); i++) if (Math.abs(i - k) > guard) w.push(v[i]!);
  w.sort((a, b) => a - b);
  return w.length === 0 ? Number.NEGATIVE_INFINITY : w.length % 2 ? w[(w.length - 1) / 2]! : (w[w.length / 2 - 1]! + w[w.length / 2]!) / 2;
}
function findPeaks(levels: readonly (number | null)[], c: SummaryConfig): SpectrumEvidence['peaks']['items'] {
  const floor = c.floorDbfs, v = levels.map(x => x === null || x < floor ? floor : x), n = v.length;
  const cand: { k: number; p: number }[] = [];
  for (let k = 1; k < n - 1; k++) {
    if (!(v[k]! > v[k - 1]! && v[k]! >= v[k + 1]!) || v[k]! < floor + c.minProminenceDb) continue;
    let lmin = v[k]!, rmin = v[k]!;
    for (let i = k - 1; i >= 0 && v[i]! < v[k]!; i--) lmin = Math.min(lmin, v[i]!);
    for (let i = k + 1; i < n && v[i]! <= v[k]!; i++) rmin = Math.min(rmin, v[i]!);
    // Left base: stop at first sample >= peak; a plateau on the right continues to the first strictly higher sample.
    const p = v[k]! - Math.max(lmin, rmin);
    if (p >= c.minProminenceDb && v[k]! - localMedian(v, k, c.guardBins) >= c.minProminenceDb) cand.push({ k, p });
  }
  cand.sort((a, b) => v[b.k]! - v[a.k]! || a.k - b.k);
  const out: { k: number; p: number }[] = [];
  for (const x of cand) {
    if (out.length >= c.maxPeaks) break;
    if (out.length > 0 && (v[out[0]!.k]! - v[x.k]! > c.maxDropDb || out.some(o => Math.abs(o.k - x.k) <= c.guardBins))) continue;
    out.push(x);
  }
  return out.map(x => ({ bin: x.k, frequencyHz: 0, levelDb: v[x.k]!, prominenceDb: x.p }));
}

export function summarizeFrame(rawFrame: unknown, rawConfig: unknown = {}): SpectrumEvidence {
  const cfg = summaryConfigSchema.safeParse(rawConfig ?? {});
  if (!cfg.success) throw new EvidenceError('INVALID_CONFIG');
  const parsed = spectrumFrameSchema.safeParse(rawFrame);
  if (!parsed.success) throw new EvidenceError('INVALID_FRAME');
  const f = parsed.data, c = cfg.data;
  if (frameByteLength(f) > FRAME_LIMITS.maxBytes) throw new EvidenceError('RESOURCE_LIMIT');
  if (!consistent(f)) throw new EvidenceError('INVALID_FRAME');

  const s = f.spectrum, digital = s.unit === 'dbfs_power_per_bin', floor = c.floorDbfs, spacing = s.grid.spacingHz;
  let aboveFloor = 0, belowFloor = 0, exactZero = 0;
  for (const x of s.grid.levels) { if (x === null) exactZero++; else if (digital && x < floor) belowFloor++; else aboveFloor++; }
  const bands = s.bands.map(b => {
    if (b.coverage === 'unresolved') return { id: b.id, lowHz: b.lowHz, highHz: b.highHz, binCount: 0, state: 'unresolved' as const, levelDb: null, displayLevelDb: null, fractionOfTotalPower: null };
    if (b.level === null) return { id: b.id, lowHz: b.lowHz, highHz: b.highHz, binCount: b.binCount, state: 'exact_zero' as const, levelDb: null, displayLevelDb: null, fractionOfTotalPower: b.fractionOfTotalPower };
    // A band level is a SUM of bin powers: its floor rises by 10*log10(binCount).
    const bandFloor = floor + 10 * Math.log10(b.binCount), below = digital && b.level < bandFloor;
    return { id: b.id, lowHz: b.lowHz, highHz: b.highHz, binCount: b.binCount, state: below ? 'below_floor' as const : 'resolved_level' as const,
      levelDb: b.level, displayLevelDb: below ? bandFloor : b.level, fractionOfTotalPower: b.fractionOfTotalPower };
  });

  const noEnergy = aboveFloor === 0 && belowFloor === 0, qualityBad = f.quality.confidence === 'insufficient' && f.quality.reasons.includes('clipping_possible');
  const reasons: z.infer<typeof insufficientReasonSchema>[] = [];
  if (noEnergy) reasons.push('no_energy');
  if (qualityBad) reasons.push('quality_insufficient');
  if (!noEnergy && !bands.some(b => b.state === 'resolved_level')) reasons.push('no_resolved_band_above_floor');
  const available = reasons.length === 0;

  let omission: z.infer<typeof peakOmissionSchema> | null = null;
  if (c.maxPeaks === 0) omission = 'peaks_disabled';
  else if (!digital) omission = 'scale_uncalibrated';
  else if (spacing > c.maxPeakBinSpacingHz) omission = 'resolution_too_coarse';
  else if (noEnergy) omission = 'no_energy';
  else if (qualityBad) omission = 'quality_insufficient';
  else if (!available) omission = 'no_prominent_peak';
  let items: SpectrumEvidence['peaks']['items'] = [];
  if (omission === null) {
    items = findPeaks(s.grid.levels, c).map(p => ({ ...p, frequencyHz: p.bin * spacing }));
    if (items.length === 0) omission = 'no_prominent_peak';
  }

  const origin = f.origin, provenance = origin.kind === 'mock' ? 'simulated' as const : 'declared_unverified' as const;
  const routeCaveat = f.signal.kind === 'bus' ? 'shared_bus_not_isolated' as const : f.signal.kind === 'unknown' ? 'route_unknown' as const : 'none' as const;
  const notices: Notice[] = ['energy_is_not_quality', 'levels_are_digital_not_spl', 'peaks_are_local_maxima',
    provenance === 'simulated' ? 'synthetic_not_measured' : 'declared_origin_unverified'];
  if (f.domain !== 'acoustic') notices.push('electrical_not_acoustic');
  if (routeCaveat !== 'none') notices.push(routeCaveat === 'shared_bus_not_isolated' ? 'shared_bus_not_isolated' : 'route_unknown');
  if (!digital) notices.push('scale_uncalibrated');
  if (bands.some(b => b.state === 'unresolved')) notices.push('unresolved_bands_present');

  const frameRef = { frameId: f.id, sourceId: f.sourceId, generationId: f.generationId, sequence: f.sequence, contextRevision: f.contextRevision, frameVersion: f.frameVersion };
  const evId = 'ev_' + createHash('sha256').update(JSON.stringify([EVIDENCE_VERSION, frameRef, c])).digest('hex').slice(0, 32);
  const clip = f.quality.digitalClippingEstimate;
  return spectrumEvidenceSchema.parse({
    kind: 'spectrum_evidence', schemaVersion: 1, evidenceVersion: EVIDENCE_VERSION, summaryAlgorithm: SUMMARY_ALGORITHM, id: evId, frameRef,
    availability: available ? { state: 'available' } : { state: 'insufficient_evidence', reasons },
    provenance, signal: f.signal, domain: f.domain, tap: f.tap, routeCaveat,
    scale: { unit: s.unit, calibration: s.calibration, scaleDefinitionId: s.scaleDefinitionId, nullMeans: s.nullMeans },
    resolution: { sampleRateHz: f.sampleRateHz, fftSize: f.resolution.fftSize, binSpacingHz: spacing, nyquistHz: f.sampleRateHz / 2 },
    presentation: { config: c, floorApplied: digital }, bands,
    levels: { totalBins: s.grid.levels.length, aboveFloor, belowFloor, exactZero },
    peaks: { meaning: 'local_spectral_maximum', state: items.length ? 'reported' : 'omitted', omissionReason: items.length ? null : omission, items },
    quality: { frameConfidence: f.quality.confidence, clippingPossible: clip === null ? null : f.quality.reasons.includes('clipping_possible'), clippingFraction: clip?.fraction ?? null, reasons: f.quality.reasons },
    notices, limitations: f.limitations,
    guards: { diagnosis: 'none', eqRecommendation: 'none', authorization: 'not_granted', execution: 'not_executable', realWrites: false },
  });
}
