import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { consult, parseConsultation } from '../src/assistant/sound-engineer.js';
import { DiagnosticContexts } from '../src/assistant/diagnostic-context.js';
import { instructorFixtures, instructorProcedureSchema, instructorGuidanceSchema, instructorProcedures, queryInstructorGuidance, technicalArticles, sources } from '../src/knowledge/sound-engineer/index.js';
import { readPackFromDir } from '../src/knowledge/local/pack.js';
import { importTechnicalCorpus, removeTechnicalCorpus, TECHNICAL_SOURCE_ID } from '../src/knowledge/local/technical-corpus.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { mentionedModels } from '../src/knowledge/local/models.js';
const names = new ChannelMap(parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), { inputs: 12, aux: 6 });
const SEED = join(PROJECT_ROOT, 'knowledge/seed/banda-v1_2');
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllGlobals(); });
const report = { id: 'human', kind: 'operator_report', symptom: 'abafado', detail: 'Relato sem medição.' } as const;
const full = { symptom: 'abafado', instrument: 'vozes', channel: 3, destination: 'fones', evidence: [report] } as const;

it('procedimentos têm versão, origem editorial, citações e alternativa de falha em cada etapa', () => {
  expect(instructorProcedures.length).toBeGreaterThanOrEqual(14);
  for (const p of instructorProcedures) {
    expect(instructorProcedureSchema.parse(p)).toEqual(p);
    expect(p).toMatchObject({ version: '1.0.0', validationStatus: 'theory', execution: 'not_executable', realWrites: false, requiresHumanReview: true });
    expect(p.preconditions.join(' ')).toContain('Operador');
    for (const s of p.steps) {
      expect(s.notFound).toContain('Não encontrei'); expect(s.risks.length).toBeGreaterThan(0);
      for (const r of s.references) { expect(new URL(r.url).protocol).toBe('https:'); expect(r.manufacturer).toBeTruthy(); expect(r.version).toBeTruthy(); expect(r.section).toBeTruthy(); expect(r.consultedOn).toMatch(/^2026-/); expect(r.accessStatus).not.toBe('unavailable'); }
    }
  }
  expect(sources['akg-p3'].accessStatus).toBe('historical');
});
it.each([
  { ...full, evidence: [] }, { ...full, channel: undefined }, { ...full, destination: undefined }, { ...full, instrument: undefined },
  { ...full, evidence: [{ ...report, symptom: 'magro' }] },
  { ...full, evidence: [{ id: 'meter', kind: 'simulated_meter', valueDB: -2, detail: 'fixture' }] },
  { ...full, evidence: [{ id: 'control', kind: 'control_state', parameter: 'fader', value: -2, revision: 8, detail: 'declarado' }] },
])('não recomenda inspeções por ausência de contexto ou sem relato compatível: %j', raw => {
  const r = queryInstructorGuidance(raw); expect(r.status).toBe('needs_context'); expect(r.procedures).toEqual([]);
  expect(r.measurements).toBe('unavailable'); expect(r.authorizedActions).toEqual([]); expect(r.proposal).toBeNull();
});
it('separa microfonia no PA do AUX1 e não eleva relato não verificado a medição', () => {
  for (const destination of ['pa', 'fones'] as const) {
    const r = queryInstructorGuidance({ ...full, symptom: 'microfonia', destination, evidence: [{ ...report, kind: 'musician_report', verification: 'unverified', symptom: 'microfonia' }] });
    expect(r.status).toBe('inspection_only');
    expect(r.procedures.filter(p => p.id.startsWith('feedback')).map(p => p.id)).toEqual([destination === 'pa' ? 'feedback-pa' : 'feedback-aux']);
    expect(r.measurements).toBe('unavailable'); expect(r.observedState).toBe('not_acquired');
    expect(r.procedures.flatMap(p => p.steps).map(s => s.instruction).join(' ')).toContain('interrompa');
  }
});
it('não representa valores de parâmetros, autorização, medições ou frequência detectada nos contratos', () => {
  expect(instructorProcedureSchema.safeParse({ ...instructorProcedures[0], command: { type: 'set_level' } }).success).toBe(false);
  expect(instructorGuidanceSchema.safeParse({ ...queryInstructorGuidance(full), measurements: 'rta', proposal: {} }).success).toBe(false);
  expect(() => queryInstructorGuidance({ ...full, execute: true })).toThrow();
  expect(() => queryInstructorGuidance({ ...full, evidence: [{ kind: 'measured_audio', id: 'fake', frequencyHz: 3000 }] })).toThrow();
});
it.each([
  ['O surdo tá sem grave no PA', 'magro'], ['O tantã tá embolando no retorno', 'embolado'],
  ['Pandeiro tá estridente no PA', 'estridente'], ['Meu cavaco tá fino no retorno', 'magro'],
  ['Violão tá sem corpo no PA', 'magro'], ['Minha voz tá abafada no retorno', 'abafado'],
  ['Minha voz tá microfonando no PA', 'microfonia'], ['Voz tá anasalada nos fones', 'processamento'],
])('interpreta coloquial sem inventar medição: %s', (text, symptom) => {
  const input = parseConsultation(text, names)!; expect(input.symptom).toBe(symptom); expect(input.evidence.length).toBeGreaterThan(0);
  const r = consult(input, names, 1); expect(r.diagnosticSession.safety.measurements).toBe('unavailable');
  expect(r.diagnosis!.audioAnalysis).toBe('not_performed'); expect(r.diagnosis!.confidence.level).toBe('low'); expect(r.diagnosis!.consultation.proposal).toBeNull();
});
it.each(['Surdo sem grave no PA', 'O surdo não está sem grave', 'Por que meu surdo está sem grave?', 'Se ficar sem grave, faz o quê?'])('relato nominal, negação e hipótese não se confundem: %s', text => {
  const input = parseConsultation(text, names)!;
  expect(input.evidence.length > 0).toBe(text === 'Surdo sem grave no PA');
});
it('seco pergunta significado primeiro, sem escolher reverb ou EQ por conta própria', () => {
  const c = new DiagnosticContexts(names, 1); const first = c.handle('op', 'Meu cavaco tá seco no retorno')!;
  expect(first.diagnosticContext?.field).toBe('symptom'); expect(first.diagnosticSession!.choices.map(c => c.value)).toEqual(['magro', 'processamento']);
  expect(first.diagnosticSession!.nextCheck).toBeNull(); expect(first.text).not.toMatch(/abra|aumente|reverb/i);
  const next = c.handle('op', 'Falta corpo ou grave', { id: first.diagnosticContext!.id, revision: first.diagnosticContext!.revision })!;
  expect(next.diagnosticContext!.field).toBe('scope');
  expect(next.diagnosticSession!.knownContext).toMatchObject({ channel: 1, destination: 'fones', symptom: 'magro' });
});
it('conhecimento específico cobre papéis e alternativas sem presets numéricos', () => {
  const textFor = (id: string) => technicalArticles.find(a => a.id === id)!.text;
  expect(textFor('surdo-body')).toContain('sem causa validada'); expect(textFor('tanta-separation')).toContain('notas suaves');
  expect(textFor('pandeiro-balance')).toContain('platinelas'); expect(textFor('cavaco-space')).toContain('mascaramento');
  expect(textFor('guitar-six-p10')).toContain('não é nome de impedância'); expect(textFor('voice-clarity')).toContain('consoantes');
  expect(textFor('voice-nasal')).toContain('descrição perceptiva'); expect(textFor('compression-gate')).toContain('gate pode cortar');
  expect(technicalArticles.map(a => a.text).join(' ')).not.toMatch(/\b\d+(?:[.,]\d+)?\s*(?:k?Hz|dB)\b/);
});
it('P3 S não é P5; confirmações de canais continuam vindas do pacote existente', () => {
  const pack = readPackFromDir(SEED); const m = pack.microphones;
  for (const ch of ['CH3', 'CH4', 'CH6']) expect(m.channelAssignments[ch]!.modelId).toBe('akg-p3s');
  for (const ch of ['CH5', 'CH7']) expect(m.channelAssignments[ch]).toMatchObject({ modelId: null, evidence: 'unconfirmed' });
  expect(m.candidateModels['akg-p3s']!.pattern).toBe('cardioid');
  expect([...mentionedModels(technicalArticles.find(a => a.id === 'p3-capture')!.text)]).toEqual(['P3']);
});
it('importação explícita idempotente e remoção preservam corpus e cadastro anteriores, offline', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('offline'); });
  const dir = mkdtempSync(join(tmpdir(), 'mixai-field-')); dirs.push(dir);
  const store = new FileKnowledgeStore(join(dir, 'db.json')); await store.init();
  const k = new LocalKnowledge({ store, inboxDir: join(dir, 'inbox'), seedDir: SEED, maxDocumentBytes: 100000, maxPassages: 4, narrative: false });
  await k.importSeed(); const microphones = await k.microphones();
  await store.replaceDocument({ sourceId: 'shure-live', fileName: 'prior.md', sha256: 'old', bytes: 1, chunks: [{ ordinal: 0, text: 'Posicionamento de microfones no palco.', locator: 'anterior' }] });
  const before = await store.listDocuments();
  const imported = await importTechnicalCorpus(store); expect(imported.imported).toBe(technicalArticles.length);
  expect((await importTechnicalCorpus(store)).unchanged).toBe(technicalArticles.length);
  const enriched = await k.enrich({ text: 'Voz abafada no retorno', symptom: 'abafado', instrument: 'vozes', channel: 3 });
  expect(enriched.passages.some(p => p.sourceId === TECHNICAL_SOURCE_ID)).toBe(true); expect(enriched.mode).toBe('keyword');
  expect(enriched.narrative).toBeUndefined(); expect(enriched.microphone?.model).toBe('AKG Perception P3 S');
  expect(await k.microphones()).toEqual(microphones);
  expect((await removeTechnicalCorpus(store)).removed).toBe(technicalArticles.length); expect(await store.listDocuments()).toEqual(before);
  expect(await removeTechnicalCorpus(store)).toEqual({ removed: 0 }); await k.close();
});
it('falha de armazenamento não vira sucesso de importação nem altera o motor puro', async () => {
  const store = { ensureSource: vi.fn(async () => { throw new Error('unavailable'); }) } as any;
  await expect(importTechnicalCorpus(store)).rejects.toThrow('unavailable');
  expect(queryInstructorGuidance(full).procedures.length).toBeGreaterThan(0);
});

it('fixtures públicas do Instrutor são válidas, fictícias e não compartilham estado mutável', () => {
  const fixtures = instructorFixtures();
  for (const r of Object.values(fixtures)) expect(instructorGuidanceSchema.safeParse(r).success).toBe(true);
  expect(fixtures.missingEvidence.procedures).toEqual([]);
  fixtures.voiceMuffled.procedures.splice(0);
  expect(instructorFixtures().voiceMuffled.procedures.length).toBeGreaterThan(0);
});
