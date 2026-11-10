import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const plannerSymptomSchema = z.enum(['embolado', 'estridente', 'abafado', 'magro', 'desequilibrio', 'microfonia', 'sibilancia', 'clip', 'ruido', 'monitoracao', 'ganho', 'processamento']);
export const plannerInstrumentSchema = z.enum(['cavaco', 'violao', 'surdo', 'tanta', 'pandeiro', 'vozes']);
export const plannerReferenceSchema = z.strictObject({ id, version: z.number().int().positive() });
export const plannerInputSchema = z.strictObject({
  mode: z.literal('LAB'), channel: z.number().int().min(1).max(12).optional(), instrument: plannerInstrumentSchema.optional(),
  destination: z.enum(['pa', 'fones']).optional(), symptom: plannerSymptomSchema.optional(),
  goal: z.enum(['intelligibility', 'body', 'separation', 'feedback_safety', 'comfortable_monitoring']).optional(),
  report: z.strictObject({ id, kind: z.enum(['operator_report', 'musician_report']), symptom: plannerSymptomSchema, detail: z.string().max(500).optional() }).optional(),
  comparison: z.enum(['target_only', 'both', 'unknown']).optional(), isolation: z.enum(['alone', 'ensemble', 'unknown']).optional(),
  feedback: z.enum(['active', 'contained', 'unknown']).optional(), reference: plannerReferenceSchema.optional(),
});
export type PlannerInput = z.infer<typeof plannerInputSchema>;
export const bandSourceSchema = z.strictObject({ channel: z.number().int().min(1).max(12), instrument: plannerInstrumentSchema,
  role: z.enum(['lead', 'backing', 'instrument', 'unknown']), label: z.string().max(100), microphone: z.enum(['p3s', 'unknown']) });
export type BandSource = z.infer<typeof bandSourceSchema>;
export const labObservationSchema = z.strictObject({ reference: plannerReferenceSchema, channel: z.number().int().min(1).max(12),
  destination: z.enum(['pa', 'fones']), mode: z.literal('LAB'), observedAt: z.number().finite().nonnegative(),
  revision: z.number().int().nonnegative(), levelDB: z.number().finite().min(-120).max(20).nullable(), mute: z.boolean().nullable() });
export type LabObservation = z.infer<typeof labObservationSchema>;
const text = z.string().min(1).max(800);
export const plannerCandidateSchema = z.strictObject({ id, procedureId: z.string().min(1).max(80), procedureVersion: z.string().min(1).max(30),
  purpose: text, instruction: text, preconditions: z.array(text).min(1).max(8), verification: text, stop: text,
  references: z.array(z.strictObject({ title: text, url: z.url().refine(s => s.startsWith('https://')), section: text, version: text,
    consultedOn: z.iso.date(), validationStatus: z.literal('theory') })).min(1).max(10) });
export type PlannerCandidate = z.infer<typeof plannerCandidateSchema>;
export const plannerQuestionFieldSchema = z.enum(['channel', 'destination', 'symptom', 'goal', 'report', 'comparison', 'isolation', 'feedback']);
const attemptSchema = z.strictObject({ provider: id, status: z.enum(['used', 'unavailable', 'timeout', 'error', 'empty', 'auth', 'quota', 'refused', 'recitation', 'truncated', 'invalid_output', 'not_consented']) });
const base = { schemaVersion: z.literal(1), mode: z.literal('LAB'), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  authorization: z.literal('not_granted'), execution: z.literal('not_executable'), realWrites: z.literal(false), measurements: z.literal('unavailable'),
  provider: z.strictObject({ used: id, model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/).optional(), attempts: z.array(attemptSchema).max(2) }), safety: z.array(text).min(1).max(8) };
export const plannerQuestionSchema = z.strictObject({ ...base, kind: z.literal('question'),
  question: z.strictObject({ field: plannerQuestionFieldSchema, text, choices: z.array(z.strictObject({ label: text, value: z.union([z.string().max(100), z.number().int().min(1).max(12)]) })).max(12) }) });
export const plannerProposalSchema = z.strictObject({ ...base, kind: z.literal('proposal'), proposal: z.strictObject({
  id: z.string().uuid(), scope: z.literal('single_source_lab_inspection'), channel: z.number().int().min(1).max(12),
  instrument: plannerInstrumentSchema, role: bandSourceSchema.shape.role, destination: z.enum(['pa', 'fones']),
  knowledgeVersion: z.string().min(1),
  evidence: z.array(z.strictObject({ id, kind: z.enum(['operator_report', 'musician_report']), symptom: plannerSymptomSchema, verification: z.literal('reported_not_measured') })).length(1),
  observation: labObservationSchema.nullable(),
  suggestions: z.tuple([z.strictObject({ candidate: plannerCandidateSchema, kind: z.literal('inspection'), risk: z.enum(['medium', 'high']),
    justification: text, limitations: z.array(text).min(1).max(8), targetValue: z.null(), requiresHumanReview: z.literal(true),
    rollback: z.strictObject({ automatic: z.literal(false), previousStateAvailable: z.boolean(), instruction: text }) })]),
}) });
export const plannerRefusalSchema = z.strictObject({ ...base, kind: z.literal('refusal'), reason: z.enum(['disabled', 'invalid_input', 'unsupported_source', 'safety_stop', 'stale_observation', 'stale_policy', 'provider_refused', 'invalid_model_output', 'knowledge_unavailable']), message: text });
export const plannerResultSchema = z.discriminatedUnion('kind', [plannerQuestionSchema, plannerProposalSchema, plannerRefusalSchema]);
export type PlannerResult = z.infer<typeof plannerResultSchema>;
export type PlannerQuestion = z.infer<typeof plannerQuestionSchema>;
/** Model output selects a server-owned candidate only. No prose, values, tools or authorization. */
export const modelSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('proposal'), candidate: z.string().regex(/^s[1-3]$/), evidence: z.tuple([z.literal('e1')]) }),
  z.strictObject({ kind: z.literal('abstain'), reason: z.enum(['unsafe', 'insufficient_evidence']) }),
]);
export interface PlannerProvider { readonly id: string; readonly external: boolean; generate(system: string, user: string): Promise<{ text?: string; model?: string; failure?: 'unavailable' | 'timeout' | 'error' | 'empty' | 'auth' | 'quota' | 'refused' | 'recitation' | 'truncated' }> }
export interface PlannerPolicy { enabled: boolean; active: boolean; selected: string; externalConsent: boolean; revision: number }
export interface PlannerKnowledgePort { sources(): BandSource[]; candidates(input: PlannerInput): PlannerCandidate[] }
export interface PlannerObservationPort { read(reference: NonNullable<PlannerInput['reference']>): Promise<LabObservation | undefined> }
/** D owns authentication, current revision, human review and any future LAB application. */
export interface AutoConfigPlannerPort { plan(input: unknown): Promise<PlannerResult> }
