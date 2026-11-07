import { z } from 'zod';
import { diagnosticConsultationSchema, instrumentSchema, symptomSchema } from './contracts.js';

export const diagnosticQuestionFieldSchema = z.enum(['symptom', 'channel', 'instrument', 'destination', 'report', 'scope', 'isolation', 'capture', 'check']);
export type DiagnosticQuestionField = z.infer<typeof diagnosticQuestionFieldSchema>;
export const checkResultSchema = z.enum(['better', 'same', 'worse', 'not_checked', 'issue_found', 'no_issue']);
/** Server-owned progress; never accepted in HTTP/WS input. Answers are reports, not measurements. */
export const diagnosticProgressSchema = z.strictObject({
  scope: z.enum(['selected_only', 'both', 'unknown']).optional(),
  isolation: z.enum(['alone', 'ensemble', 'unknown']).optional(),
  capture: z.enum(['microphone', 'pickup_di', 'unknown']).optional(),
  report: z.enum(['current', 'conceptual']).optional(),
  results: z.array(z.strictObject({ checkId: z.string().min(1), result: checkResultSchema })).max(3).default([]),
});
export type DiagnosticProgress = z.infer<typeof diagnosticProgressSchema>;
export const diagnosticCheckSchema = z.strictObject({
  id: z.string().min(1), instruction: z.string().min(1), expectedObservation: z.string().min(1), rollback: z.string().min(1),
  execution: z.literal('not_executable'), requiresHumanReview: z.literal(true),
});
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;
export const diagnosticQuestionSchema = z.strictObject({ id: z.string().min(1), field: diagnosticQuestionFieldSchema, prompt: z.string().min(1) });
export const diagnosticChoiceSchema = z.strictObject({ id: z.string().min(1), label: z.string().min(1), value: z.string().min(1) });
export type DiagnosticQuestion = z.infer<typeof diagnosticQuestionSchema>;
export type DiagnosticChoice = z.infer<typeof diagnosticChoiceSchema>;
/** Additive wire contract for B (UI) and D (read-only recommendation adapter).
 * sessionId is an investigation ID, NEVER an authentication/authorization credential.
 */
export const diagnosticSessionSchema = z.strictObject({
  schemaVersion: z.literal(1), sessionId: z.string().uuid().nullable(), revision: z.number().int().positive().nullable(), expiresAt: z.string().datetime().nullable(),
  status: z.enum(['clarifying', 'investigating', 'complete', 'snapshot']),
  knownContext: z.strictObject({
    symptom: symptomSchema.nullable(), channel: z.number().int().positive().nullable(), sourceLabel: z.string().nullable(),
    instrument: instrumentSchema.nullable(), relatedInstruments: z.array(instrumentSchema).max(6), destination: z.enum(['pa', 'fones']).nullable(),
    scope: z.enum(['selected_only', 'both', 'unknown']).nullable(), isolation: z.enum(['alone', 'ensemble', 'unknown']).nullable(),
    capture: z.enum(['microphone', 'pickup_di', 'unknown']).nullable(),
    basis: z.literal('reported_or_configured_not_measured'), results: diagnosticProgressSchema.shape.results,
  }),
  pendingQuestion: diagnosticQuestionSchema.nullable(), choices: z.array(diagnosticChoiceSchema).max(16), nextCheck: diagnosticCheckSchema.nullable(),
  evidence: diagnosticConsultationSchema.shape.evidence, confidence: diagnosticConsultationSchema.shape.confidence,
  safety: z.strictObject({ measurements: z.literal('unavailable'), observedState: z.literal('not_acquired'),
    automaticActions: z.literal(false), realWrites: z.literal(false), identity: z.literal('not_inferred'), warnings: z.array(z.string()),
  }),
  references: diagnosticConsultationSchema.shape.references,
}).superRefine((s, ctx) => {
  if ((s.sessionId === null) !== (s.revision === null) || (s.sessionId === null) !== (s.expiresAt === null) ||
    (!s.pendingQuestion && s.choices.length) || new Set(s.choices.map(c => c.id)).size !== s.choices.length ||
    new Set(s.knownContext.results.map(r => r.checkId)).size !== s.knownContext.results.length) {
    ctx.addIssue({ code: 'custom', message: 'Sessão diagnóstica inconsistente.' });
  }
});
export type DiagnosticSession = z.infer<typeof diagnosticSessionSchema>;
/** UI adapter: send only a current choice label plus revision, never replay input/evidence. */
export function diagnosticAnswerFor(session: DiagnosticSession, choiceId: string): { text: string; context: { id: string; revision: number } } {
  const choice = session.choices.find(c => c.id === choiceId);
  if (!session.sessionId || !session.revision || !session.pendingQuestion || !choice) throw new Error('DIAGNOSIS_NO_CURRENT_CHOICE');
  return { text: choice.label, context: { id: session.sessionId, revision: session.revision } };
}
