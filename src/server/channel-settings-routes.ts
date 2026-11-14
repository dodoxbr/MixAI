import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  ChannelSettingsError,
  channelSettingsUpdate,
  type ChannelSettings,
} from '../core/channel-settings.js';
import type { Principal } from './auth.js';
import type { ServerCore } from './core.js';
export async function channelSettingsRoutes(
  app: FastifyInstance,
  opts: {
    core: ServerCore;
    settings: ChannelSettings;
    origin?: string;
    principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
  },
) {
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req, reply) => {
    const p = opts.principal(req, reply);
    if (!p) return reply;
    if (p.role !== 'operator')
      return reply.code(403).send({ code: 'FORBIDDEN' });
    if (
      req.headers.origin &&
      req.headers.origin !== (opts.origin ?? `http://${req.headers.host}`)
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
  const run = (reply: FastifyReply, fn: () => unknown) => {
    try {
      return { serverId: opts.core.serverId, settings: fn() };
    } catch (e) {
      if (e instanceof ChannelSettingsError)
        return reply
          .code(
            e.code === 'CONFLICT'
              ? 409
              : e.code === 'INVALID'
                ? 400
                : e.code === 'FORBIDDEN'
                  ? 403
                  : 503,
          )
          .send({ code: e.code, message: e.message });
      throw e;
    }
  };
  app.get('/api/settings/channels', async (_req, reply) =>
    run(reply, () => opts.settings.snapshot()),
  );
  app.put(
    '/api/settings/channels',
    { bodyLimit: 128 * 1024 },
    async (req, reply) => {
      const parsed = channelSettingsUpdate.safeParse(req.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({
            code: 'INVALID',
            message: 'Confira nomes, apelidos e números físicos.',
          });
      if (parsed.data.serverId !== opts.core.serverId)
        return reply
          .code(409)
          .send({
            code: 'SERVER_CHANGED',
            message: 'Servidor mudou; recarregue as configurações.',
          });
      return run(reply, () =>
        opts.settings.save(parsed.data, () =>
          opts.core.auth.isActive(actors.get(req)!),
        ),
      );
    },
  );
}
