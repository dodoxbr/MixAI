import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzePcm, FRAME_LIMITS, FrameError, SCALE_DEFINITION_ID, measurementToFrame, spectrumFrameSchema, type PcmInput } from '../src/audio-intelligence/index.js';
import { noise, pcm, pilotOrigins, tones } from './fixtures/audio-intelligence/signals.js';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const life = (over: Record<string, unknown> = {}) => ({ frameId: 'f1', sourceId: 'src_lab', generationId: 'g1', sequence: 1, contextRevision: 'ctx1',
  receivedAtUtc: '2026-11-09T12:00:00.000Z', receivedAtMonoMs: 1000, clockDomainId: 'proc1', ...over });
const measure = (input: PcmInput) => analyzePcm(input);
const code = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return e instanceof FrameError ? e.code : 'THROW ' + (e as Error).message; } };
const suppliedOrigin = { kind: 'supplied_pcm', sourceId: 'bench_file', conditionsId: 'cond_a', target: { kind: 'channel', channel: 8 }, path: 'electrical', tap: 'post_eq' } as const;

describe('measurementToFrame: origem e proveniência', () => {
  it('sintético vira mock/simulated, nunca measured', () => {
    const f = measurementToFrame(measure(pcm(tones([[1500, 0.5]]), { origin: pilotOrigins.surdo })), life());
    expect(f.origin).toEqual({ kind: 'mock', measurement: 'simulated', fixtureId: 'pilot_surdo', seed: null });
    expect(f.domain).toBe('synthetic');
    expect(f.signal).toEqual({ kind: 'input', channel: 8 });
    expect(JSON.stringify(f)).not.toContain('"measured"');
  });
  it('PCM fornecido vira declared_unverified, sem registro de validação e sem confiança validada', () => {
    const f = measurementToFrame(measure(pcm(tones([[1500, 0.5]]), { origin: suppliedOrigin })), life());
    expect(f.origin).toEqual({ kind: 'supplied_pcm', measurement: 'declared_unverified', sourceId: 'bench_file', conditionsId: 'cond_a' });
    expect(f.domain).toBe('electrical_line');
    expect(f.tap).toBe('post_eq');
    expect(f.processingContext).toEqual({ status: 'unknown', recordId: null });
    expect(f.quality.confidence).toBe('limited');
    expect(f.quality.reasons).toContain('declared_not_verified');
  });
  it('o esquema recusa qualquer tentativa de promover a medido ou validado', () => {
    const base = measurementToFrame(measure(pcm(undefined, { origin: suppliedOrigin })), life());
    const tamper = (mut: (f: any) => void) => { const f = structuredClone(base) as any; mut(f); return spectrumFrameSchema.safeParse(f).success; };
    expect(tamper(f => { f.origin = { kind: 'audio_capture', measurement: 'measured', deviceAlias: 'x', inputIndex: 1, validationRecordId: 'v' }; })).toBe(false);
    expect(tamper(f => { f.origin.measurement = 'measured'; })).toBe(false);
    expect(tamper(f => { f.quality.confidence = 'validated_for_point'; })).toBe(false);
    expect(tamper(f => { f.processingContext = { status: 'verified', recordId: 'r' }; })).toBe(false);
    expect(tamper(f => { f.capturedAt = { startUtc: '2026-11-09T12:00:00Z' }; })).toBe(false);
    expect(tamper(f => { f.acquisitionAgeUpperBoundMs = 0; })).toBe(false);
    expect(tamper(f => { f.droppedFrames = 0; })).toBe(false);
    expect(tamper(f => { f.extra = 1; })).toBe(false);
  });
  it('um timestamp declarado na entrada nunca vira capturedAt', () => {
    const f = measurementToFrame(measure(pcm(undefined, { inputTimestampMs: 123456 })), life());
    expect(f.capturedAt).toBeNull();
    expect(f.acquisitionAgeUpperBoundMs).toBeNull();
    expect(JSON.stringify(f)).not.toContain('123456');
  });
  it('campos de tempo e geração vêm só do ciclo de vida fornecido', () => {
    const f = measurementToFrame(measure(pcm()), life({ generationId: 'g9', sequence: 7, contextRevision: 'rev9', clockDomainId: 'clk' }));
    expect([f.generationId, f.sequence, f.contextRevision, f.clockDomainId, f.receivedAtMonoMs]).toEqual(['g9', 7, 'rev9', 'clk', 1000]);
  });
});

