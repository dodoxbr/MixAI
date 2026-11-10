import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceError, FRAME_LIMITS, FrameError, NOTICE_TEXT_PT, PROVENANCE, analyzePcm, frameByteLength, measurementToFrame, spectrumEvidenceSchema, summarizeFrame, type PcmInput, type SpectrumFrame } from '../src/audio-intelligence/index.js';
import { noise, pcm, pilotOrigins, tones } from './fixtures/audio-intelligence/signals.js';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const life = { frameId: 'f1', sourceId: 'src_lab', generationId: 'g1', sequence: 3, contextRevision: 'ctx1', receivedAtUtc: '2026-11-09T12:00:00.000Z', receivedAtMonoMs: 1000, clockDomainId: 'proc1' };
const frameOf = (input: PcmInput): SpectrumFrame => measurementToFrame(analyzePcm(input), life);
const suppliedOrigin = { kind: 'supplied_pcm', sourceId: 'bench_file', conditionsId: 'cond_a', target: { kind: 'channel', channel: 8 }, path: 'electrical', tap: 'post_eq' } as const;
const code = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return e instanceof EvidenceError ? e.code : 'THROW ' + (e as Error).message; } };
const clone = (f: SpectrumFrame) => structuredClone(f) as any;

describe('summarizeFrame: senoides sintéticas', () => {
  it.each([[1171.875, 'alinhada ao bin'], [1500, 'fora do bin'], [1503.3, 'fora do bin 2']])('%f Hz (%s): um único pico no bin mais próximo, sem vazamento reportado', (hz) => {
    const e = summarizeFrame(frameOf(pcm(tones([[hz, 0.5]]), { origin: pilotOrigins.cavaco })));
    expect(e.availability).toEqual({ state: 'available' });
    expect(e.peaks.state).toBe('reported'); expect(e.peaks.items).toHaveLength(1);
    expect(Math.abs(e.peaks.items[0]!.frequencyHz - hz)).toBeLessThanOrEqual(e.resolution.binSpacingHz / 2 + 1e-9);
    expect(e.peaks.items[0]!.prominenceDb).toBeGreaterThanOrEqual(e.presentation.config.minProminenceDb);
  });
  it('duas senoides distintas: picos em ordem de nível; a de nível 50 dB abaixo do mais forte é omitida (maxDropDb)', () => {
    const two = summarizeFrame(frameOf(pcm(tones([[100, 0.5], [3000.7, 0.05]]))));
    expect(two.peaks.items.map(p => Math.round(p.frequencyHz / 100) * 100)).toEqual([100, 3000]);
    expect(two.peaks.items[0]!.levelDb).toBeGreaterThan(two.peaks.items[1]!.levelDb);
    const weak = summarizeFrame(frameOf(pcm(tones([[100.3, 0.5], [3000.7, 0.0005]]))));
    expect(weak.peaks.items).toHaveLength(1);
  });
  it('preserva os níveis originais; o piso só afeta a apresentação', () => {
    const f = frameOf(pcm(tones([[1500, 0.5]])));
    const e = summarizeFrame(f, { floorDbfs: -60 });
    expect(f.spectrum.grid.levels.length).toBe(2049);
    for (const b of e.bands) {
      const fb = f.spectrum.bands.find(x => x.id === b.id)!;
      expect(b.levelDb).toBe(fb.level);
      if (b.state === 'below_floor') expect(b.displayLevelDb).toBeGreaterThan(b.levelDb!);
    }
    expect(e.presentation.config.floorDbfs).toBe(-60);
  });
  it('o piso da banda sobe 10·log10(binCount): ruído fraco numa banda larga não é "nível válido"', () => {
    const e = summarizeFrame(frameOf(pcm(noise(8192, 1e-6))));
    expect(e.bands.every(b => b.state === 'below_floor' || b.state === 'unresolved')).toBe(true);
    expect(e.availability).toEqual({ state: 'insufficient_evidence', reasons: ['no_resolved_band_above_floor'] });
  });
});

