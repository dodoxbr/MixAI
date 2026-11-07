import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { consultationSchema, consult, parseConsultation } from '../src/assistant/sound-engineer.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import {
  diagnose, diagnosticConsultationSchema, diagnosticInputSchema, diagnosticRecommendationSchema,
  instrumentProfiles, instruments, sources, technicalModules, technicalModuleSchema, voiceRole,
} from '../src/knowledge/sound-engineer/index.js';
const names = new ChannelMap(parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), { inputs: 12, aux: 6 });
afterEach(() => vi.unstubAllGlobals());
const result = (text: string) => {
  const input = parseConsultation(text, names); expect(input).toBeDefined();
  return consult(input!, names, 1);
};
it.each([
  ['Meu cavaco está estridente no PA', 'estridente', 1, 'pa'],
  ['Fred: minha voz está baixa no público', 'desequilibrio', 3, 'pa'],
  ['A voz Fred está sumindo quando o coro entra no PA', 'desequilibrio', 3, 'pa'],
  ['O microfone Fred está dando microfonia no PA', 'microfonia', 3, 'pa'],
  ['O microfone Fred está microfonando no AUX1', 'microfonia', 3, 'fones'],
  ['O pandeiro está estridente nos fones', 'estridente', 9, 'fones'],
  ['O surdo está magro no PA', 'magro', 8, 'pa'],
  ['O violão de 7 cordas está abafado no PA', 'abafado', 2, 'pa'],
  ['A voz Fred está sibilante no PA', 'sibilancia', 3, 'pa'],
  ['O cavaco está clipando no PA', 'clip', 1, 'pa'],
  ['O violão está com chiado nos fones', 'ruido', 2, 'fones'],
  ['Fred: não me ouço nos fones', 'monitoracao', 3, 'fones'],
] as const)('%s é consulta local sem autorização', (text, symptom, channel, destination) => {
  const reply = result(text), d = reply.diagnosis!;
  expect(d).toMatchObject({ symptom, audioAnalysis: 'not_performed', confidence: { level: 'low' } });
  expect(d.consultation.diagnostic).toMatchObject({ channel, destination });
  expect(diagnosticConsultationSchema.safeParse(d.consultation).success).toBe(true);
  expect(d.consultation.proposal).toBeNull(); expect(d.consultation.authorizedActions).toEqual([]);
  expect(d.consultation.evidence.unavailableMeasurements).toContain('rta');
  expect(reply.text).toContain('Ação autorizada: nenhuma');
  expect(JSON.stringify(d.recommendations)).not.toMatch(/\d+(?:[.,]\d+)?\s*(?:k?hz|dB)\b/i);
});
it('Fred lead e coro dependem do canal e nome cadastrado; não criam offset', () => {
  expect(result('Fred está sumindo no PA').diagnosis!.consultation.diagnostic.voiceRole).toBe('lead');
  expect(result('A voz Leandro está baixa nos fones').diagnosis!.consultation.diagnostic.voiceRole).toBe('backing');
  expect(voiceRole(3, 'Voz Fernando')).toBe('unknown');
  expect(voiceRole(6, 'Voz Fred')).toBe('unknown');
  expect(voiceRole(3)).toBe('unknown');
  expect(result('Fred está sumindo no PA').text).toContain('sem pedir esforço vocal');
  expect(result('Fred está sumindo no PA').diagnosis!.bandGuidance.join(' ')).toContain('CH4–7');
});
it.each([
  ['O surdo está embolando com o tantã no PA', 'surdo-tanta'],
  ['O violão está sumindo com o cavaco no PA', 'cavaco-violao'],
])('queixa combinada conserva as fontes e pede canal primário: %s', (text, id) => {
  const reply = result(text);
  expect(reply.clarification?.field).toBe('channel');
  expect(reply.diagnosis!.consultation.diagnostic.interactionIds).toContain(id);
  expect(reply.diagnosis!.recommendations.every(r => r.kind === 'inspection')).toBe(true);
});
it('distingue seis/sete cordas e não presume captação pela lista de aliases', () => {
  const reply = result('O violão está magro no PA');
  expect(reply.diagnosis!.consultation.diagnostic.profileIds).toEqual(['violao-six', 'violao-seven']);
  expect(reply.text).toContain('Confirmar seis ou sete cordas');
  expect(reply.text).toContain('DI');
  expect(instrumentProfiles.find(p => p.id === 'violao-seven')!.avoid).toContain('baixarias');
});
it.each([
  'Qual é a frequência da microfonia da voz Fred no PA?',
  'Fred não está microfonando no PA',
  'Se Fred está microfonando no PA',
  'Talvez o Fred esteja microfonando no PA',
  'Não é verdade que não me ouço nos fones',
  'Fred não está sem retorno nos fones',
  'Fred não está microfonando e não me ouço nos fones',
])('sem relatório afirmativo compatível não fabrica medição: %s', text => {
  const reply = result(text);
  if (reply.diagnosis) {
    expect(reply.diagnosis.confidence.level).toBe('insufficient');
    expect(reply.diagnosis.recommendations).toEqual([]);
    expect(reply.diagnosis.consultation.proposal).toBeNull();
  }
  expect(reply.text).not.toMatch(/detect(?:ei|ada|amos).*\d+(?:[.,]\d+)?\s*k?hz/i);
});
it('microfonia tem prioridade sobre estridência; AUX1 é compartilhado e AFS2 só orientação', () => {
  const reply = result('Fred está estridente e microfonando nos fones');
  expect(reply.diagnosis!.symptom).toBe('microfonia');
  expect(reply.text).toContain('compartilhado');
  expect(reply.text).toContain('Fixed'); expect(reply.text).toContain('Live');
  expect(reply.text).toContain('ring-out com público');
  expect(reply.diagnosis!.consultation.rollback.automatic).toBe(false);
  expect(reply.diagnosis!.recommendations[0]!.instruction).toContain('interromper');
});
it('estado declarado com revisão/momento continua separado de relato e espectro', () => {
  const d = diagnose({ symptom: 'microfonia', instrument: 'vozes', destination: 'pa', evidence: [
    { id: 'old', kind: 'control_state', parameter: 'ch.3.master.level', value: -8, revision: 5, observedAt: '2020-01-01T00:00:00Z', detail: 'Leitura antiga declarada pelo chamador.' },
    { id: 'sim', kind: 'simulated_meter', valueDB: -4, detail: 'Fictício LAB.' },
  ] });
  expect(d.confidence.level).toBe('insufficient'); expect(d.recommendations).toEqual([]);
  expect(d.consultation.evidence.controlReadings[0]!.verification).toBe('caller_declared_not_verified');
  expect(d.consultation.evidence.musicianReports).toEqual([]);
  expect(d.consultation.evidence.simulated).toHaveLength(1);
});
it('contratos recusam propostas executáveis, aprovações forjadas e medição inexistente', () => {
  const d = result('O cavaco está estridente no PA').diagnosis!.consultation;
  const r = d.recommendations[0]!;
  for (const bad of [{ ...d, proposal: { type: 'set_gain' } }, { ...d, authorizedActions: ['set_eq'] }, { ...d, requiresApproval: false }]) {
    expect(diagnosticConsultationSchema.safeParse(bad).success).toBe(false);
  }
  for (const bad of [{ ...r, execution: 'apply' }, { ...r, command: { type: 'set_phantom' } }, { ...r, validationStatus: 'verified_at_rehearsal' }]) {
    expect(diagnosticRecommendationSchema.safeParse(bad).success).toBe(false);
  }
  expect(consultationSchema.safeParse({ evidence: [], sourceLabel: 'Voz Fred' }).success).toBe(false);
  expect(diagnosticInputSchema.safeParse({ symptom: 'microfonia', evidence: [{ kind: 'real_rta', id: 'fake', detail: '2500 Hz' }] }).success).toBe(false);
});
it('funciona sem fetch/IA, é determinístico e não compartilha saída mutável entre chamadas', () => {
  vi.stubGlobal('fetch', () => { throw new Error('Sem internet'); });
  const one = result('Fred está microfonando no PA'), expected = structuredClone(one);
  one.diagnosis!.consultation.recommendations[0]!.instruction = 'mutado pelo consumidor';
  expect(result('Fred está microfonando no PA')).toEqual(expected);
});
it('módulos, perfis e recomendações têm versões e fontes resolvíveis sem afirmar ensaio', () => {
  for (const module of Object.values(technicalModules)) {
    expect(technicalModuleSchema.safeParse(module).success).toBe(true);
    for (const ref of module.references) expect(sources[ref.source]).toBeDefined();
  }
  expect(instrumentProfiles).toHaveLength(8);
  for (const p of [...instrumentProfiles, ...Object.values(instruments)]) expect(p.validationStatus).toBe('theory');
  for (const r of result('Fred está microfonando no PA').diagnosis!.consultation.recommendations) {
    expect(r.references.every(ref => ref.accessStatus !== 'unavailable' && !!ref.section && !!ref.version && !!ref.consultedOn)).toBe(true);
  }
  expect(sources['ui16-manual-pt'].accessStatus).toBe('unavailable');
});

it('uma frequência escrita no relato não vira análise espectral nem certeza técnica', () => {
  const d = diagnose({ symptom: 'microfonia', instrument: 'vozes', destination: 'pa', evidence: [
    { id: 'claim', kind: 'operator_report', symptom: 'microfonia', detail: 'Acho que o apito está em 2500 Hz, sem RTA validado.' },
  ] });
  expect(d.confidence.level).toBe('low');
  expect(d.audioAnalysis).toBe('not_performed');
  expect(d.consultation.evidence.unavailableMeasurements).toContain('rta');
  expect(d.consultation.evidence.controlReadings).toEqual([]);
  expect(d.recommendations.some(r => r.instruction.includes('2500'))).toBe(false);
});

it('adjetivo de nível em pedido direto não transforma comando existente em diagnóstico', () => {
  expect(parseConsultation('deixa o cavaco mais baixo no PA', names)).toBeUndefined();
  expect(parseConsultation('Fred está baixo no PA', names)?.symptom).toBe('desequilibrio');
});