describe('measurementToFrame: rota', () => {
  it('AUX1 é sempre barramento compartilhado, sem identidade de canal', () => {
    expect(measurementToFrame(measure(pcm(undefined, { origin: pilotOrigins.aux1 })), life()).signal).toEqual({ kind: 'bus', bus: 'aux1', shared: true });
  });
  it('sem alvo declarado, o sinal é desconhecido', () => {
    expect(measurementToFrame(measure(pcm()), life()).signal).toEqual({ kind: 'unknown' });
  });
  it('canal acima das entradas da Ui16 é recusado (o motor aceita até 64)', () => {
    const m = measure(pcm(undefined, { origin: { ...pilotOrigins.voz, target: { kind: 'channel', channel: 20 } } }));
    expect(code(() => measurementToFrame(m, life()))).toBe('ROUTE_NOT_SUPPORTED');
    expect(code(() => measurementToFrame(measure(pcm(undefined, { origin: { ...pilotOrigins.voz, target: { kind: 'channel', channel: 12 } } })), life()))).toBe('OK');
    expect(code(() => measurementToFrame(measure(pcm(undefined, { origin: { ...pilotOrigins.voz, target: { kind: 'channel', channel: 9 } } })), life(), { inputs: 8 }))).toBe('ROUTE_NOT_SUPPORTED');
  });
});

describe('measurementToFrame: escala, silêncio e cobertura', () => {
  it('a escala referenciada declara a definição de potência por bin; seno de escala plena dá −3,01 dBFS', () => {
    const s = Float64Array.from({ length: 8192 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / 48000));
    const m = measure(pcm(s)); const f = measurementToFrame(m, life());
    expect(f.spectrum).toMatchObject({ unit: 'dbfs_power_per_bin', calibration: 'digital_reference', scaleDefinitionId: SCALE_DEFINITION_ID, nullMeans: 'exact_zero_power' });
    expect(m.totalSpectralPower.dbFS).toBeCloseTo(-3.01, 1);
  });
  it('float sem referência fica relative_unknown e uncalibrated, sem dBFS', () => {
    const m = measure({ ...pcm(), format: 'f64', fullScale: null } as PcmInput);
    const f = measurementToFrame(m, life());
    expect(f.spectrum.unit).toBe('relative_unknown'); expect(f.spectrum.calibration).toBe('uncalibrated');
    expect(f.spectrum.grid.levels.every(v => v === null || Number.isFinite(v))).toBe(true);
  });
  it('banda sem centro de bin é "unresolved" e não carrega nível nem fração (não é silêncio)', () => {
    const m = measure(pcm(tones([[100, 0.5]], 48000, 4096), { settings: { fftSize: 256, hopSize: 256 } }));
    const f = measurementToFrame(m, life());
    const b1 = f.spectrum.bands[0]!;
    expect(b1).toMatchObject({ id: 'band_1', binCount: 0, coverage: 'unresolved', level: null, fractionOfTotalPower: null });
    expect(f.quality.reasons).toContain('unresolved_band');
    const forged = structuredClone(f) as any; forged.spectrum.bands[0].level = -80;
    expect(spectrumFrameSchema.safeParse(forged).success).toBe(false);
  });
  it('silêncio exato é potência zero (null), com confiança insuficiente — nunca "sem dados"', () => {
    const f = measurementToFrame(measure(pcm(new Float64Array(4096))), life());
    expect(f.spectrum.grid.levels.every(v => v === null)).toBe(true);
    expect(f.quality.confidence).toBe('insufficient'); expect(f.quality.reasons).toContain('no_energy');
    expect(JSON.stringify(f)).not.toMatch(/Infinity|NaN/);
  });
  it('clipping possível reduz a confiança e é só do PCM capturado', () => {
    const f = measurementToFrame(measure(pcm(Float64Array.from({ length: 4096 }, (_, i) => i % 2 ? 1 : -1))), life());
    expect(f.quality.digitalClippingEstimate).toMatchObject({ thresholdDbfs: 0, point: 'captured_pcm' });
    expect(f.quality.digitalClippingEstimate!.fraction).toBeGreaterThan(0);
    expect(f.quality.confidence).toBe('insufficient');
  });
  it('clipping indisponível (float sem referência) não vira fração', () => {
    const f = measurementToFrame(measure({ ...pcm(), fullScale: null } as PcmInput), life());
    expect(f.quality.digitalClippingEstimate).toBeNull();
  });
});

