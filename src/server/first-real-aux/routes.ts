import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerCore } from '../core.js';
import type { Principal } from '../auth.js';
import { FirstRealAuxService } from './service.js';
const services = new WeakMap<ServerCore, FirstRealAuxService>();
const common = { targetMode: z.literal('real'), serverId: z.string().uuid() };
const preview = z.union([
  z.strictObject({
    ...common,
    channel: z.number().int().min(1).max(12),
    aux: z.number().int().min(1).max(6),
    deltaDB: z
      .number()
      .min(-1)
      .max(1)
      .refine((n) => n !== 0),
  }),
  z.strictObject({ ...common, undo: z.literal(true) }),
]);
const apply = z.strictObject({
  ...common,
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  humanConfirmed: z.literal(true),
});
export async function firstRealAuxRoutes(
  app: FastifyInstance,
  opts: {
    core: ServerCore;
    principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
  },
) {
  const service = services.get(opts.core) ?? new FirstRealAuxService(opts.core);
  services.set(opts.core, service);
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req, reply) => {
    const p = opts.principal(req, reply);
    if (!p) return reply;
    if (p.role !== 'operator')
      return reply.code(403).send({ code: 'FORBIDDEN' });
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return reply.code(403).send({ code: 'FORBIDDEN' });
    actors.set(req, p);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    const p = actors.get(req);
    if (p && !opts.core.auth.isActive(p)) {
      reply.code(401);
      return JSON.stringify({ code: 'UNAUTHORIZED' });
    }
    return payload;
  });
  const statusQuery = z.strictObject({
    channel: z.coerce.number().int().min(1).max(12).optional(),
    aux: z.coerce.number().int().min(1).max(6).optional(),
  });
  app.get('/api/ui16/aux/status', async (req, reply) => {
    const q = statusQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ code: 'INVALID' });
    return service.status(actors.get(req)!, q.data);
  });
  app.post('/api/ui16/aux/preview', { bodyLimit: 2048 }, async (req, reply) => {
    const input = preview.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ code: 'INVALID' });
    return service.preview(actors.get(req)!, input.data);
  });
  app.post<{ Params: { id: string } }>(
    '/api/ui16/aux/:id/confirm',
    { bodyLimit: 2048 },
    async (req, reply) => {
      const input = apply.safeParse(req.body);
      if (!input.success || !/^[a-f0-9]{12}$/.test(req.params.id))
        return reply.code(400).send({ code: 'INVALID' });
      return service.apply(actors.get(req)!, req.params.id, input.data);
    },
  );
}
