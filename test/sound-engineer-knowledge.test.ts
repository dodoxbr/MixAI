import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DEVICE_CAPABILITIES } from 'soundcraft-ui-connection';
import { describe, expect, it } from 'vitest';
import {
  capabilities, diagnose, diagnosticInputSchema, examples, fundamentals,
  instruments, procedures, sources, symptomSchema, type Reference,
} from '../src/knowledge/sound-engineer/index.js';

const symptoms = symptomSchema.options;

describe('Sound Engineer — consulta teórica isolada', () => {
  it.each(Object.entries(examples))('%s é determinístico e preserva a entrada', (_name, input) => {
    const before = structuredClone(input);
    const result = diagnose(input);
    expect(diagnose(input)).toEqual(result);
    expect(input).toEqual(before);
    expect(result.audioAnalysis).toBe('not_performed');
    expect(result.evidence).not.toBe(input.evidence);
  });

  it('não deduz sintoma/espectro de faders e medidores simulados', () => {
    const result = diagnose(examples.apenasControles);
    expect(result.confidence.level).toBe('insufficient');
    expect(result.status).toBe('needs_context');
    expect(result.recommendations).toEqual([]);
    expect(result.hypotheses.every(h => h.supportingEvidenceIds.length === 0)).toBe(true);
  });

  it('um relato de outro sintoma não sustenta o diagnóstico solicitado', () => {
    const result = diagnose({ ...examples.apenasControles, evidence: examples.cavacoEstridente.evidence });
    expect(result.confidence.level).toBe('insufficient');
    expect(result.recommendations).toEqual([]);
  });

  it.each(['instrument', 'destination'] as const)('pede %s ausente sem recomendar ensaio de ajuste', field => {
    const input = { ...examples.cavacoEstridente, [field]: undefined };
    const result = diagnose(input);
    expect(result.status).toBe('needs_context');
    expect(result.recommendations.every(r => r.kind === 'inspection')).toBe(true);
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it.each(symptoms)('%s permanece hipótese com baixa confiança e critérios de parada', symptom => {
    const input = { symptom, instrument: 'vozes', destination: 'pa', evidence: [{ id: 'human', kind: 'operator_report', symptom, detail: 'Relato fictício do operador.' }] };
    const result = diagnose(input);
    expect(result.status).toBe('theoretical_guidance');
    expect(result.confidence.level).toBe('low');
    expect(result.hypotheses.length).toBeGreaterThan(1);
    for (const h of result.hypotheses) {
      expect(h.supportingEvidenceIds).toEqual(['human']);
      expect(h.missingEvidence.length).toBeGreaterThan(0);
    }
    const trial = result.recommendations.find(r => r.kind === 'theoretical_trial');
    expect(trial?.expectedObservation).toBeTruthy();
    expect(trial?.stopOrRevert).toBeTruthy();
    for (const r of result.recommendations) {
      expect(r.execution).toBe('not_executable');
      expect(r.requiresHumanReview).toBe(true);
      expect(r.preconditions.length).toBeGreaterThan(0);
      expect(r.hypothesisIds.every(id => result.hypotheses.some(h => h.id === id))).toBe(true);
    }
  });

  it.each([
    { ...examples.cavacoEstridente, audioAnalysis: 'performed' },
    { ...examples.cavacoEstridente, evidence: [{ id: 'fake', kind: 'real_audio', detail: 'suposta captura' }] },
    { ...examples.cavacoEstridente, evidence: [{ id: 'fake', kind: 'real_meter', valueDB: -12, detail: 'não validado' }] },
    { ...examples.cavacoEstridente, evidence: [...examples.cavacoEstridente.evidence, ...examples.cavacoEstridente.evidence] },
    { ...examples.cavacoEstridente, evidence: [{ ...examples.cavacoEstridente.evidence[0], confidence: 'high' }] },
    { ...examples.cavacoEstridente, instrument: 'inventado' },
    { ...examples.cavacoEstridente, destination: 'aux999' },
    { ...examples.apenasControles, evidence: [{ ...examples.apenasControles.evidence[0], value: NaN }] },
  ])('recusa entrada inválida ou capacidade não entregue %#', input => {
    expect(diagnosticInputSchema.safeParse(input).success).toBe(false);
    expect(() => diagnose(input)).toThrow();
  });
});

describe('proveniência e limites de capacidade', () => {
  it('todas as orientações e hipóteses têm referências resolvíveis', () => {
    const check = (refs: readonly Reference[]) => {
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(sources[ref.source]).toBeDefined();
        expect(ref.locator.length).toBeGreaterThan(0);
        expect(new URL(sources[ref.source].url).protocol).toBe('https:');
      }
    };
    for (const item of [...Object.values(procedures), ...Object.values(instruments), ...capabilities, ...fundamentals]) check(item.references);
    for (const input of Object.values(examples)) {
      const result = diagnose(input);
      [...result.hypotheses, ...result.recommendations].forEach(item => check(item.references));
    }
  });

  it('registra os seis instrumentos como adaptações ainda não validadas', () => {
    expect(Object.keys(instruments).sort()).toEqual(['cavaco', 'pandeiro', 'surdo', 'tanta', 'violao', 'vozes']);
    for (const guide of Object.values(instruments)) {
      expect(guide.validation).toBe('not_validated_in_rehearsal');
      expect(guide.captureChecks.length).toBeGreaterThan(0);
      expect(guide.conditionalAdvice.length).toBeGreaterThan(0);
      expect(guide.avoid).toBeTruthy();
    }
  });

  it('distingue Ui16, biblioteca, MixAI e validação física', () => {
    expect(DEVICE_CAPABILITIES.ui16).toMatchObject({ input: 12, aux: 6, multitrack: false });
    const capability = (feature: string) => capabilities.find(c => c.feature === feature);
    expect(capability('hpf_slope')).toMatchObject({ ui16: 'unsupported', library: 'ui24r_only', mixai: 'lab_only' });
    expect(capability('lpf')?.library).toBe('ui24r_only');
    expect(capability('rta')).toMatchObject({ ui16: 'documented', library: 'not_exposed' });
    expect(capability('preamp_phantom')).toMatchObject({ library: 'available', mixai: 'blocked' });
    expect(capability('meters')?.mixai).toBe('not_integrated');
    expect(capabilities.every(c => !c.hardwareVerified)).toBe(true);
  });

  it('base continua isolada e apenas consumidores explícitos importam conhecimento em produção', () => {
    const LOCAL_KNOWLEDGE_CONSUMERS = ['src/assistant/service.ts', 'src/server/http.ts', 'src/server/start.ts', 'src/server/knowledge-routes.ts', 'src/knowledge-cli.ts', 'src/autoconfig/planner/kb-adapter.ts', 'src/autoconfig/planner/provider-adapter.ts'];
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(item =>
      item.isDirectory() ? files(join(dir, item.name)) : [join(dir, item.name)]);
    for (const file of files('src').filter(f => f.endsWith('.ts'))) {
      const source = readFileSync(file, 'utf8');
      const normalizedFile = file.split(sep).join('/');
      if (normalizedFile.startsWith('src/knowledge/sound-engineer/')) {
        // Importações locais ou zod são a única dependência permitida da base.
        const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map(m => m[2]);
        expect(imports.every(path => path === 'zod' || /^\.\/[\w-]+\.js$/.test(path)), file).toBe(true);
      } else if (normalizedFile !== 'src/assistant/sound-engineer.ts') {
        const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map(m => m[2]!);
        for (const path of imports.filter(p => /knowledge/.test(p))) {
          // A base local (RAG, opcional) é outro módulo e só entra por estes consumidores explícitos.
          // A base determinística só entra pela consulta B3A ou pelo adaptador AutoConfig isolado.
          if (/knowledge\/local\/|knowledge-routes/.test(path)) expect(LOCAL_KNOWLEDGE_CONSUMERS, file).toContain(normalizedFile);
          else if (['src/autoconfig/planner/kb-adapter.ts', 'src/autoconfig/recommendation/kb-adapter.ts'].includes(normalizedFile)) expect(path, file).toMatch(/knowledge\/sound-engineer\/index\.js$/);
          else expect(path, file).not.toMatch(/knowledge/);
        }
      }
    }
  });
});
