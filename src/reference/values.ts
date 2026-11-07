import { z } from 'zod';
export const Text = z.string().trim().min(1).max(500).refine(s => !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(s));
export const Id = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);
export const Scope = z.enum(['PA', 'AUX1']);
export const Observation = z.object({
  status: z.enum(['known', 'unknown', 'unavailable', 'unsupported']),
  value: z.union([z.number().finite(), z.boolean(), z.literal('-inf')]).optional(),
  revision: z.number().int().nonnegative(), actor: z.string().max(30).optional(),
}).strict().refine(v => (v.status === 'known') === (v.value !== undefined));

export const Envelope = z.object({ serverId: z.string().min(1).max(64) });
