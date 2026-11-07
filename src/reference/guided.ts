import { z } from 'zod';
import { Envelope, Id, Observation, Scope, Text } from './values.js';
/** B submits confirmed targets, never identity, observed state, or executable proposals.
 * C can supply advice through the existing read-only recommendation port. */
export const GuidedInput = Envelope.extend({ report: Text, sourceChannel: z.number().int().min(1).max(64), destination: Scope,
  symptom: Text, checksPerformed: z.array(Text).max(10), targetConfirmed: z.literal(true), referenceId: Id.optional() }).strict();
export const GuidedContext = z.object({ schemaVersion: z.literal(1), sessionId: z.string().max(64), sourceChannel: z.number().int().positive(),
  destination: Scope, symptom: Text, checksPerformed: z.array(Text).max(10), evidenceLevel: z.literal('human_report_unverified'),
  diagnosis: z.object({ text: z.string().max(24000), status: z.enum(['needs_context', 'theoretical_guidance']).optional(), references: z.array(z.string().url().refine(s => /^https?:\/\//i.test(s))).max(10).optional() }).strict(),
  observed: z.object({ serverId: z.string(), stateRevision: z.number().int().nonnegative(), available: z.boolean(), values: z.record(z.string(), Observation) }).strict(),
  referenceId: Id.optional(), rollback: z.literal('informative_only_no_automatic_restore'),
}).strict();
export type GuidedRequestContext = z.infer<typeof GuidedContext>;
export type GuidedPreviewInput = z.infer<typeof GuidedInput>;
export interface GuidedPreview { id: string; expiresAt: string; context: GuidedRequestContext; report: string }