describe('summarizeFrame: silêncio, piso e ausência de dados', () => {
  it('silêncio digital exato: exact_zero, sem picos, insufficient_evidence/no_energy (não é ausência de dados)', () => {
    const e = summarizeFrame(frameOf(pcm(new Float64Array(4096))));
    expect(e.levels).toMatchObject({ aboveFloor: 0, belowFloor: 0, exactZero: 2049 });
    expect(e.bands.every(b => b.state === 'exact_zero' || b.state === 'unresolved')).toBe(true);
    expect(e.bands.filter(b => b.state === 'exact_zero').every(b => b.levelDb === null && b.displayLevelDb === null)).toBe(true);
    expect(e.availability).toEqual({ state: 'insufficient_evidence', reasons: ['no_energy'] });
    expect(e.peaks).toMatchObject({ state: 'omitted', omissionReason: 'no_energy', items: [] });
    expect(JSON.stringify(e)).not.toMatch(/Infinity|NaN/);
  });
  it('ruído numérico (≈ −300 dBFS num tom puro) fica abaixo do piso, distinto de zero exato', () => {
    const e = summarizeFrame(frameOf(pcm(tones([[1171.875, 0.5]]))));
    expect(e.levels.belowFloor).toBeGreaterThan(2000); expect(e.levels.exactZero).toBe(0);
    expect(e.levels.aboveFloor + e.levels.belowFloor + e.levels.exactZero).toBe(e.levels.totalBins);
  });
  it('ruído muito baixo (todo abaixo do piso) não tem picos nem disponibilidade', () => {
    const e = summarizeFrame(frameOf(pcm(noise(8192, 1e-7))));
    expect(e.levels.aboveFloor).toBe(0);
    expect(e.availability.state).toBe('insufficient_evidence');
    expect(e.peaks).toMatchObject({ state: 'omitted', items: [] });
  });
  it('ruído de banda larga: nenhum pico (o maior bin de ruído não é proeminente sobre a mediana local)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = new Float64Array(16384); let x = seed * 7919;
      for (let i = 0; i < s.length; i++) { x = (1664525 * x + 1013904223) >>> 0; s[i] = 0.3 * (2 * x / 2 ** 32 - 1); }
      const e = summarizeFrame(frameOf(pcm(s)));
      expect(e.availability).toEqual({ state: 'available' });
      expect(e.peaks).toMatchObject({ state: 'omitted', omissionReason: 'no_prominent_peak', items: [] });
    }
  });
  it('um tom sobre ruído de banda larga é reportado', () => {
    const s = Float64Array.from(noise(8192, 0.05), (v, i) => v + 0.3 * Math.sin(2 * Math.PI * 2000.4 * i / 48000));
    const e = summarizeFrame(frameOf(pcm(s)));
    expect(e.peaks.items).toHaveLength(1); expect(Math.abs(e.peaks.items[0]!.frequencyHz - 2000.4)).toBeLessThan(e.resolution.binSpacingHz);
  });
  it('pico não proeminente (platô/degrau suave) não é reportado', () => {
    const f = clone(frameOf(pcm(noise(8192))));
    f.spectrum.grid.levels = f.spectrum.grid.levels.map((_: unknown, i: number) => -60 - i * 0.01);
    f.spectrum.grid.levels[500] += 8;
    expect(summarizeFrame(f).peaks).toMatchObject({ state: 'omitted', omissionReason: 'no_prominent_peak' });
  });
  it('minProminenceDb configurável: 6 dB aceita o degrau de 8 dB, 20 dB não', () => {
    const f = clone(frameOf(pcm(noise(8192))));
    f.spectrum.grid.levels = f.spectrum.grid.levels.map((_: unknown, i: number) => -60 - (i % 2) * 0.1);
    f.spectrum.grid.levels[500] += 8;
    expect(summarizeFrame(f, { minProminenceDb: 6 }).peaks.state).toBe('reported');
    expect(summarizeFrame(f).peaks.state).toBe('omitted');
  });
  it('banda sem resolução (binCount = 0): unresolved, sem nível; não é silêncio', () => {
    const e = summarizeFrame(frameOf(pcm(tones([[100, 0.5]], 48000, 4096), { settings: { fftSize: 256, hopSize: 256 } })));
    expect(e.bands[0]).toMatchObject({ id: 'band_1', state: 'unresolved', binCount: 0, levelDb: null, displayLevelDb: null, fractionOfTotalPower: null });
    expect(e.notices).toContain('unresolved_bands_present');
  });
});

