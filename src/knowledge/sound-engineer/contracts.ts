import { z } from 'zod';

export const symptomSchema = z.enum(['embolado', 'estridente', 'abafado', 'magro', 'desequilibrio']);
export const instrumentSchema = z.enum(['cavaco', 'violao', 'surdo', 'tanta', 'pandeiro', 'vozes']);
export type Symptom = z.infer<typeof symptomSchema>;
export type Instrument = z.infer<typeof instrumentSchema>;
export type SourceId = 'ui16-manual' | 'library-7.1.0' | 'yamaha-eq' | 'yamaha-gain' | 'yamaha-dynamics' | 'shure-placement' | 'shure-live';
export interface Reference { source: SourceId; locator: string }

const evidenceBase = { id: z.string().min(1), detail: z.string().min(1) };
/** Sem captura de áudio ou medidores reais nesta entrega. Estado não é sinal. */
export const evidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...evidenceBase, kind: z.literal('operator_report'), symptom: symptomSchema }),
  z.strictObject({ ...evidenceBase, kind: z.literal('control_state'), parameter: z.string().min(1), value: z.union([z.number().finite(), z.boolean()]), revision: z.number().int().nonnegative() }),
  z.strictObject({ ...evidenceBase, kind: z.literal('simulated_meter'), valueDB: z.number().finite() }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;
export const diagnosticInputSchema = z.strictObject({
  symptom: symptomSchema,
  instrument: instrumentSchema.optional(),
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
  basis: 'no_matching_report' | 'operator_report_only';
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
  references: readonly Reference[];
}
export interface Diagnosis {
  schemaVersion: 1;
  knowledgeVersion: '1.0.0';
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
}