describe('measurementToFrame: limites e entradas inválidas', () => {
  it('fftSize 4096 cabe no quadro (≤ 4096 bins, ≤ 256 KiB); 8192 excede o contrato e é recusado', () => {
    const f = measurementToFrame(measure(pcm(noise(8192), { settings: { fftSize: 4096 } })), life());
    expect(f.spectrum.grid.levels.length).toBe(2049);
    expect(JSON.stringify(f).length).toBeLessThanOrEqual(FRAME_LIMITS.maxBytes);
    expect(code(() => measurementToFrame(measure(pcm(noise(16384), { settings: { fftSize: 8192 } })), life()))).not.toBe('OK');
  });
  it('o formato compacto reduz o quadro muito abaixo do JSON por bin do motor', () => {
    const m = measure(pcm(noise(8192), { settings: { fftSize: 4096 } }));
    expect(JSON.stringify(measurementToFrame(m, life())).length).toBeLessThan(JSON.stringify(m).length / 3);
  });
  it('medição adulterada ou desconhecida é recusada', () => {
    const m = structuredClone(measure(pcm())) as any;
    expect(code(() => measurementToFrame({ ...m, provenanceVerification: 'verified' }, life()))).toBe('INVALID_MEASUREMENT');
    expect(code(() => measurementToFrame(null, life()))).toBe('INVALID_MEASUREMENT');
    expect(code(() => measurementToFrame({ ...m, mode: 'REAL' }, life()))).toBe('INVALID_MEASUREMENT');
  });
  it('ciclo de vida inválido é recusado (sem relógio implícito)', () => {
    const m = measure(pcm());
    for (const bad of [{ ...life(), receivedAtUtc: 'ontem' }, { ...life(), sequence: -1 }, { ...life(), extra: 1 }, { ...life(), frameId: 'Fred voz privada' }, { ...life(), receivedAtMonoMs: Number.NaN }, null])
      expect(code(() => measurementToFrame(m, bad))).toBe('INVALID_LIFECYCLE');
  });
  it('é determinística e não altera a medição de entrada', () => {
    const m = measure(pcm(noise(8192), { origin: pilotOrigins.cavaco }));
    const before = JSON.stringify(m);
    expect(JSON.stringify(measurementToFrame(m, life()))).toBe(JSON.stringify(measurementToFrame(m, life())));
    expect(JSON.stringify(m)).toBe(before);
  });
  it('não vaza amostras: o quadro só contém níveis, nunca PCM', () => {
    const f = measurementToFrame(measure(pcm(tones([[1500, 0.5]]))), life());
    expect(JSON.stringify(f)).not.toMatch(/"samples"|"pcm"/); expect(f.spectrum.grid.levels.length).toBe(2049);
  });
});

describe('fronteira do módulo', () => {
  it('frame.ts importa só zod e contratos locais; sem mesa, AutoConfig, servidor, rede, relógio ou aleatoriedade', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'audio-intelligence', 'frame.ts'), 'utf8');
    expect([...src.matchAll(/from '([^']+)'/g)].map(m => m[1])).toEqual(['zod', './contracts.js']);
    expect(src).not.toMatch(/Date\.now|new Date|Math\.random|performance\.now|fetch\(|process\.|require\(/);
  });
  it('nenhum arquivo fora do módulo e dos testes importa audio-intelligence (analisador não está ligado à interface)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'audio-intelligence'].includes(e.name)) walk(p); }
      else if (/\.(ts|html)$/.test(e.name) && /audio-intelligence/.test(readFileSync(p, 'utf8')) && !/audio-intelligence/.test(e.name)) offenders.push(p.slice(PROJECT_ROOT.length + 1).replace(/\\/g, '/'));
    } };
    walk(join(PROJECT_ROOT, 'src')); walk(join(PROJECT_ROOT, 'web', 'src'));
    expect(offenders).toEqual([]);
  });
});
