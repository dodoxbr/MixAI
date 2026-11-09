import { pcmInputSchema, SPECTRUM_LIMITS, SPECTRUM_VERSION, SpectrumInputError, type SpectrumLevel, type SpectrumMeasurement } from './contracts.js';
import { fft } from './fft.js';

const defaultEdges = [20, 80, 250, 500, 2000, 5000, 20000];
export const powerDB = (power: number): number | null => power === 0 ? null : 10 * Math.log10(power);
function level(power: number, referenced: boolean): SpectrumLevel {
  const dbRelativeToUnit = powerDB(power);
  return { power, dbRelativeToUnit, dbFS: referenced ? dbRelativeToUnit : null };
}

/** Synchronous, bounded, mono PCM analysis. No I/O, capture, model, mixer or retained state. */
export function analyzePcm(raw: unknown): SpectrumMeasurement {
  const parsed = pcmInputSchema.safeParse(raw);
  if (!parsed.success) throw new SpectrumInputError('INVALID_PCM');
  const input = parsed.data, { samples, sampleRate, settings } = input;
  if (typeof SharedArrayBuffer !== 'undefined' && samples.buffer instanceof SharedArrayBuffer) throw new SpectrumInputError('INVALID_PCM');
  if (samples.length > SPECTRUM_LIMITS.maxSamples) throw new SpectrumInputError('RESOURCE_LIMIT');
  const n = settings.fftSize, hop = settings.hopSize ?? n / 2;
  if (hop < n / 4 || hop > n) throw new SpectrumInputError('INVALID_SETTINGS');
  if (samples.length < n) throw new SpectrumInputError('INSUFFICIENT_SAMPLES');
  const frames = Math.floor((samples.length - n) / hop) + 1;
  if (frames > SPECTRUM_LIMITS.maxFrames) throw new SpectrumInputError('RESOURCE_LIMIT');
  const used = n + (frames - 1) * hop, nyquist = sampleRate / 2, binWidth = sampleRate / n;
  const bands = settings.bands ?? defaultEdges.slice(0, -1).flatMap((lowHz, i) => lowHz < nyquist ? [{ id: `band_${i + 1}`, lowHz, highHz: Math.min(defaultEdges[i + 1], nyquist) }] : []);
  if (bands.some((b, i) => b.lowHz >= b.highHz || b.highHz > nyquist || (i > 0 && b.lowHz < bands[i - 1].highHz)) || new Set(bands.map(b => b.id)).size !== bands.length) throw new SpectrumInputError('INVALID_SETTINGS');
  // Validate the entire supplied buffer, even the explicitly unused tail. Do not silently discard invalid data.
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i]) || Math.abs(samples[i]) > SPECTRUM_LIMITS.maxFloatMagnitude) throw new SpectrumInputError('INVALID_PCM');
  const integer = input.format === 's16', referenced = integer || input.fullScale === 1;
  let sumSquares = 0, clipped = 0, run = 0, longestRun = 0;
  for (let i = 0; i < used; i++) {
    const value = integer ? samples[i] / 32768 : samples[i];
    sumSquares += value * value;
    const rail = integer ? samples[i] === -32768 || samples[i] === 32767 : Math.abs(value) >= 1;
    if (referenced && rail) { clipped++; run++; longestRun = Math.max(longestRun, run); } else run = 0;
  }
  const window = new Float64Array(n), real = new Float64Array(n), imaginary = new Float64Array(n), powers = new Float64Array(n / 2 + 1);
  let windowEnergy = 0;
  for (let i = 0; i < n; i++) { const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / n)); window[i] = w; windowEnergy += w * w; }
  const alpha = settings.smoothingAlpha;
  for (let frame = 0; frame < frames; frame++) {
    for (let i = 0; i < n; i++) real[i] = (integer ? samples[frame * hop + i] / 32768 : samples[frame * hop + i]) * window[i];
    imaginary.fill(0); fft(real, imaginary);
    for (let k = 0; k < powers.length; k++) {
      const factor = k === 0 || k === n / 2 ? 1 : 2;
      const power = factor * (real[k] * real[k] + imaginary[k] * imaginary[k]) / (n * windowEnergy);
      if (alpha === undefined) powers[k] += power / frames;
      else powers[k] = frame === 0 ? power : alpha * power + (1 - alpha) * powers[k];
    }
  }
  const total = powers.reduce((a, b) => a + b, 0);
  const bins = Array.from(powers, (p, k) => ({ frequencyHz: k * binWidth, ...level(p, referenced) }));
  const peaks = bins.flatMap((b, k) => b.power > 0 && (k === 0 || b.power > bins[k - 1].power) && (k === n / 2 || b.power >= bins[k + 1].power) ? [{ frequencyHz: b.frequencyHz, bin: k, level: level(b.power, referenced) }] : [])
    .sort((a, b) => b.level.power - a.level.power || a.bin - b.bin).slice(0, settings.peakCount);
  const rmsPower = sumSquares / used, rms = Math.sqrt(rmsPower);
  return {
    schemaVersion: 1, algorithmVersion: SPECTRUM_VERSION, mode: 'LAB', origin: { ...input.origin, ...(input.origin.target ? { target: { ...input.origin.target } } : {}) },
    provenanceVerification: 'caller_declared_not_verified', ...(input.inputTimestampMs === undefined ? {} : { inputTimestampMs: input.inputTimestampMs }),
    representation: { format: input.format, levelReference: referenced ? 'full_scale' : 'unreferenced_pcm' }, sampleRate,
    processing: { fftSize: n, hopSize: hop, window: 'periodic_hann', normalization: 'one_sided_power_window_energy', dcRemoval: false,
      aggregation: alpha === undefined ? 'mean_power' : 'ema_power', smoothingAlpha: alpha ?? null, peakCount: settings.peakCount, binWidthHz: binWidth },
    coverage: { inputSamples: samples.length, analyzedSamples: used, discardedTailSamples: samples.length - used, frames, durationSeconds: used / sampleRate },
    rms: { linear: rms, dbRelativeToUnit: powerDB(rmsPower), dbFS: referenced ? powerDB(rmsPower) : null },
    totalSpectralPower: level(total, referenced), bins,
    bands: bands.map(b => {
      const power = bins.reduce((sum, bin) => sum + (bin.frequencyHz >= b.lowHz && (bin.frequencyHz < b.highHz || (b.highHz === nyquist && bin.frequencyHz === nyquist)) ? bin.power : 0), 0);
      return { ...b, level: level(power, referenced), fractionOfTotalPower: total === 0 ? 0 : Math.min(1, power / total) };
    }), peaks,
    clipping: { status: !referenced ? 'unavailable' : clipped ? 'possible' : 'not_indicated', basis: integer ? 'integer_rails' : referenced ? 'declared_unit_full_scale' : 'unknown_float_scale',
      atOrBeyondFullScaleSamples: referenced ? clipped : null, fraction: referenced ? clipped / used : null, longestRun: referenced ? longestRun : null },
    limitations: [
      'Offline LAB analysis of supplied PCM only; no acquisition or verification of physical origin.',
      input.origin.kind === 'synthetic' ? 'Synthetic signal: not real band audio or evidence from the Soundcraft.' : 'Caller-supplied PCM: source, consent, capture path and calibration are not verified by this engine.',
      'Levels describe PCM units or declared digital full scale, not acoustic SPL, analog gain or audibility.',
      'Spectrum does not establish a defect, intelligibility, timbre quality, feedback or an EQ recommendation.',
      'Peaks are FFT-bin local maxima, not identified instruments or measured feedback frequencies.',
      'Possible clipping means samples at/beyond representable or declared full scale; absence does not rule out upstream clipping.',
      'Periodic Hann power normalization; bands sum bin centers without interpolation. DC is retained; gaps and out-of-band energy are possible.',
      'Spectral mean/EMA is window-weighted; RMS and clipping use the unwindowed analyzed prefix. Tail is reported and excluded.',
    ],
  };
}