describe('summarizeFrame: resolução, escala e qualidade', () => {
  it('resolução grossa (256 pontos): sem picos, mesmo havendo energia', () => {
    const e = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]], 48000, 4096), { settings: { fftSize: 256, hopSize: 256 } })));
    expect(e.peaks).toMatchObject({ state: 'omitted', omissionReason: 'resolution_too_coarse', items: [] });
    expect(e.availability.state).toBe('available');
    expect(summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { settings: { fftSize: 1024 } }))).peaks.state).toBe('reported');
  });
  it('escala digital conhecida: dBFS por bin, piso aplicado, referência digital', () => {
    const e = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]))));
    expect(e.scale).toMatchObject({ unit: 'dbfs_power_per_bin', calibration: 'digital_reference' });
    expect(e.presentation.floorApplied).toBe(true);
    expect(e.notices).not.toContain('scale_uncalibrated');
  });
  it('escala desconhecida: relativa, sem piso, sem picos, com aviso', () => {
    const e = summarizeFrame(frameOf({ ...pcm(tones([[1500, 0.5]])), fullScale: null } as PcmInput));
    expect(e.scale).toMatchObject({ unit: 'relative_unknown', calibration: 'uncalibrated' });
    expect(e.presentation.floorApplied).toBe(false);
    expect(e.levels.belowFloor).toBe(0);
    expect(e.peaks).toMatchObject({ state: 'omitted', omissionReason: 'scale_uncalibrated', items: [] });
    expect(e.notices).toContain('scale_uncalibrated');
    expect(e.bands.some(b => b.state === 'below_floor')).toBe(false);
  });
  it('clipping digital possível: evidência insuficiente e sem picos, mas o resumo das bandas é preservado', () => {
    const e = summarizeFrame(frameOf(pcm(tones([[1500, 1.5]]))));
    expect(e.quality).toMatchObject({ frameConfidence: 'insufficient', clippingPossible: true });
    expect(e.quality.clippingFraction).toBeGreaterThan(0);
    expect(e.availability).toEqual({ state: 'insufficient_evidence', reasons: ['quality_insufficient'] });
    expect(e.peaks).toMatchObject({ state: 'omitted', omissionReason: 'quality_insufficient' });
    expect(e.bands.some(b => b.state === 'resolved_level')).toBe(true);
  });
  it('confiança insuficiente por qualquer motivo (não só clipping) torna a evidência insuficiente e omite picos', () => {
    for (const reasons of [['declared_not_verified'], [], ['unresolved_band'], ['outro_motivo']]) {
      const f = clone(frameOf(pcm(tones([[1500, 0.5]])))); f.quality.confidence = 'insufficient'; f.quality.reasons = reasons;
      const e = summarizeFrame(f);
      expect(e.availability, reasons.join()).toEqual({ state: 'insufficient_evidence', reasons: ['quality_insufficient'] });
      expect(e.peaks).toMatchObject({ state: 'omitted', omissionReason: 'quality_insufficient', items: [] });
      expect(e.quality.frameConfidence).toBe('insufficient');
      expect(e.bands.some(b => b.state === 'resolved_level')).toBe(true);
    }
  });
  it('confiança limitada com energia continua disponível; silêncio mantém apenas no_energy (sem duplicar motivo)', () => {
    expect(summarizeFrame(frameOf(pcm(tones([[1500, 0.5]])))).availability).toEqual({ state: 'available' });
    const f = clone(frameOf(pcm(new Float64Array(4096)))); expect(f.quality.confidence).toBe('insufficient');
    expect(summarizeFrame(f).availability).toEqual({ state: 'insufficient_evidence', reasons: ['no_energy'] });
    f.quality.reasons = []; expect(summarizeFrame(f).availability).toEqual({ state: 'insufficient_evidence', reasons: ['no_energy'] });
  });
  it('clipping informado pelo quadro vem da fração, não de um texto de motivo', () => {
    const f = clone(frameOf(pcm(tones([[1500, 1.5]])))); f.quality.reasons = [];
    expect(summarizeFrame(f).quality.clippingPossible).toBe(true);
  });
  it('clipping indisponível (escala desconhecida) não vira "sem clipping"', () => {
    const e = summarizeFrame(frameOf({ ...pcm(tones([[1500, 0.5]])), fullScale: null } as PcmInput));
    expect(e.quality.clippingPossible).toBeNull(); expect(e.quality.clippingFraction).toBeNull();
  });
});

