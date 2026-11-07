import { diagnosticConsultationSchema, diagnosticInputSchema, type Confidence, type Diagnosis } from './contracts.js';
import { instruments } from './instruments.js';
import { procedures } from './procedures.js';
import { instrumentProfiles, interactions, voiceRole } from './band-context.js';
import { citations, KNOWLEDGE_VERSION, modulesFor, technicalModules } from './technical-modules.js';

/** Consulta pura, determinística e sem acesso a adaptador, rede, arquivos, áudio ou relógio. */
export function diagnose(input: unknown): Diagnosis {
  const context = diagnosticInputSchema.parse(input);
  const procedure = procedures[context.symptom];
  const reports = context.evidence.filter(e => e.kind === 'operator_report' && e.symptom === context.symptom);
  const confidence: Confidence = reports.length ? {
    level: 'low', basis: 'operator_report_only',
    rationale: 'Relato humano compatível; causas alternativas ainda não verificadas. Não houve análise de áudio.',
  } : {
    level: 'insufficient', basis: 'no_matching_report',
    rationale: 'Sem relato compatível. Controles e medidores simulados não comprovam o sintoma.',
  };
  const questions = [...procedure.questions];
  if (!context.destination) questions.unshift('Especifique PA ou FONES antes de qualquer proposta.');
  if (!context.instrument) questions.unshift('Qual instrumento ou voz apresenta o problema?');
  if (!reports.length) questions.unshift('Peça ao operador um relato do que está ouvindo no destino informado.');
  const ready = reports.length > 0 && !!context.destination && !!context.instrument;
  const hypotheses = procedure.causes.map((explanation, i) => ({
    id: `${context.symptom}.h${i + 1}`, explanation,
    supportingEvidenceIds: reports.map(e => e.id),
    missingEvidence: [...procedure.questions], confidence: { ...confidence }, references: procedure.references,
  }));
  const preconditions = ['Revisão por operador humano.', 'Confirmar instrumento, canal físico e destino; AUX 1 é compartilhado.', 'Registrar estado anterior e comparar o mesmo trecho em nível confortável.'];
  const recommendations: Diagnosis['recommendations'] = reports.length ? [
    ...procedure.checks.map((instruction, i) => ({
      id: `${context.symptom}.check${i + 1}`, kind: 'inspection' as const, instruction,
      hypothesisIds: hypotheses.map(h => h.id), preconditions,
      expectedObservation: 'Operador registra se a verificação sustenta ou contradiz a hipótese.',
      stopOrRevert: 'Se faltar contexto, interromper a investigação e pedir esclarecimento.',
      execution: 'not_executable' as const, requiresHumanReview: true as const, references: procedure.references,
    })),
    ...(ready ? [{
      id: `${context.symptom}.trial`, kind: 'theoretical_trial' as const, instruction: procedure.trial,
      hypothesisIds: hypotheses.map(h => h.id), preconditions,
      expectedObservation: procedure.expectedObservation, stopOrRevert: procedure.stopOrRevert,
      execution: 'not_executable' as const, requiresHumanReview: true as const, references: procedure.references,
    }] : []),
  ] : [];
  const role = context.instrument === 'vozes' ? voiceRole(context.channel, context.sourceLabel) : 'unknown';
  const profiles = instrumentProfiles.filter(p => p.instrument === context.instrument &&
    (context.instrument !== 'vozes' || role === 'unknown' || p.id === `voice-${role}`));
  const involved = new Set([context.instrument, ...(context.relatedInstruments ?? [])]);
  const related = interactions.filter(item => item.instruments.every(instrument => involved.has(instrument)));
  const moduleIds = modulesFor(context.symptom);
  const moduleRefs = moduleIds.flatMap(id => technicalModules[id].references);
  const refs = citations([...procedure.references, ...moduleRefs, ...profiles.flatMap(p => p.references)]);
  const consultation = diagnosticConsultationSchema.parse({
    schemaVersion: 1, knowledgeVersion: KNOWLEDGE_VERSION,
    diagnostic: { symptom: context.symptom, channel: context.channel ?? null, destination: context.destination ?? null,
      voiceRole: role, roleBasis: role === 'unknown' ? 'unconfirmed' : 'configuration_label_match',
      interactionIds: related.map(i => i.id), profileIds: profiles.map(p => p.id) },
    evidence: {
      musicianReports: context.evidence.filter(e => e.kind === 'operator_report'),
      controlReadings: context.evidence.filter(e => e.kind === 'control_state').map(evidence => ({ evidence, verification: 'caller_declared_not_verified' })),
      simulated: context.evidence.filter(e => e.kind === 'simulated_meter'),
      unavailableMeasurements: ['audio', 'rta', 'spl', 'real_input_meter', 'gain_reduction'],
    },
    nextQuestions: questions.slice(0, 3),
    recommendations: recommendations.map(r => ({ id: r.id, kind: r.kind, instruction: r.instruction,
      moduleIds, knowledgeVersion: KNOWLEDGE_VERSION, validationStatus: 'theory', requiresApproval: true, execution: 'not_executable',
      preconditions: r.preconditions, expectedObservation: r.expectedObservation, rollback: r.stopOrRevert,
      evidenceIds: reports.map(e => e.id), hypothesisIds: r.hypothesisIds, references: citations([...r.references, ...moduleRefs]) })),
    references: refs, proposal: null, requiresApproval: true, authorizedActions: [],
    rollback: { automatic: false, instruction: context.symptom === 'microfonia'
      ? 'Se apitar, interromper e chamar operador. Não restaurar automaticamente nem voltar a um estado inseguro.'
      : 'Registrar antes/depois. Reversão somente manual pelo operador na UI oficial, se o estado anterior for seguro.' },
    confidence,
  });
  return structuredClone({
    consultation,
    bandGuidance: [...profiles.map(p => `${p.role} Conferir: ${p.verify} Cuidado: ${p.avoid}`), ...related.map(i => i.guidance)],
    schemaVersion: 1, knowledgeVersion: KNOWLEDGE_VERSION, status: ready ? 'theoretical_guidance' : 'needs_context',
    symptom: context.symptom, evidence: structuredClone(context.evidence), confidence, hypotheses, recommendations, questions,
    ...(context.instrument ? { instrumentGuide: instruments[context.instrument] } : {}),
    audioAnalysis: 'not_performed',
    limitations: [
      'O sistema não ouviu o som; não há captura real de áudio nesta entrega.',
      'Sintomas e frequências são hipóteses teóricas; faders, mutes e VU não diagnosticam espectro nem microfonia.',
      'Medidores simulados não medem o som da mesa. Medição real depende de F0/E6; análise espectral está fora do escopo.',
      'Nenhuma recomendação é comando ou autorização; não há ajuste automático nem alteração de processamento.',
      'Guias de samba/pagode não foram validados em ensaio; firmware e resposta física da Ui16 da banda desconhecidos.',
    ],
  });
}
