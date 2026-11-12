import { z } from 'zod';
/** Model output chooses an interpretation, never network commands, values, authorization or tools. */
const target = { channel: z.string().regex(/^c[1-9][0-9]*$/), destination: z.string().regex(/^(pa|fones|a[1-9][0-9]*)$/) };
export const mixerInterpretationSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('level'), ...target, direction: z.enum(['up', 'down']), amount: z.enum(['specified', 'configured']), mode: z.enum(['relative', 'absolute']) }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('mute'), ...target, muted: z.boolean() }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('query'), ...target, parameter: z.enum(['level', 'mute', 'configuration']) }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('diagnose'), channel: target.channel }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('undo') }),
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('clarify'), field: z.enum(['channel', 'destination', 'amount', 'request']) }),
]);
export type MixerInterpretation = z.infer<typeof mixerInterpretationSchema>;
export interface OperatorObservations {
  schemaVersion: 1; mode: 'lab' | 'mock' | 'real'; link: string; revision: number; channel: number; destination: string;
  parameters: Array<{ key: string; status: 'known' | 'unknown' | 'unavailable' | 'unsupported'; value?: number | boolean | '-inf'; revision: number; capability: string }>;
  unavailable: string[]; limitations: string[];
}
