import { expect, it } from 'vitest';
import { analyzePcm, compareSpectra, pcmInputSchema, spectrumMeasurementSchema, SpectrumInputError, SPECTRUM_LIMITS } from '../src/audio-intelligence/index.js';
import { noise, pcm, pilotOrigins, tones } from './fixtures/audio-intelligence/signals.js';

it.each([8000, 16000, 44100, 48000, 96000, 192000])('senoide conhecida a %i Hz de amostragem: frequência, RMS e normalização de potência', sampleRate => {
  const hz = sampleRate * 128 / 4096, result = analyzePcm(pcm(tones([[hz, 0.5]], sampleRate), { sampleRate }));
  expect(result.peaks[0].frequencyHz).toBe(hz);
  expect(result.rms.linear).toBeCloseTo(0.5 / Math.sqrt(2), 12);
  expect(result.rms.dbFS).toBeCloseTo(-9.03089987, 7);
  expect(result.totalSpectralPower.power).toBeCloseTo(0.125, 12);
  expect(result.bins.reduce((s, b) => s + b.power, 0)).toBe(result.totalSpectralPower.power);
  expect(spectrumMeasurementSchema.safeParse(result).success).toBe(true);
});
it.each([997, 1511.4])('senoide fora do bin: pico com erro limitado à resolução (%s Hz)', hz => {
  const result = analyzePcm(pcm(tones([[hz, 0.4]])));
  expect(Math.abs(result.peaks[0].frequencyHz - hz)).toBeLessThanOrEqual(result.processing.binWidthHz / 2);
  expect(result.totalSpectralPower.power).toBeCloseTo(0.08, 5);
});
it('múltiplas frequências, bandas e razão de energia; sem interpretação de timbre', () => {
  const result = analyzePcm(pcm(tones([[93.75, 0.2], [1500, 0.4], [6000, 0.1]])));
  expect(result.peaks.slice(0, 3).map(p => p.frequencyHz)).toEqual([1500, 93.75, 6000]);
  expect(result.bands.find(b => b.id === 'band_2')!.level.power).toBeCloseTo(0.02, 10);
  expect(result.bands.find(b => b.id === 'band_4')!.level.power).toBeCloseTo(0.08, 10);
  expect(result.bands.find(b => b.id === 'band_6')!.level.power).toBeCloseTo(0.005, 10);
  expect(result.totalSpectralPower.power).toBeCloseTo(0.105, 10);
  expect(result).not.toHaveProperty('recommendations'); expect(result).not.toHaveProperty('commands');
});
it.each([0, 1, -1])('DC e silêncio (%i): energia unilateral sem dobrar extremos', value => {
  const result = analyzePcm(pcm(new Float64Array(4096).fill(value)));
  expect(result.rms.linear).toBe(Math.abs(value));
  expect(result.totalSpectralPower.power).toBeCloseTo(value * value, 12);
  if (value === 0) {
    expect(result.peaks).toEqual([]); expect(result.rms.dbFS).toBeNull();
    expect(result.bands.every(b => b.level.power === 0 && b.level.dbFS === null && b.fractionOfTotalPower === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN/);
  } else expect(result.peaks[0].frequencyHz).toBe(0);
});
it('Nyquist não é duplicado na normalização e entra na última banda', () => {
  const result = analyzePcm(pcm(Float64Array.from({ length: 4096 }, (_, i) => i % 2 ? -0.5 : 0.5), {
    settings: { fftSize: 4096, bands: [{ id: 'all', lowHz: 0, highHz: 24000 }] },
  }));
  expect(result.peaks[0].frequencyHz).toBe(24000);
  expect(result.totalSpectralPower.power).toBeCloseTo(0.25, 12);
  expect(result.bands[0].level.power).toBeCloseTo(0.25, 12);
});
it('banda sem centros de bins declara falta de cobertura; zero agregado não comprova ausência de energia', () => {
  const result = analyzePcm(pcm(tones([[50, 0.5]], 48000, 256), { settings: { fftSize: 256 } }));
  const low = result.bands[0];
  expect(low).toMatchObject({ lowHz: 20, highHz: 80, binCount: 0, level: { power: 0 } });
  expect(result.processing.binWidthHz).toBe(187.5);
  expect(result.totalSpectralPower.power).toBeGreaterThan(0);
  const comparison = compareSpectra(result, result);
  expect(comparison.kind).toBe('comparison');
  if (comparison.kind === 'comparison') expect(comparison.bands[0]).toMatchObject({ binCount: 0, power: null });
});
it('ruído determinístico concorda com DFT direta independente em bins selecionados', () => {
  const samples = noise(256), result = analyzePcm(pcm(samples, { settings: { fftSize: 256 } }));
  for (const k of [0, 1, 17, 57, 127, 128]) {
    let real = 0, imaginary = 0, energy = 0;
    for (let i = 0; i < samples.length; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / samples.length);
      energy += w * w;
      real += samples[i] * w * Math.cos(2 * Math.PI * k * i / samples.length);
      imaginary -= samples[i] * w * Math.sin(2 * Math.PI * k * i / samples.length);
    }
    const expected = (k === 0 || k === 128 ? 1 : 2) * (real ** 2 + imaginary ** 2) / (256 * energy);
    expect(result.bins[k].power).toBeCloseTo(expected, 13);
  }
  expect(result.rms.linear).toBeGreaterThan(0.1);
  expect(result.peaks.length).toBeLessThanOrEqual(8);
  expect(result.clipping.status).toBe('not_indicated');
});
it('Hann reduz vazamento distante comparado à janela retangular em tom fora do bin', () => {
  const samples = tones([[997, 0.5]]), result = analyzePcm(pcm(samples));
  const k = 150;
  let real = 0, imaginary = 0;
  for (let i = 0; i < samples.length; i++) { const angle = 2 * Math.PI * k * i / samples.length; real += samples[i] * Math.cos(angle); imaginary -= samples[i] * Math.sin(angle); }
  const rectangularPower = 2 * (real ** 2 + imaginary ** 2) / samples.length ** 2;
  expect(result.bins[k].power).toBeLessThan(rectangularPower / 100);
});
it('PCM s16 normaliza RMS e reporta somente clipping possível nos trilhos inteiros', () => {
  const samples = new Int16Array(4096).fill(16384); samples[0] = -32768; samples[1] = 32767;
  const result = analyzePcm({ mode: 'LAB', channels: 1, format: 's16', sampleRate: 48000, origin: pilotOrigins.voz, samples, settings: { fftSize: 4096 } });
  expect(result.clipping).toMatchObject({ status: 'possible', basis: 'integer_rails', atOrBeyondFullScaleSamples: 2, longestRun: 2, fraction: 2 / 4096 });
  expect(result.rms.linear).toBeCloseTo(Math.sqrt((4094 * 0.25 + 1 + (32767 / 32768) ** 2) / 4096), 12);
});
it('float32 normalizado e sinal saturado/overs não são confundidos com confirmação de clipping analógico', () => {
  const samples = Float32Array.from({ length: 4096 }, (_, i) => i % 2 ? -1.25 : 1.25);
  const result = analyzePcm({ ...pcm(), format: 'f32', samples });
  expect(result.clipping).toMatchObject({ status: 'possible', basis: 'declared_unit_full_scale', fraction: 1, longestRun: 4096 });
  expect(result.rms.dbFS).toBeGreaterThan(0);
  expect(result.limitations.join(' ')).toContain('upstream clipping');
});
it('float sem escala conhecida não autoriza dBFS nem avaliação de clipping', () => {
  const result = analyzePcm(pcm(new Float64Array(4096).fill(10), { fullScale: null, origin: { ...pilotOrigins.voz, kind: 'supplied_pcm' } }));
  expect(result.clipping).toEqual({ status: 'unavailable', basis: 'unknown_float_scale', atOrBeyondFullScaleSamples: null, fraction: null, longestRun: null });
  expect(result.rms).toMatchObject({ linear: 10, dbFS: null, dbRelativeToUnit: 20 });
  expect(result.bins.every(b => b.dbFS === null)).toBe(true);
  expect(result.provenanceVerification).toBe('caller_declared_not_verified');
  expect(result.limitations.join(' ')).toContain('not verified');
});
it('média e EMA atuam em potência; RMS não depende da suavização; não há estado entre chamadas', () => {
  const samples = new Float64Array(8192); samples.set(tones([[1500, 0.5]])); samples.set(tones([[6000, 0.5]]), 4096);
  const build = (smoothingAlpha?: number) => pcm(samples, { settings: { fftSize: 4096, hopSize: 4096, smoothingAlpha } });
  const mean = analyzePcm(build()), slow = analyzePcm(build(0.1)), last = analyzePcm(build(1));
  expect(mean.processing.aggregation).toBe('mean_power');
  expect(slow.peaks[0].frequencyHz).toBe(1500); expect(last.peaks[0].frequencyHz).toBe(6000);
  expect(slow.bins[128].power / mean.bins[128].power).toBeCloseTo(1.8, 8);
  expect(slow.rms).toEqual(last.rms);
  expect(analyzePcm(build(0.1))).toEqual(slow);
});
it('sobreposição e cauda: não duplica RMS, não altera entrada e informa cobertura exata', () => {
  const samples = new Float64Array(4096 + 2048 + 11).fill(0.25), copy = samples.slice();
  const result = analyzePcm(pcm(samples));
  expect(result.coverage).toEqual({ inputSamples: 6155, analyzedSamples: 6144, discardedTailSamples: 11, frames: 2, durationSeconds: 6144 / 48000 });
  expect(result.rms.linear).toBe(0.25); expect(samples).toEqual(copy);
});
it.each([
  null, {}, { ...pcm(), mode: 'REAL' }, { ...pcm(), format: 's24' }, { ...pcm(), samples: [1, 2, 3] },
  { ...pcm(), format: 's16' }, { ...pcm(), format: 'f32' }, { ...pcm(), fullScale: undefined },
  { ...pcm(), sampleRate: 0 }, { ...pcm(), sampleRate: 44100.5 }, { ...pcm(), sampleRate: 384000 },
  { ...pcm(), origin: { ...pilotOrigins.voz, kind: 'real_verified' } }, { ...pcm(), channels: 2 },
  { ...pcm(), settings: { fftSize: 1000 } }, { ...pcm(), settings: { fftSize: 32768 } },
  { ...pcm(), settings: { smoothingAlpha: 0 } }, { ...pcm(), settings: { peakCount: 33 } },
])('recusa entrada/forma não suportada %#', input => { expect(() => analyzePcm(input)).toThrow(SpectrumInputError); });
it.each([NaN, Infinity, -Infinity, 1_000_001])('valida todos os valores, inclusive cauda descartada (%s)', value => {
  const samples = new Float64Array(4097); samples[4096] = value;
  expect(() => analyzePcm(pcm(samples))).toThrow('INVALID_PCM');
});
it('recusa memória compartilhada, poucos dados, excesso de amostras/frames e opções perigosas', () => {
  expect(() => analyzePcm({ ...pcm(), samples: new Float64Array(new SharedArrayBuffer(4096 * 8)) })).toThrow('INVALID_PCM');
  expect(() => analyzePcm(pcm(new Float64Array(4095)))).toThrow('INSUFFICIENT_SAMPLES');
  expect(() => analyzePcm(pcm(new Float64Array(SPECTRUM_LIMITS.maxSamples + 1)))).toThrow('RESOURCE_LIMIT');
  expect(() => analyzePcm(pcm(new Float64Array(262144), { settings: { fftSize: 256, hopSize: 64 } }))).toThrow('RESOURCE_LIMIT');
  for (const hopSize of [1, 4097]) expect(() => analyzePcm(pcm(undefined, { settings: { fftSize: 4096, hopSize } }))).toThrow('INVALID_SETTINGS');
  for (const bands of [
    [{ id: 'a', lowHz: 500, highHz: 200 }], [{ id: 'a', lowHz: 0, highHz: 25000 }],
    [{ id: 'a', lowHz: 0, highHz: 100 }, { id: 'b', lowHz: 50, highHz: 200 }],
    [{ id: 'a', lowHz: 0, highHz: 100 }, { id: 'a', lowHz: 100, highHz: 200 }],
  ]) expect(() => analyzePcm(pcm(undefined, { settings: { fftSize: 4096, bands } }))).toThrow('INVALID_SETTINGS');
});
it('limites superiores funcionam e quantidade de saída é limitada', () => {
  const result = analyzePcm(pcm(noise(262144), { settings: { fftSize: 16384, hopSize: 16384, peakCount: 32 } }));
  expect(result.bins).toHaveLength(8193); expect(result.peaks).toHaveLength(32);
  expect(result.coverage.frames).toBe(16);
});
it('comparação antes/depois preserva origem, usa dB de razão e não recomenda ajustes', () => {
  const before = analyzePcm(pcm(tones([[1500, 0.2]]))), after = analyzePcm(pcm(tones([[1500, 0.4]])));
  const result = compareSpectra(before, after);
  expect(result.kind).toBe('comparison');
  if (result.kind !== 'comparison') throw Error('comparison');
  expect(result.rms.deltaDB).toBeCloseTo(6.02059991, 7);
  expect(result.bands.find(b => b.id === 'band_4')!.power!.deltaDB).toBeCloseTo(6.02059991, 7);
  expect(result.comparability).toBe('caller_declared_conditions_match');
  expect(result).not.toHaveProperty('eq'); expect(result).not.toHaveProperty('approved');
});
it('comparação com silêncio não inventa diferença finita', () => {
  const zero = analyzePcm(pcm(new Float64Array(4096))), tone = analyzePcm(pcm());
  for (const [before, after, transition] of [[zero, zero, 'both_zero'], [zero, tone, 'from_zero'], [tone, zero, 'to_zero']] as const) {
    const result = compareSpectra(before, after);
    expect(result.kind).toBe('comparison');
    if (result.kind === 'comparison') expect(result.rms).toMatchObject({ transition, deltaDB: null });
    expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN/);
  }
});
it('recusa condições ausentes/diferentes, fontes, destinos, formatos, resolução, escala e durações diferentes', () => {
  const input = pcm(), before = analyzePcm(input);
  const variants = [
    { ...input, origin: { ...input.origin, conditionsId: undefined } },
    { ...input, origin: { ...input.origin, conditionsId: 'new_setup' } },
    { ...input, origin: { ...input.origin, sourceId: 'other_source' } },
    { ...input, origin: { ...input.origin, kind: 'supplied_pcm' } },
    { ...input, origin: { ...input.origin, target: { kind: 'bus', bus: 'AUX1' } } },
    { ...input, origin: { ...input.origin, tap: 'post_eq' } },
    { ...input, origin: { ...input.origin, path: 'acoustic' } },
    { ...input, sampleRate: 44100 }, { ...input, fullScale: null },
    { ...input, format: 'f32', samples: new Float32Array(4096) },
    { ...input, settings: { fftSize: 2048 } }, { ...input, settings: { fftSize: 4096, smoothingAlpha: 0.5 } },
    { ...input, settings: { fftSize: 4096, bands: [{ id: 'different', lowHz: 20, highHz: 1000 }] } },
    { ...input, samples: new Float64Array(8192) },
  ];
  for (const variant of variants) expect(compareSpectra(before, analyzePcm(variant)).kind).toBe('incomparable');
  expect(compareSpectra({}, before)).toEqual({ kind: 'incomparable', reasons: ['invalid_measurement'] });
  const malformed = structuredClone(before); malformed.bins.pop();
  expect(compareSpectra(malformed, before)).toEqual({ kind: 'incomparable', reasons: ['invalid_grid_or_coverage'] });
});
it.each([
  ['surdo', [[46.875, 0.5]], [[187.5, 0.5]], 'band_1'],
  ['voz', [[750, 0.5]], [[3000, 0.5]], 'band_4'],
  ['cavaco', [[3000, 0.5]], [[9000, 0.5]], 'band_5'],
  ['aux1', [[93.75, 0.2], [1500, 0.2]], [[93.75, 0.1], [1500, 0.2], [6000, 0.1]], 'band_2'],
] as const)('piloto %s: mede distribuição sintética, nunca defeito de instrumento', (name, first, second, band) => {
  const origin = pilotOrigins[name];
  const before = analyzePcm(pcm(tones(first.map(t => [...t])), { origin })), after = analyzePcm(pcm(tones(second.map(t => [...t])), { origin }));
  expect(before.origin.target).toEqual(origin.target); expect(before.origin.kind).toBe('synthetic');
  expect(compareSpectra(before, after).kind).toBe('comparison');
  expect(before.bands.find(b => b.id === band)!.level.power).toBeGreaterThan(0);
  expect(before.limitations.join(' ')).toContain('Synthetic signal');
  expect(before).not.toHaveProperty('diagnosis');
});
it('contrato de entrada é explícito e resultado serializado é validado sem conter PCM', () => {
  expect(pcmInputSchema.safeParse(pcm()).success).toBe(true);
  const result = analyzePcm(pcm());
  expect(spectrumMeasurementSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  expect(result).not.toHaveProperty('samples');
});
