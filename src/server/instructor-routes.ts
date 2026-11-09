import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { publishedInstructorLibrary } from '../assistant/sound-engineer.js';
import type { Principal } from './auth.js';

/**
 * Biblioteca de procedimentos do Instrutor Ui16 (somente leitura).
 *
 * Diferente de /api/knowledge/*, que é administração EXCLUSIVA do operador, esta rota entrega apenas texto de
 * estudo já publicado (`instructorProcedures`) a operador E músico autenticados. Não consulta banco, provedor de
 * IA, mesa, controlador nem fila: o conteúdo é estático, validado pelo esquema estrito e entregue sem campo extra.
 * Só GET; nenhum método de escrita é registrado. Músico não ganha acesso a nenhuma rota administrativa.
 */
export async function instructorRoutes(app: FastifyInstance, opts: {
  principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
  active(p: Principal): boolean;
}) {
  const actors = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req, reply) => {
    const p = opts.principal(req, reply);
    if (!p) return reply;
    // Agente MCP e qualquer outro papel: sem acesso.
    if (p.role !== 'operator' && p.role !== 'musician') return reply.code(403).send({ code: 'FORBIDDEN' });
    actors.set(req, p);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    const p = actors.get(req);
    // Sessão revogada durante a resposta: nada de conteúdo.
    if (p && !opts.active(p)) { reply.code(401); return JSON.stringify({ code: 'UNAUTHORIZED' }); }
    return payload;
  });
  app.get('/api/instructor/procedures', async () => publishedInstructorLibrary());
}
