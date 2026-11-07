import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from './auth.js';
import type { ReferenceService } from '../reference/service.js';
import { ReferenceError } from '../reference/schema.js';
const statuses = { FORBIDDEN: 403, MODE_MISMATCH: 409, INVALID: 400, NOT_FOUND: 404, CONFLICT: 409, STALE_STATE: 409, SERVER_CHANGED: 409, STORE_UNAVAILABLE: 503, CAPACITY: 409, DEPENDENCY_UNAVAILABLE: 503, UNAUTHORIZED: 401 };
export async function referenceRoutes(app: FastifyInstance, opts: {
  service: ReferenceService; origin?: string;
  principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
  active(p: Principal): boolean;
}) {
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req, reply) => {
    const p = opts.principal(req, reply); if (!p) return reply;
    if (p.role !== 'operator' && p.role !== 'musician') return reply.code(403).send({ code: 'FORBIDDEN' });
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== (opts.origin ?? `http://${req.headers.host}`)) return reply.code(403).send({ code: 'FORBIDDEN' });
    actors.set(req, p);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    const p = actors.get(req);
    if (p && !opts.active(p)) { reply.code(401); return JSON.stringify({ code: 'UNAUTHORIZED' }); }
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    const code = error instanceof ReferenceError ? error.code : 'INVALID';
    reply.code(statuses[code]).send({ code }); // No report, identity or filesystem path in logs/errors.
  });
  app.get('/api/reference-workspace', req => opts.service.view(actors.get(req)!));
  app.get<{ Params: { id: string } }>('/api/mix-requests/:id', req => opts.service.detail(actors.get(req)!, req.params.id));
  app.get<{ Params: { id: string } }>('/api/mix-references/:id/compare', req => opts.service.compare(actors.get(req)!, req.params.id));
  app.post('/api/mix-references', { bodyLimit: 4096 }, req => opts.service.capture(actors.get(req)!, req.body));
  app.post('/api/mix-requests/preview', { bodyLimit: 8192 }, req => opts.service.preview(actors.get(req)!, req.body));
  app.post('/api/mix-requests', { bodyLimit: 4096 }, req => opts.service.create(actors.get(req)!, req.body));
  for (const action of ['decide', 'cancel', 'reply', 'assess'] as const) {
    app.post<{ Params: { id: string } }>(`/api/mix-requests/:id/${action}`, { bodyLimit: 4096 }, req => opts.service[action](actors.get(req)!, req.params.id, req.body));
  }
}
