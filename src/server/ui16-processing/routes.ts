import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerCore } from '../core.js';
import type { Principal } from '../auth.js';
import { Ui16ProcessingService } from './service.js';
const services = new WeakMap<ServerCore, Ui16ProcessingService>();
const common = { targetMode: z.literal('real'), serverId: z.string().uuid() };
const preview = z.union([
  z.strictObject({
    ...common,
    key: z.string().max(80),
    value: z.union([z.number().finite(), z.boolean()]),
    source: z.enum(['operator', 'assistant']).optional(),
  }),
  z.strictObject({ ...common, undo: z.literal(true) }),
]);
const confirm = z.strictObject({
  ...common,
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  humanConfirmed: z.literal(true),
});
export async function ui16ProcessingRoutes(
  app: FastifyInstance,
  opts: {
    core: ServerCore;
    principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
  },
) {
  const service = services.get(opts.core) ?? new Ui16ProcessingService(opts.core);
  services.set(opts.core, service);
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req, reply) => {
    const p = opts.principal(req, reply);
    if (!p) return reply;
    if (
      p.role !== 'operator' ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
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
  app.get<{ Params: { channel: string } }>('/api/ui16/processing/:channel', async (req, reply) => {
    if (!/^(?:[1-9]|1[0-2])$/.test(req.params.channel))
      return reply.code(400).send({ code: 'INVALID' });
    return service.state(actors.get(req)!, Number(req.params.channel));
  });
  app.post('/api/ui16/processing/preview', { bodyLimit: 2048 }, async (req, reply) => {
    const input = preview.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ code: 'INVALID' });
    return service.preview(actors.get(req)!, input.data);
  });
  for (const action of ['confirm', 'cancel'] as const)
    app.post<{ Params: { id: string } }>(
      `/api/ui16/processing/:id/${action}`,
      { bodyLimit: 2048 },
      async (req, reply) => {
        if (!/^[a-f0-9]{12}$/.test(req.params.id)) return reply.code(400).send({ code: 'INVALID' });
        const input = (action === 'confirm' ? confirm : z.strictObject(common)).safeParse(req.body);
        if (!input.success) return reply.code(400).send({ code: 'INVALID' });
        return action === 'confirm'
          ? service.confirm(actors.get(req)!, req.params.id, input.data as z.infer<typeof confirm>)
          : service.cancel(actors.get(req)!, req.params.id);
      },
    );
}
