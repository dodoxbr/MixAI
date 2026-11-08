import { z } from 'zod';
import { diagnosticInputSchema, instrumentSchema, sourceCitationSchema, symptomSchema } from './contracts.js';

/** Text-only instructor: no parameter values, approval token, Intent or executable step. */
export const instructorCitationSchema = sourceCitationSchema.extend({ manufacturer: z.enum(['Soundcraft', 'Shure', 'Yamaha', 'AKG', 'MixAI']) });
export const instructorProcedureSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]+$/), version: z.literal('1.0.0'),
  purpose: z.string().min(1), instruments: z.array(instrumentSchema).min(1), symptoms: z.array(symptomSchema).min(1),
  validationStatus: z.literal('theory'), scope: z.enum(['LAB', 'official_ui_readonly']),
  origin: z.literal('mixai_editorial_adaptation'), preconditions: z.array(z.string()).min(1),
  steps: z.array(z.strictObject({
    id: z.string().min(1), control: z.string().min(1), instruction: z.string().min(1),
    verification: z.string().min(1), notFound: z.string().min(1), risks: z.array(z.string()).min(1),
    origin: z.enum(['manufacturer_documentation', 'editorial_investigation']),
    references: z.array(instructorCitationSchema).min(1),
  })).min(1),
  stop: z.string().min(1), references: z.array(instructorCitationSchema).min(1),
  execution: z.literal('not_executable'), realWrites: z.literal(false), requiresHumanReview: z.literal(true),
});
export type InstructorProcedure = z.infer<typeof instructorProcedureSchema>;
export const instructorQuerySchema = diagnosticInputSchema;
export const instructorGuidanceSchema = z.strictObject({
  schemaVersion: z.literal(1), libraryVersion: z.literal('1.0.0'),
  status: z.enum(['needs_context', 'inspection_only']), missing: z.array(z.string()),
  procedures: z.array(instructorProcedureSchema), evidenceIds: z.array(z.string()),
  measurements: z.literal('unavailable'), observedState: z.literal('not_acquired'),
  proposal: z.null(), authorizedActions: z.tuple([]), execution: z.literal('not_executable'),
}).superRefine((v, ctx) => {
  if (v.status === 'needs_context' && v.procedures.length || v.status === 'inspection_only' && (!v.evidenceIds.length || v.missing.length)) {
    ctx.addIssue({ code: 'custom', message: 'Instruções exigem relato compatível e contexto completo.' });
  }
});
export type InstructorGuidance = z.infer<typeof instructorGuidanceSchema>;
