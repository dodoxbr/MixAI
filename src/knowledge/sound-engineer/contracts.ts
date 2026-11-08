import { z } from 'zod';

export const symptomSchema = z.enum(['embolado', 'estridente', 'abafado', 'magro', 'desequilibrio', 'microfonia', 'sibilancia', 'clip', 'ruido', 'monitoracao', 'ganho', 'processamento']);
export const instrumentSchema = z.enum(['cavaco', 'violao', 'surdo', 'tanta', 'pandeiro', 'vozes']);
export type Symptom = z.infer<typeof symptomSchema>;
export type Instrument = z.infer<typeof instrumentSchema>;
export const sourceIdSchema = z.enum(['ui16-manual', 'library-7.1.0', 'yamaha-eq', 'yamaha-gain', 'yamaha-dynamics', 'shure-placement', 'shure-live', 'shure-feedback', 'ui16-manual-pt', 'akg-p3', 'band-report-65']);
export type SourceId = z.infer<typeof sourceIdSchema>;
export interface Reference { source: SourceId; locator: string }

const evidenceBase = { id: z.string().min(1), detail: z.string().min(1) };
/** Sem captura de áudio ou medidores reais nesta entrega. Estado não é sinal. */
export const evidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...evidenceBase, kind: z.literal('operator_report'), symptom: symptomSchema }),
  z.strictObject({ ...evidenceBase, kind: z.literal('musician_report'), symptom: symptomSchema, verification: z.literal('unverified') }),
  z.strictObject({ ...evidenceBase, kind: z.literal('control_state'), parameter: z.string().min(1), value: z.union([z.number().finite(), z.boolean()]), revision: z.number().int().nonnegative(), observedAt: z.string().datetime().optional() }),
  z.strictObject({ ...evidenceBase, kind: z.literal('simulated_meter'), valueDB: z.number().finite() }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;
export const diagnosticInputSchema = z.strictObject({
  symptom: symptomSchema,
  instrument: instrumentSchema.optional(),
  channel: z.number().int().min(1).max(12).optional(),
  sourceLabel: z.string().trim().min(1).max(100).optional(),
  relatedInstruments: z.array(instrumentSchema).max(6).optional(),
  destination: z.enum(['pa', 'fones']).optional(),
  evidence: z.array(evidenceSchema).superRefine((items, ctx) => {
    if (new Set(items.map(item => item.id)).size !== items.length) {
      ctx.addIssue({ code: 'custom', message: 'IDs de evidência devem ser únicos.' });
    }
  }),
});
export type DiagnosticInput = z.infer<typeof diagnosticInputSchema>;
export interface Confidence {
  level: 'insufficient' | 'low' | 'moderate' | 'high';
  rationale: string;
  /** Confiança qualitativa na hipótese; nunca probabilidade calibrada. */
  basis: 'no_matching_report' | 'operator_report_only' | 'musician_report_only';
}
export interface Hypothesis {
  id: string;
  explanation: string;
  supportingEvidenceIds: readonly string[];
  missingEvidence: readonly string[];
  confidence: Confidence;
  references: readonly Reference[];
}
/** Texto para revisão humana. Não é Intent, comando, preset ou autorização. */
export interface Recommendation {
  id: string;
  kind: 'inspection' | 'theoretical_trial';
  instruction: string;
  hypothesisIds: readonly string[];
  preconditions: readonly string[];
  expectedObservation: string;
  stopOrRevert: string;
  execution: 'not_executable';
  requiresHumanReview: true;
  references: readonly Reference[];
}
export interface Procedure {
  symptom: Symptom;
  meaning: string;
  questions: readonly string[];
  causes: readonly string[];
  checks: readonly string[];
  trial: string;
  expectedObservation: string;
  stopOrRevert: string;
  references: readonly Reference[];
}
export interface InstrumentGuide {
  instrument: Instrument;
  role: string;
  captureChecks: readonly string[];
  conditionalAdvice: readonly string[];
  avoid: string;
  validation: 'not_validated_in_rehearsal';
  version: '2.0.0';
  validationStatus: 'theory';
  references: readonly Reference[];
}
export interface Diagnosis {
  schemaVersion: 1;
  knowledgeVersion: '2.0.0';
  status: 'needs_context' | 'theoretical_guidance';
  symptom: Symptom;
  evidence: readonly Evidence[];
  confidence: Confidence;
  hypotheses: readonly Hypothesis[];
  recommendations: readonly Recommendation[];
  questions: readonly string[];
  instrumentGuide?: InstrumentGuide;
  audioAnalysis: 'not_performed';
  limitations: readonly string[];
  consultation: DiagnosticConsultation;
  bandGuidance: readonly string[];
}

/** Additive consultation contract v1. No execution payload or approval can be represented. */
export const validationStatusSchema = z.enum(['theory', 'verified_at_rehearsal']);
export const technicalModuleIdSchema = z.enum(['capture', 'eq_hpf', 'geq_rta', 'afs2', 'gain', 'dynamics', 'band_balance', 'monitoring']);
export const sourceCitationSchema = z.strictObject({
  source: sourceIdSchema, title: z.string().min(1), url: z.url().refine(url => url.startsWith('https://')), version: z.string().min(1),
  section: z.string().min(1), consultedOn: z.iso.date(),
  accessStatus: z.enum(['consulted', 'historical', 'unavailable']),
});
export const diagnosticRecommendationSchema = z.strictObject({
  id: z.string().min(1), kind: z.enum(['inspection', 'theoretical_trial']), instruction: z.string().min(1),
  moduleIds: z.array(technicalModuleIdSchema).min(1), knowledgeVersion: z.literal('2.0.0'),
  validationStatus: z.literal('theory'), requiresApproval: z.literal(true), execution: z.literal('not_executable'),
  preconditions: z.array(z.string()).min(1), expectedObservation: z.string().min(1), rollback: z.string().min(1),
  evidenceIds: z.array(z.string()), hypothesisIds: z.array(z.string()), references: z.array(sourceCitationSchema).min(1),
});
export type DiagnosticRecommendation = z.infer<typeof diagnosticRecommendationSchema>;
export const diagnosticHypothesisSchema = z.strictObject({
  id: z.string().min(1), explanation: z.string().min(1), supportingEvidenceIds: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  confidence: z.strictObject({ level: z.enum(['insufficient', 'low']), basis: z.enum(['no_matching_report', 'operator_report_only', 'musician_report_only']), rationale: z.string() }),
  references: z.array(sourceCitationSchema).min(1),
});
export const diagnosticConsultationSchema = z.strictObject({
  schemaVersion: z.literal(1), knowledgeVersion: z.literal('2.0.0'),
  diagnostic: z.strictObject({ symptom: symptomSchema, channel: z.number().int().min(1).max(12).nullable(),
    destination: z.enum(['pa', 'fones']).nullable(), voiceRole: z.enum(['lead', 'backing', 'unknown']),
    hypotheses: z.array(diagnosticHypothesisSchema),
    roleBasis: z.enum(['configuration_label_match', 'unconfirmed']), interactionIds: z.array(z.string()), profileIds: z.array(z.string()),
  }),
  evidence: z.strictObject({
    reports: z.array(z.union([evidenceSchema.options[0], evidenceSchema.options[1]])),
    controlReadings: z.array(z.strictObject({ evidence: evidenceSchema.options[2], verification: z.literal('caller_declared_not_verified') })),
    simulated: z.array(evidenceSchema.options[3]),
    unavailableMeasurements: z.array(z.enum(['audio', 'rta', 'spl', 'real_input_meter', 'gain_reduction'])).min(1),
  }),
  nextQuestions: z.array(z.string()).max(3),
  recommendations: z.array(diagnosticRecommendationSchema), references: z.array(sourceCitationSchema),
  proposal: z.null(), requiresApproval: z.literal(true), authorizedActions: z.tuple([]),
  rollback: z.strictObject({ automatic: z.literal(false), instruction: z.string().min(1) }),
  confidence: z.strictObject({ level: z.enum(['insufficient', 'low']), basis: z.enum(['no_matching_report', 'operator_report_only', 'musician_report_only']), rationale: z.string() }),
}).superRefine((value, ctx) => {
  const evidenceIds = [...value.evidence.reports, ...value.evidence.controlReadings.map(r => r.evidence), ...value.evidence.simulated].map(e => e.id);
  const hypotheses = value.diagnostic.hypotheses;
  const hypothesisIds = new Set(hypotheses.map(h => h.id));
  const reports = new Map(value.evidence.reports.map(e => [e.id, e.symptom]));
  if (new Set(evidenceIds).size !== evidenceIds.length || hypothesisIds.size !== hypotheses.length ||
    new Set(value.recommendations.map(r => r.id)).size !== value.recommendations.length ||
    hypotheses.some(h => h.supportingEvidenceIds.some(id => reports.get(id) !== value.diagnostic.symptom)) ||
    value.recommendations.some(r => r.hypothesisIds.some(id => !hypothesisIds.has(id)) || r.evidenceIds.some(id => reports.get(id) !== value.diagnostic.symptom))) {
    ctx.addIssue({ code: 'custom', message: 'Rastreabilidade de evidências/hipóteses inconsistente.' });
  }
});
export type DiagnosticConsultation = z.infer<typeof diagnosticConsultationSchema>;
