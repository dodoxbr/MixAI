import { SoundcheckEvent } from '../soundcheck/schema.js';
import { z } from 'zod';
import { SceneSchema, DeviceProfileSchema } from '../core/scene.js';
import { Envelope, Id, Observation, Scope, Text } from './values.js';
export { Id, Observation, Scope, Text } from './values.js';
import { GuidedContext } from './guided.js';
export const History = z.object({ version: z.number().int().positive(), at: z.iso.datetime(), action: z.string().max(40), role: z.enum(['operator', 'musician', 'system']), sourceSessionId: z.string().max(64).optional(), note: Text.optional() }).strict();
export const ReferenceSchema = z.object({
  id: Id, eventId: Id, eventName: Text, eventDate: z.iso.date(), version: z.number().int().positive(), scope: Scope,
  createdAt: z.iso.datetime(), deviceProfile: DeviceProfileSchema,
  source: z.object({ mode: z.literal('lab'), app: z.literal('MixAI'), serverId: z.string().max(64), stateRevision: z.number().int().nonnegative() }).strict(),
  validationStatus: z.literal('UNVERIFIED'), operatorApprovedAt: z.iso.datetime(), approvedBy: z.object({ sourceSessionId: z.string().max(64), role: z.literal('operator') }).strict(),
  channels: z.array(z.object({ number: z.number().int().min(1).max(64), name: Text }).strict()).max(64),
  scene: SceneSchema, observations: z.record(z.string().regex(/^(?:master\.level|ch\.\d+\.(?:main|aux\.1)\.(?:level|mute))$/), Observation),
  history: z.array(History).min(1).max(50),
}).strict();
export const RequestState = z.enum(['received', 'needs_information', 'suggested', 'approved', 'rejected', 'applied', 'failed', 'cancelled', 'expired', 'closed']);
export const RequestSchema = z.object({
  id: Id, requestId: Id, fingerprint: z.string().length(64), version: z.number().int().positive(),
  type: z.enum(['meu_canal', 'mix_geral', 'diagnostico']), report: Text, channel: z.number().int().min(1).max(64).optional(), destination: Scope,
  requestedBy: z.object({ sourceSessionId: z.string().max(64), verified: z.boolean(), musicianId: Text.optional(), displayName: Text.optional(), boundChannels: z.array(z.number().int().min(1).max(64)).max(64).optional(), bindingRevision: z.number().int().positive().optional(), boundChannel: z.number().int().min(1).max(64).optional() }).strict(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), state: RequestState,
  basis: z.object({ serverId: z.string().max(64), stateRevision: z.number().int().nonnegative() }).strict(),
  guidedId: Id.optional(), guidedContext: GuidedContext.optional(),
  response: Text.optional(), recommendation: z.object({ text: z.string().trim().min(1).max(24000).refine(s => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(s)), status: z.enum(['needs_context', 'theoretical_guidance']).optional(), source: z.enum(['operator', 'diagnosis']), references: z.array(z.string().url().max(500).refine(s => /^https?:\/\//i.test(s))).max(10).optional() }).strict().optional(),
  history: z.array(History).min(1).max(50),
}).strict();
export const DocumentSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), references: z.array(ReferenceSchema).max(100), requests: z.array(RequestSchema).max(500), soundchecks: z.array(SoundcheckEvent).max(50).default([]) }).strict();
export type Reference = z.infer<typeof ReferenceSchema>;
export type HelpRequest = z.infer<typeof RequestSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export { Envelope } from './values.js';
export const CaptureInput = Envelope.extend({ eventId: Id, eventName: Text, eventDate: z.iso.date(), scope: Scope, expectedVersion: z.number().int().nonnegative(), expectedStateRevision: z.number().int().nonnegative(), operatorApproved: z.literal(true) }).strict();
export const RequestInput = Envelope.extend({ guidedId: Id.optional(), reviewed: z.literal(true).optional(), requestId: Id, type: z.enum(['meu_canal', 'mix_geral', 'diagnostico']), report: Text, channel: z.number().int().min(1).max(64).optional(), destination: Scope }).strict();
export const DecisionInput = Envelope.extend({ expectedVersion: z.number().int().positive(), expectedStateRevision: z.number().int().nonnegative(), state: z.enum(['received', 'needs_information', 'suggested', 'approved', 'rejected', 'failed', 'closed']), response: Text }).strict();
export const RevisionInput = Envelope.extend({ expectedVersion: z.number().int().positive() }).strict();
export const ReplyInput = RevisionInput.extend({ text: Text }).strict();
export class ReferenceError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'MODE_MISMATCH' | 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'STALE_STATE' | 'SERVER_CHANGED' | 'STORE_UNAVAILABLE' | 'CAPACITY' | 'DEPENDENCY_UNAVAILABLE' | 'UNAUTHORIZED') { super(code); }
}