describe('summarizeFrame: proveniência e rota', () => {
  it('sintético ⇒ simulated; PCM fornecido ⇒ declared_unverified; nunca measured_verified', () => {
    const sim = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { origin: pilotOrigins.surdo })));
    const dec = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { origin: suppliedOrigin })));
    expect([sim.provenance, dec.provenance]).toEqual(['simulated', 'declared_unverified']);
    expect(PROVENANCE).toContain('measured_verified');
    for (const e of [sim, dec]) expect(JSON.stringify(e)).not.toMatch(/measured_verified|"measured"/);
    expect(sim.notices).toContain('synthetic_not_measured'); expect(dec.notices).toContain('declared_origin_unverified');
    expect(dec.notices).toContain('electrical_not_acoustic');
  });
  it('o esquema da evidência recusa measured_verified, adulteração de guardas e estados incoerentes', () => {
    const ok = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { origin: suppliedOrigin })));
    const bad = (mut: (e: any) => void) => { const e = structuredClone(ok) as any; mut(e); return spectrumEvidenceSchema.safeParse(e).success; };
    expect(spectrumEvidenceSchema.safeParse(ok).success).toBe(true);
    expect(bad(e => { e.provenance = 'measured_verified'; })).toBe(false);
    expect(bad(e => { e.provenance = 'measured'; })).toBe(false);
    expect(bad(e => { e.guards.eqRecommendation = 'boost'; })).toBe(false);
    expect(bad(e => { e.guards.authorization = 'granted'; })).toBe(false);
    expect(bad(e => { e.guards.realWrites = true; })).toBe(false);
    expect(bad(e => { e.extra = 1; })).toBe(false);
    expect(bad(e => { e.scale.calibration = 'uncalibrated'; })).toBe(false);
    expect(bad(e => { e.presentation.floorApplied = false; })).toBe(false);
    expect(bad(e => { e.peaks.state = 'omitted'; })).toBe(false);
    expect(bad(e => { e.bands[0].state = 'unresolved'; })).toBe(false);
    expect(bad(e => { e.availability = { state: 'insufficient_evidence', reasons: [] }; })).toBe(false);
  });
  it('AUX1 permanece barramento compartilhado; sem alvo, rota desconhecida', () => {
    const aux = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { origin: pilotOrigins.aux1 })));
    expect(aux.routeCaveat).toBe('shared_bus_not_isolated'); expect(aux.notices).toContain('shared_bus_not_isolated');
    const unk = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]))));
    expect(unk.signal).toEqual({ kind: 'unknown' }); expect(unk.routeCaveat).toBe('route_unknown');
    expect(summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { origin: pilotOrigins.voz }))).routeCaveat).toBe('none');
  });
  it('preserva a referência do quadro e nenhum campo temporal inventado', () => {
    const e = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { inputTimestampMs: 99887 })));
    expect(e.frameRef).toEqual({ frameId: 'f1', sourceId: 'src_lab', generationId: 'g1', sequence: 3, contextRevision: 'ctx1', frameVersion: 'spectrum-frame-r1' });
    expect(JSON.stringify(e)).not.toContain('99887');
    expect(e.id).toMatch(/^ev_[0-9a-f]{32}$/);
  });
  it('id: determinístico; muda com o conteúdo do quadro, com a referência e com a configuração (sem colisão por referência reutilizada)', () => {
    const a = frameOf(pcm(tones([[1500, 0.5]])));
    const b = frameOf(pcm(tones([[3000, 0.5]]))); // mesma referência de ciclo de vida (life), conteúdo diferente
    expect(a.id).toBe(b.id); expect(a.generationId).toBe(b.generationId); expect(a.sequence).toBe(b.sequence);
    const ids = new Set([summarizeFrame(a).id, summarizeFrame(b).id, summarizeFrame(a, { floorDbfs: -100 }).id, summarizeFrame(measurementToFrame(analyzePcm(pcm(tones([[1500, 0.5]]))), { ...life, sequence: 4 })).id,
      summarizeFrame(measurementToFrame(analyzePcm(pcm(tones([[1500, 0.5]]))), { ...life, generationId: 'g2' })).id, summarizeFrame(measurementToFrame(analyzePcm(pcm(tones([[1500, 0.5]]))), { ...life, contextRevision: 'ctx2' })).id]);
    expect(ids.size).toBe(6);
    expect(summarizeFrame(a).id).toBe(summarizeFrame(structuredClone(a)).id);
    const tiny = clone(a); tiny.spectrum.grid.levels[0] = (tiny.spectrum.grid.levels[0] ?? 0) + 1e-9;
    expect(summarizeFrame(tiny).id).not.toBe(summarizeFrame(a).id);
  });
  it('id: 200 quadros distintos com a mesma referência produzem 200 ids distintos', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(summarizeFrame(frameOf(pcm(tones([[200 + i * 37.3, 0.4]])))).id);
    expect(ids.size).toBe(200);
  });
  it('nunca afirma diagnóstico, microfonia, corte ou número de EQ', () => {
    const e = summarizeFrame(frameOf(pcm(tones([[1500, 0.5]]), { origin: pilotOrigins.cavaco })));
    expect(e.guards).toEqual({ diagnosis: 'none', eqRecommendation: 'none', authorization: 'not_granted', execution: 'not_executable', realWrites: false });
    expect(e.peaks.meaning).toBe('local_spectral_maximum');
    const text = JSON.stringify(e) + Object.values(NOTICE_TEXT_PT).join(' ');
    expect(text).not.toMatch(/"(?:cut|boost|gain|eqDelta|recommend\w*|suggest\w*|problem|defect|feedback|microfonia)"/i);
    expect(Object.keys(e)).not.toContain('recommendation');
    expect(e.notices).toEqual(expect.arrayContaining(['energy_is_not_quality', 'peaks_are_local_maxima', 'levels_are_digital_not_spl']));
  });
});

