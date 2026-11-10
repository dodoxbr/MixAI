import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { completionRequestSchema, ModelCatalogError, selectionRequestSchema, validationRequestSchema, type CatalogActor } from './contracts.js';
import type { ModelCatalogService } from './service.js';
const codes: Record<string, number> = { INVALID: 400, FORBIDDEN: 403, UNAUTHORIZED: 401, DISABLED: 503, NOT_CONFIGURED: 503, NOT_CONSENTED: 403,
  MODEL_UNAVAILABLE: 422, PRICE_UNKNOWN: 409, STALE: 409, BUSY: 409, RATE_LIMIT: 429, BUDGET: 429, UNAVAILABLE: 503 };
const clearSchema = z.strictObject({ schemaVersion: z.literal(1), expectedRevision: z.number().int().nonnegative() });
const SYSTEM = 'Você é um consultor técnico de som. Responda somente com texto consultivo. Não execute ferramentas, não autorize mudanças e não invente medições. O texto não é um comando nem uma aprovação.';
export async function modelCatalogRoutes(app: FastifyInstance, ports: { service: ModelCatalogService; origin?: string;
  principal(req: FastifyRequest, reply: FastifyReply): CatalogActor | undefined; active(actor: CatalogActor): boolean }) {
  const actors = new WeakMap<FastifyRequest, CatalogActor>();
  app.addHook('onRequest', async (req, reply) => {
    const actor = ports.principal(req, reply); if (!actor) return reply;
    if (actor.role !== 'operator') return reply.code(403).send({ schemaVersion: 1, code: 'FORBIDDEN' });
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== (ports.origin ?? `http://${req.headers.host}`)) return reply.code(403).send({ schemaVersion: 1, code: 'FORBIDDEN' });
    actors.set(req, actor);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    const actor = actors.get(req);
    if (actor && !ports.active(actor)) { reply.code(401); return JSON.stringify({ schemaVersion: 1, code: 'UNAUTHORIZED' }); }
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ModelCatalogError) return reply.code(codes[error.code]).send({ schemaVersion: 1, code: error.code });
    const code = error instanceof z.ZodError || (error as { statusCode?: number }).statusCode === 400 || (error as { statusCode?: number }).statusCode === 413 ? 'INVALID' : 'UNAVAILABLE';
    return reply.code(codes[code]).send({ schemaVersion: 1, code });
  });
  app.get('/api/ai/models', req => ports.service.view(actors.get(req)!));
  app.post('/api/ai/models/validate', { bodyLimit: 2048 }, req => {
    const body = validationRequestSchema.parse(req.body);
    return ports.service.validate(actors.get(req)!, body.provider, body.model, body.confirmExternal === true);
  });
  app.post('/api/ai/models/selection', { bodyLimit: 2048 }, req => ports.service.select(actors.get(req)!, selectionRequestSchema.parse(req.body)));
  app.delete('/api/ai/models/selection', { bodyLimit: 2048 }, req => ports.service.clear(actors.get(req)!, clearSchema.parse(req.body).expectedRevision));
  app.post('/api/ai/models/complete', { bodyLimit: 18000 }, req => {
    const body = completionRequestSchema.parse(req.body);
    return ports.service.generate(actors.get(req)!, SYSTEM, body.text, body.expectedRevision);
  });
}
