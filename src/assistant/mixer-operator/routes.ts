import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '../../server/auth.js';
import type { AssistantService } from '../service.js';
const ask = z.strictObject({ text: z.string().trim().min(1).max(500) });
const apply = z.strictObject({ requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,64}$/) });
/** HTTP adapter for the same service used by existing WS chat/cards. No executor or approval authority here. */
export async function mixerOperatorRoutes(app: FastifyInstance, opts: {
  assistant: AssistantService; serverId: string; origin?: string;
  principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined; active(p: Principal): boolean;
}) {
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req, reply) => {
    const p = opts.principal(req, reply); if (!p) return reply;
    if (p.role === 'agent') return reply.code(403).send({ code: 'FORBIDDEN' });
    if (req.headers.origin && req.headers.origin !== (opts.origin ?? `http://${req.headers.host}`)) return reply.code(403).send({ code: 'FORBIDDEN' });
    actors.set(req, p);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    const p = actors.get(req);
    if (p && !opts.active(p)) { reply.code(401); return JSON.stringify({ code: 'UNAUTHORIZED' }); }
    return payload;
  });
  app.post('/api/assistant/ask', { bodyLimit: 4096 }, async (req, reply) => {
    const input = ask.safeParse(req.body); if (!input.success) return reply.code(400).send({ code: 'INVALID' });
    return { serverId: opts.serverId, reply: await opts.assistant.ask(actors.get(req)!, input.data.text) };
  });
  app.post<{ Params: { id: string } }>('/api/assistant/proposals/:id/apply', { bodyLimit: 1024 }, async (req, reply) => {
    const input = apply.safeParse(req.body); if (!input.success || !/^[a-f0-9]{12}$/.test(req.params.id)) return reply.code(400).send({ code: 'INVALID' });
    return { serverId: opts.serverId, ...await opts.assistant.apply(actors.get(req)!, req.params.id, input.data.requestId) };
  });
}
