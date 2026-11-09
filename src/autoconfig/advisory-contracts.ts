import { z } from 'zod';
import { AutoConfigProposal } from './contracts.js';
import { Envelope, Id, Scope, Text } from '../reference/values.js';
import { plannerResultSchema } from './planner/contracts.js';

/**
 * Pure (browser-safe) contracts of the consultative AutoConfig endpoint. Shared by the server
 * adapter and the operator UI so both validate exactly the same shape. No authority lives here:
 * approvals, digests, versions and simulation remain owned by D.
 */
export const AdvisoryRequest = Envelope.extend({
  // Optional: when absent the server reuses the M1 destination or asks the planner question.
  scope: Scope.optional(), eventId: Id.optional(), report: Text.optional(),
  answer: z.strictObject({ inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), value: z.union([z.string().max(100), z.number().int().min(1).max(12)]) }).optional(),
}).strict();
export type AdvisoryRequestBody = z.infer<typeof AdvisoryRequest>;

export const advisoryKnownField = z.enum(['channel', 'instrument', 'destination', 'symptom', 'goal', 'report', 'comparison', 'isolation', 'feedback']);
/** Which provider/model produced the selection. Names come from server config, never from the model. */
export const AdvisoryModel = z.strictObject({
  selected: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  used: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  name: z.string().min(1).max(100).nullable(),
  external: z.boolean(),
});
export const AdvisoryResponse = z.strictObject({ serverId: Id, advice: plannerResultSchema,
  proposal: AutoConfigProposal.nullable(), numericInput: z.literal('operator_required'), createsDraft: z.literal(false),
  model: AdvisoryModel,
  // Field NAMES already known (from M1 or earlier answers); no values, free text or private data.
  context: z.strictObject({ fromDiagnosis: z.boolean(), known: z.array(advisoryKnownField).max(9) }),
}).superRefine((v, ctx) => {
  if (v.proposal?.items.some(i => i.deltaDB !== undefined)) ctx.addIssue({ code: 'custom', message: 'Somente o operador informa alterações numéricas.' });
  if (v.model.used !== v.advice.provider.used) ctx.addIssue({ code: 'custom', message: 'Provedor informado diverge do resultado.' });
});
export type AutoConfigAdvice = z.infer<typeof AdvisoryResponse>;