describe('summarizeFrame: validação rigorosa e limites', () => {
  const good = () => clone(frameOf(pcm(tones([[1500, 0.5]]), { origin: suppliedOrigin })));
  it('quadro adulterado ou incoerente é recusado (INVALID_FRAME)', () => {
    const muts: [string, (f: any) => void][] = [
      ['measured', f => { f.origin = { kind: 'audio_capture', measurement: 'measured', deviceAlias: 'x', inputIndex: 1, validationRecordId: 'v' }; }],
      ['validated', f => { f.quality.confidence = 'validated_for_point'; }],
      ['unit/calibration', f => { f.spectrum.calibration = 'uncalibrated'; }],
      ['levels length', f => { f.spectrum.grid.levels.pop(); }],
      ['spacing', f => { f.spectrum.grid.spacingHz = 10; f.resolution.binSpacingHz = 10; }],
      ['binCount', f => { f.spectrum.bands[2].binCount += 1; }],
      ['mock/domain', f => { f.origin = { kind: 'mock', measurement: 'simulated', fixtureId: 'x', seed: null }; }],
      ['NaN level', f => { f.spectrum.grid.levels[10] = Number.NaN; }],
      ['string level', f => { f.spectrum.grid.levels[10] = '-10'; }],
      ['extra key', f => { f.samples = [1, 2]; }],
      ['version', f => { f.frameVersion = 'spectrum-frame-r2'; }],
      ['unresolved with level', f => { f.spectrum.bands[0].coverage = 'unresolved'; }],
      ['channel 99', f => { f.signal = { kind: 'input', channel: 99 }; }],
    ];
    for (const [name, mut] of muts) { const f = good(); mut(f); expect(code(() => summarizeFrame(f)), name).toBe('INVALID_FRAME'); }
    for (const x of [null, undefined, 'x', 42, [], {}]) expect(code(() => summarizeFrame(x))).toBe('INVALID_FRAME');
  });
  it('configuração inválida é recusada (INVALID_CONFIG)', () => {
    const f = good();
    for (const c of [{ floorDbfs: 0 }, { floorDbfs: Number.NaN }, { minProminenceDb: 1 }, { maxPeaks: 99 }, { extra: 1 }, { guardBins: 0 }, 'x'])
      expect(code(() => summarizeFrame(f, c)), JSON.stringify(c)).toBe('INVALID_CONFIG');
    expect(summarizeFrame(f, undefined).presentation.config.floorDbfs).toBe(-120);
  });
  it('maxPeaks 0 desativa picos', () => {
    expect(summarizeFrame(good(), { maxPeaks: 0 }).peaks).toMatchObject({ state: 'omitted', omissionReason: 'peaks_disabled' });
  });
  it('limite de payload usa bytes UTF-8, não o comprimento da string', () => {
    const multi = '€'.repeat(90_000);
    expect(multi.length).toBeLessThan(FRAME_LIMITS.maxBytes); expect(Buffer.byteLength(multi, 'utf8')).toBeGreaterThan(FRAME_LIMITS.maxBytes);
    expect(frameByteLength({ s: multi })).toBeGreaterThan(FRAME_LIMITS.maxBytes);
    const m = analyzePcm(pcm(tones([[1500, 0.5]]))) as any;
    // Adaptador: a medição com texto multibyte é recusada pelo tamanho real.
    let err: unknown; try { measurementToFrame({ ...m, limitations: [multi] }, life); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FrameError); expect((err as FrameError).code).toBe('RESOURCE_LIMIT');
    // Consumidor: o mesmo quadro (válido no esquema) acima do limite é recusado.
    const f = good(); f.limitations = [multi];
    expect(code(() => summarizeFrame(f))).toBe('RESOURCE_LIMIT');
  });
  it('quadro de 4096 bins máximos cabe; resumo é pequeno (sem níveis por bin)', () => {
    const f = frameOf(pcm(noise(16384), { settings: { fftSize: 4096 } }));
    const e = summarizeFrame(f);
    expect(frameByteLength(f)).toBeLessThanOrEqual(FRAME_LIMITS.maxBytes);
    expect(frameByteLength(e)).toBeLessThan(frameByteLength(f) / 4);
    expect(JSON.stringify(e)).not.toContain('"levels":[');
  });
  it('é determinística, não altera o quadro e o custo é baixo (limite folgado)', () => {
    const f = frameOf(pcm(noise(16384), { settings: { fftSize: 4096 } }));
    const before = JSON.stringify(f), t = performance.now();
    const a = JSON.stringify(summarizeFrame(f)); for (let i = 0; i < 20; i++) summarizeFrame(f);
    expect((performance.now() - t) / 21).toBeLessThan(100);
    expect(JSON.stringify(summarizeFrame(f))).toBe(a); expect(JSON.stringify(f)).toBe(before);
  });
  it('pior caso de proeminência (serra com 2048 candidatos) fica limitado', () => {
    const f = clone(frameOf(pcm(noise(16384), { settings: { fftSize: 4096 } })));
    f.spectrum.grid.levels = f.spectrum.grid.levels.map((_: unknown, i: number) => (i % 2 ? -10 : -50));
    const t = performance.now(); summarizeFrame(f); expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('fronteira do módulo', () => {
  it('evidence.ts importa só zod, node:crypto e quadro local; sem relógio, rede, aleatoriedade, mesa ou AutoConfig', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'audio-intelligence', 'evidence.ts'), 'utf8');
    expect([...src.matchAll(/from '([^']+)'/g)].map(m => m[1])).toEqual(['node:crypto', 'zod', './frame.js']);
    expect(src).not.toMatch(/Date\.now|new Date|Math\.random|performance\.now|fetch\(|process\.|require\(|readFile|writeFile/);
  });
  it('nenhum arquivo fora do módulo e dos testes importa audio-intelligence (não ligado à interface nem ao AutoConfig)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'audio-intelligence'].includes(e.name)) walk(p); }
      else if (/\.(ts|html)$/.test(e.name) && /audio-intelligence/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(PROJECT_ROOT.length + 1).replace(/\\/g, '/'));
    } };
    walk(join(PROJECT_ROOT, 'src')); walk(join(PROJECT_ROOT, 'web', 'src'));
    expect(offenders).toEqual([]);
  });
});
