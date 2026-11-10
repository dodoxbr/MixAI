import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KnowledgeError, type LocalKnowledge } from '../knowledge/local/index.js';
import type { Principal } from './auth.js';

const statuses = { INVALID: 400, NOT_FOUND: 404, UNAVAILABLE: 503, FORBIDDEN: 403, UNAUTHORIZED: 401, BUSY: 409 } as const;
const searchBody = z.strictObject({ query: z.string().trim().min(2).max(300) });
const micBody = z.strictObject({ channel: z.number().int().min(1).max(12), modelId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable() });
const providerBody = z.strictObject({ chat: z.enum(['ollama', 'gemini', 'deepseek', 'anthropic']), confirmExternal: z.boolean().optional(), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/).optional() });
const idParam = z.string().regex(/^d[a-z0-9]{3,40}$/);

/**
 * Administração da base de conhecimento. EXCLUSIVA do operador: músico e agente MCP recebem 403.
 * Nenhuma rota fala com a mesa. Importação e ingestão rodam uma por vez (409 se já houver uma).
 */
export async function knowledgeRoutes(app: FastifyInstance, opts: {
  service: LocalKnowledge; origin?: string;
  onProviderSelection?: (p: Principal, selected: string, confirmed: boolean) => void;
  /** O operador desta sessão confirmou o envio ao provedor selecionado? (memória; nunca vem de preferência ou chave) */
  consented?: (p: Principal, selected: string) => boolean;
  consentRevision?: () => number;
  onProviderSelectionStart?: () => void;
  onConsentRevocation?: (p: Principal) => void;
  principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
  active(p: Principal): boolean;
}) {
  const actors = new WeakMap<FastifyRequest, Principal>();
  let busy = false;
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw new KnowledgeError('INVALID', 'Já existe uma importação em andamento.');
    busy = true;
    try { return await work(); } finally { busy = false; }
  };
  const only = (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/knowledge')) return undefined;
    const p = opts.principal(req, reply);
    if (!p) return false;
    if (p.role !== 'operator') return reply.code(403).send({ code: 'FORBIDDEN' });
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== (opts.origin ?? `http://${req.headers.host}`)) return reply.code(403).send({ code: 'FORBIDDEN' });
    actors.set(req, p);
    return undefined;
  };
  app.addHook('onRequest', async (req, reply) => {
    const r = only(req, reply);
    if (r === false) return reply; // principal() já respondeu 401
    return r;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.url.startsWith('/api/knowledge')) return payload;
    reply.header('cache-control', 'no-store');
    const p = actors.get(req);
    if (p && !opts.active(p)) { reply.code(401); return JSON.stringify({ code: 'UNAUTHORIZED' }); }
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof KnowledgeError) return reply.code(statuses[error.code]).send({ code: error.code, message: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof z.ZodError || (error as { validation?: unknown }).validation || (status !== undefined && status >= 400 && status < 500)) return reply.code(400).send({ code: 'INVALID' });
    // Sem detalhes: nada de caminho local, SQL ou conteúdo de documento na resposta.
    return reply.code(500).send({ code: 'UNAVAILABLE' });
  });

  app.get('/api/knowledge/procedures', () => ({ procedures: opts.service.technicalProcedures() }));
  app.post('/api/knowledge/procedures/query', { bodyLimit: 16_384 }, req => opts.service.technicalGuidance(req.body));
  const sessionConsent = (req: FastifyRequest, selected: string) => selected === 'ollama' ? true : opts.consented?.(actors.get(req)!, selected) === true;
  app.get('/api/knowledge/status', async (req) => { const s = await opts.service.status(); return { ...s, providers: { ...s.providers, sessionConsent: sessionConsent(req, s.providers.chat.selected) } }; });
  app.get('/api/knowledge/providers', (req) => { const p = opts.service.providers(); return { ...p, sessionConsent: sessionConsent(req, p.chat.selected) }; });
  app.post('/api/knowledge/providers', { bodyLimit: 1024 }, async (req) => {
    const b = providerBody.parse(req.body);
    const p = actors.get(req)!; let revision: number | undefined;
    const current = () => opts.active(p) && revision === opts.consentRevision?.();
    const result = await opts.service.setChatProvider(b.chat, b.confirmExternal === true, b.model, { begin: () => { opts.onProviderSelectionStart?.(); revision = opts.consentRevision?.(); }, current });
    if (!current()) throw new KnowledgeError('UNAUTHORIZED', 'Sessão encerrada ou seleção invalidada.');
    opts.onProviderSelection?.(p, result.chat.selected, b.confirmExternal === true);
    return { ...result, sessionConsent: sessionConsent(req, result.chat.selected) };
  });
  app.delete('/api/knowledge/providers/consent', (req) => { opts.onConsentRevocation?.(actors.get(req)!); return { ...opts.service.providers(), sessionConsent: false }; });
  app.get('/api/knowledge/sources', async () => ({ sources: await opts.service.sources() }));
  app.get('/api/knowledge/documents', async () => ({ documents: await opts.service.documents() }));
  app.get('/api/knowledge/cases', async () => ({ cases: await opts.service.cases() }));
  app.get('/api/knowledge/microphones', () => opts.service.microphones());
  app.post('/api/knowledge/import-seed', { bodyLimit: 1024 }, () => exclusive(() => opts.service.importSeed()));
  app.post('/api/knowledge/ingest', { bodyLimit: 1024 }, req => {
    const p = actors.get(req)!; const revision = opts.consentRevision?.();
    return exclusive(() => opts.service.ingest({ externalAllowed: id => opts.active(p) && revision === opts.consentRevision?.() && opts.consented?.(p, id) === true }));
  });
  app.post('/api/knowledge/search', { bodyLimit: 2048 }, (req) => {
    const p = actors.get(req)!; const revision = opts.consentRevision?.();
    return opts.service.search(searchBody.parse(req.body).query, { externalAllowed: (id) => opts.active(p) && revision === opts.consentRevision?.() && opts.consented?.(p, id) === true });
  });
  app.post('/api/knowledge/microphones', { bodyLimit: 1024 }, async (req) => {
    const b = micBody.parse(req.body);
    return { assignment: await opts.service.assignMicrophone(b.channel, b.modelId) };
  });
  app.delete<{ Params: { id: string } }>('/api/knowledge/documents/:id', async (req) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw new KnowledgeError('INVALID', 'Identificador inválido.');
    await opts.service.deleteDocument(id.data);
    return { ok: true };
  });
}
