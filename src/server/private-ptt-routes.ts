import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from './auth.js';
import { PrivatePtt, PttError, PTT_MAX_BYTES, PTT_MAX_SECONDS, type PttJob } from '../speech/private-ptt.js';
const statuses = { NOT_CONFIGURED: 503, RATE_LIMIT: 429, CAPACITY: 503, BAD_TICKET: 409, BAD_AUDIO: 400, CANCELLED: 409, UNAUTHORIZED: 401, TIMEOUT: 408, STT_FAILED: 503 };
/** Registered only on the opted-in private proxy ingress. Every route inherits these guards. */
export async function privatePttRoutes(app: FastifyInstance, options: {
  service: PrivatePtt; origin: string;
  principal(req: FastifyRequest, reply: FastifyReply): Principal | undefined;
  active(p: Principal): boolean;
  onRevoke(callback: (session: string) => void): () => void;
}) {
  const { service } = options;
  const remove = options.onRevoke(session => service.revoke(session));
  const actors = new WeakMap<FastifyRequest, Principal>();
  const jobs = new WeakMap<FastifyRequest, PttJob>();
  app.addHook('onClose', async () => { remove(); await service.close(); });
  app.addHook('onRequest', async (req, reply) => {
    const p = options.principal(req, reply);
    if (!p) return reply;
    if (p.role !== 'operator' || (req.method !== 'GET' && req.headers.origin !== options.origin)) return reply.code(403).send({ code: 'FORBIDDEN' });
    actors.set(req, p);
  });
  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: PTT_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.setErrorHandler((error, _req, reply) => {
    const code = error instanceof PttError ? error.code : 'BAD_AUDIO';
    return reply.code((error as { statusCode?: number }).statusCode === 413 ? 413 : statuses[code]).send({ code });
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const p = actors.get(req);
    if (p && !options.active(p)) { reply.code(401); return JSON.stringify({ code: 'UNAUTHORIZED' }); }
    return payload;
  });
  app.addHook('onResponse', async (req) => {
    const job = jobs.get(req);
    if (job) { job.abort.abort(new PttError('CANCELLED')); service.finish(job); }
  });
  app.get('/api/speech/status', async () => ({ enabled: true, configured: await service.configured(), maxSeconds: PTT_MAX_SECONDS, maxBytes: PTT_MAX_BYTES, simulated: service.simulated }));
  app.post('/api/speech/ticket', { bodyLimit: 256 }, async req => {
    const p = actors.get(req)!; const ticket = await service.ticket(p.id);
    if (!options.active(p)) { service.revoke(p.id); throw new PttError('UNAUTHORIZED'); }
    return { ticket };
  });
  app.post('/api/speech/cancel', { bodyLimit: 256 }, async req => {
    const ticket = (req.body as { ticket?: unknown } | null)?.ticket;
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) throw new PttError('BAD_TICKET');
    service.cancel(actors.get(req)!.id, ticket);
    return { cancelled: true };
  });
  app.post('/api/speech/transcribe', {
    bodyLimit: PTT_MAX_BYTES,
    onRequest: async (req, reply) => {
      if (req.headers['content-type'] !== 'audio/wav') return reply.code(415).send({ code: 'BAD_AUDIO' });
      const p = actors.get(req)!;
      const job = service.begin(p.id, req.headers['x-ptt-ticket'], () => options.active(p));
      jobs.set(req, job);
      const abort = () => { job.abort.abort(new PttError('CANCELLED')); if (!req.raw.complete) service.finish(job); };
      req.raw.once('aborted', abort);
      reply.raw.once('close', () => { if (!reply.raw.writableFinished) abort(); });
      job.abort.signal.addEventListener('abort', () => { if (!req.raw.complete) req.raw.destroy(); }, { once: true });
    },
  }, async req => {
    const p = actors.get(req)!;
    return service.transcribe(jobs.get(req)!, req.body, () => options.active(p));
  });
}
