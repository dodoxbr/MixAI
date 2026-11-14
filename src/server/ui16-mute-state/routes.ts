import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerCore } from '../core.js';
import type { Principal } from '../auth.js';
import { Ui16RealBridge } from '../../mixer/ui16-real-bridge.js';
import { effectiveMute, groupFlags } from '../../mixer/ui16-mute-state.js';

/**
 * GET /api/ui16/mute-state — SOMENTE LEITURA. Mostra, por canal, o MUTE individual, o Mute All, o Force Unmute e o MUTE efetivo
 * calculado só quando a regra está validada; senão `unknown` com a causa. Nenhum comando, nenhuma escrita, nenhum gate novo.
 * Mesmo modelo de acesso do restante de /api/ui16: operador autenticado, Origin conferido, sessão revalidada, no-store, só no servidor REAL.
 */
export async function ui16MuteStateRoutes(
  app: FastifyInstance,
  opts: { core: ServerCore; principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined },
) {
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req, reply) => {
    const p = opts.principal(req, reply);
    if (!p) return reply;
    if (p.role !== 'operator' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return reply.code(403).send({ code: 'FORBIDDEN' });
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
  app.get('/api/ui16/mute-state', async (req, reply) => {
    const core = opts.core;
    const bridge = core.mode === 'real' && core.mixer instanceof Ui16RealBridge ? core.mixer : undefined;
    if (!bridge) return reply.code(409).send({ code: 'MODE_MISMATCH' });
    const groups = bridge.muteGroupsFact();
    const flags = groupFlags(groups);
    const channels = core.controller.names.inputs.configured().map((channel) =>
      effectiveMute({ channel, individual: bridge.individualMuteFact(channel), groups, forceUnmute: bridge.forceUnmuteFact(channel) }),
    );
    return {
      schemaVersion: 1,
      targetMode: 'real',
      serverId: core.serverId,
      link: bridge.link(),
      hardwareValidation: 'pending',
      source: 'independent_socket_input',
      groups: {
        state: groups.state,
        mask: groups.state === 'confirmed' ? groups.value : null,
        muteAll: flags.muteAll,
        otherGroupsActive: flags.other,
        ...(groups.state === 'unknown' ? { reason: groups.reason } : {}),
      },
      channels,
      note: 'Estado observado; não é áudio medido. A precedência de Force Unmute sobre o MUTE individual e sobre os grupos ainda não foi validada na mesa física.',
    };
  });
}
