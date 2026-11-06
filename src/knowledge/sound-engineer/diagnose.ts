import { diagnosticInputSchema, type Confidence, type Diagnosis } from './contracts.js';
import { instruments } from './instruments.js';
import { procedures } from './procedures.js';

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
  return {
    schemaVersion: 1, knowledgeVersion: '1.0.0', status: ready ? 'theoretical_guidance' : 'needs_context',
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
  };
}
