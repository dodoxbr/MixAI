import { mixerOperatorRoutes } from '../assistant/mixer-operator/routes.js';
import type { AutoConfigAdvisor } from '../autoconfig/suggestion-source.js';
import type { AutoConfigService } from '../autoconfig/service.js';
import { autoConfigRoutes } from '../autoconfig/routes.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { PrivatePtt } from '../speech/private-ptt.js';
import { privatePttRoutes } from './private-ptt-routes.js';
import type { ReferenceService } from '../reference/service.js';
import { referenceRoutes } from './reference-routes.js';
import type { WebSocket } from 'ws';
import type { Result } from '../core/controller.js';
import type { Principal, RevokeReason } from './auth.js';
import { fail, type CommandResponse, type ServerCore } from './core.js';
import type { AssistantReply } from '../assistant/service.js';
import type { LocalKnowledge } from '../knowledge/local/index.js';
import { knowledgeRoutes } from './knowledge-routes.js';
import { instructorRoutes } from './instructor-routes.js';
import type { ModelCatalogService } from '../ai/model-catalog/service.js';
import { modelCatalogRoutes } from '../ai/model-catalog/routes.js';

/** Texto do corpo de uma conversa (só para consultar a base); qualquer outra forma vira vazio. */
const textOf = (body: unknown): string => (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text.slice(0, 500) : '');

/** Fechamentos do WebSocket com motivo (o cliente decide o que fazer). */
export const WS_CLOSE = {
  /** Sem autenticação, sessão encerrada ou servidor reiniciado: faça login de novo. */
  UNAUTHORIZED: 4401,
  /** Mensagem fora do protocolo. */
  PROTOCOL: 4400,
} as const;

const HTTP_STATUS: Partial<Record<Result['code'], number>> = {
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  MODE_MISMATCH: 409,
  SERVER_CHANGED: 409,
};

const ASSISTANT_STATUS: Record<string, number> = {
  FORBIDDEN: 403, UNAUTHORIZED: 401, INVALID: 400, NOT_CONFIGURED: 503,
  DIAGNOSIS_CONTEXT_STALE: 409, DIAGNOSIS_RATE_LIMIT: 429, DIAGNOSIS_CAPACITY: 503,
};

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** Set only by the entry's root hook; routes cannot opt into local MCP authentication. */
const requestAuthentication = new WeakMap<FastifyRequest, {
  principal: Principal | undefined;
  authenticate(token: unknown): Principal | undefined;
}>();

function unauthorized(core: ServerCore, reply: FastifyReply) {
  return reply.code(401).send({ serverId: core.serverId, result: fail('UNAUTHORIZED', 'Sessão inválida ou servidor reiniciado. Entre de novo com o PIN.') });
}

function principalOf(core: ServerCore, req: FastifyRequest, reply: FastifyReply): Principal | undefined {
  const p = requestAuthentication.get(req)?.principal;
  if (p && core.auth.isActive(p)) return p;
  void unauthorized(core, reply);
  return undefined;
}

function sendCommand(core: ServerCore, reply: FastifyReply, r: CommandResponse) {
  return reply.code(HTTP_STATUS[r.result.code] ?? 200).send({ serverId: core.serverId, ...r });
}

/**
 * Monta o app HTTP + WebSocket sobre o ServerCore. Pode ser chamado mais de uma vez (uma
 * instância por endereço de escuta: 127.0.0.1 e, se configurado, o IP do Wi-Fi), sempre com o
 * MESMO core: um só controlador, um só estado, uma só fila.
 */
export async function buildHttp(core: ServerCore, opts: { modelCatalog?: ModelCatalogService; logger?: boolean; webRoot?: string; labProxyOrigin?: string; privatePtt?: PrivatePtt; references?: ReferenceService; autoConfig?: AutoConfigService; autoConfigAdvisor?: AutoConfigAdvisor; knowledge?: LocalKnowledge } = {}): Promise<FastifyInstance> {
  // forceCloseConnections: ao desligar, encerra TODAS as conexões na hora. Sem isso, conexões
  // abertas pelo navegador sem requisição (pré-conexão) seguram o desligamento por até 60 s.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 512 * 1024, forceCloseConnections: true });
  await app.register(websocket, { options: { maxPayload: 512 * 1024 } });

  const proxy = opts.labProxyOrigin !== undefined;
  if (proxy) {
    if (core.mode !== 'lab') throw new Error('HTTPS LAB exige modo lab.');
    const origin = new URL(opts.labProxyOrigin!);
    app.addHook('onRequest', async (req, reply) => {
      // Não confiar em Forwarded/X-Forwarded-* nem transformar visitantes em MCP local.
      if (req.headers.host !== origin.host || (req.headers.origin !== undefined && req.headers.origin !== origin.origin)) {
        return reply.code(403).send({ result: fail('FORBIDDEN', 'Host ou origem inválida para HTTPS LAB.') });
      }
    });
  }

  // Applies to EVERY route (including future routes and public endpoints with credentials).
  // Never let a handler reinterpret a proxy connection as a local MCP connection.
  app.addHook('onRequest', async (req, reply) => {
    const ip = proxy ? undefined : req.socket.remoteAddress;
    const authenticate = (token: unknown) => core.auth.authenticate(token, ip);
    const principal = authenticate(bearer(req));
    requestAuthentication.set(req, { principal, authenticate });
    if (proxy && req.headers.authorization !== undefined && !principal) {
      return unauthorized(core, reply);
    }
  });

  // Cabeçalhos de segurança da interface: só carrega código e conexões do próprio servidor.
  app.addHook('onSend', async (req, reply, payload) => {
    if (proxy) void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    if (!req.url.startsWith('/api/')) {
      void reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      void reply.header('x-frame-options', 'DENY');
    }
    return payload;
  });

  // Interface web (E3): arquivos estáticos do build Angular, servidos pelo MESMO servidor.
  // A tela não fala com a mesa: só com a API e o WebSocket abaixo.
  if (opts.webRoot && existsSync(join(opts.webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: opts.webRoot,
      prefix: '/',
      index: ['index.html'],
      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) void res.header('cache-control', 'no-cache');
      },
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain; charset=utf-8')
        .send('Interface web não encontrada. Rode "npm run build:web" e reinicie o servidor. A API está em /api/hello.'),
    );
  }

  if (proxy && opts.privatePtt) {
    await app.register(privatePttRoutes, { service: opts.privatePtt, origin: opts.labProxyOrigin!,
      principal: (req: FastifyRequest, reply: FastifyReply) => principalOf(core, req, reply),
      active: (p: Principal) => core.auth.isActive(p),
      onRevoke: (callback: (session: string) => void) => core.auth.onRevoke(id => callback(id)),
    });
  }

  if (opts.autoConfig && (core.mode === 'lab' || core.mode === 'mock') && core.mixer.mode === core.mode) await app.register(autoConfigRoutes, { service: opts.autoConfig, advisor: opts.autoConfigAdvisor, origin: opts.labProxyOrigin, principal: (req: FastifyRequest, reply: FastifyReply) => principalOf(core, req, reply), active: (p: Principal) => core.auth.isActive(p) });

  if (opts.references && core.mode === 'lab' && core.mixer.mode === 'lab') {
    await app.register(referenceRoutes, { service: opts.references, origin: opts.labProxyOrigin,
      principal: (req: FastifyRequest, reply: FastifyReply) => principalOf(core, req, reply),
      active: (p: Principal) => core.auth.isActive(p),
    });
  }

  // Instrutor Ui16 (leitura): só LAB, operador e músico; independe da base de conhecimento.
  if (core.mode === 'lab' && core.mixer.mode === 'lab') {
    await app.register(instructorRoutes, {
      principal: (req: FastifyRequest, reply: FastifyReply) => principalOf(core, req, reply),
      active: (p: Principal) => core.auth.isActive(p),
    });
  }

  if (opts.knowledge) {
    await app.register(knowledgeRoutes, { service: opts.knowledge, consentRevision: () => core.externalConsent.revision, onProviderSelectionStart: () => core.externalConsent.clear(), onConsentRevocation: (p: Principal) => core.externalConsent.revoke(p.id), onProviderSelection: (p: Principal, selected: string, confirmed: boolean) => core.externalConsent.selection(p, selected, confirmed), consented: (p: Principal, selected: string) => core.externalConsent.allowed(p, selected), origin: opts.labProxyOrigin,
      principal: (req: FastifyRequest, reply: FastifyReply) => principalOf(core, req, reply),
      active: (p: Principal) => core.auth.isActive(p),
    });
  }

  if (opts.modelCatalog && core.mode === 'lab' && core.mixer.mode === 'lab') {
    await app.register(modelCatalogRoutes, { service: opts.modelCatalog, origin: opts.labProxyOrigin,
      principal: (req: FastifyRequest, reply: FastifyReply) => principalOf(core, req, reply),
      active: (p: Principal) => core.auth.isActive(p),
    });
  }

  app.get('/api/hello', async () => core.hello());

  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { pin?: unknown };
    const ip = proxy ? 'https-lab-proxy' : req.socket.remoteAddress ?? '?';
    const r = core.auth.login(body.pin, ip);
    if (!r.ok) {
      core.audit(undefined, 'login_failed', r.message, { ip, code: r.code });
      const status = r.code === 'RATE_LIMIT' ? 429 : r.code === 'NOT_CONFIGURED' ? 503 : 401;
      if (r.retryAfterSec) void reply.header('retry-after', String(r.retryAfterSec));
      return reply.code(status).send({ serverId: core.serverId, result: fail(r.code, r.message) });
    }
    return {
      serverId: core.serverId,
      token: r.token,
      role: r.principal.role,
      expiresAt: new Date(r.expiresAt).toISOString(),
    };
  });

  app.post('/api/logout', async (req) => ({ ok: core.auth.logout(bearer(req)) }));

  app.get('/api/state', async (req, reply) => {
    const p = principalOf(core, req, reply);
    if (!p) return reply;
    return { serverId: core.serverId, role: p.role, snapshot: core.snapshotFor(p) };
  });

  app.post('/api/command', async (req, reply) => {
    const p = principalOf(core, req, reply);
    if (!p) return reply;
    return sendCommand(core, reply, await core.execute(p, (req.body ?? {}) as object));
  });

  if (core.assistant) await app.register(mixerOperatorRoutes, { assistant: core.assistant, serverId: core.serverId, origin: opts.labProxyOrigin,
    principal: (req: FastifyRequest, reply: FastifyReply) => principalOf(core, req, reply), active: (p: Principal) => core.auth.isActive(p),
  });

  // Consulta B3A: mesmo servidor e autenticação, sem caminho de comandos.
  app.post('/api/assistant/conversation', async (req, reply) => {
    const p = principalOf(core, req, reply);
    if (!p) return reply;
    const base: AssistantReply = core.assistant?.conversation(p, req.body) ?? { kind: 'error', source: 'local', code: 'NOT_CONFIGURED', text: 'Assistente indisponível.' };
    const answer = core.assistant ? await core.assistant.withKnowledge(p, base, textOf(req.body)) : base;
    const status = ASSISTANT_STATUS[answer.code ?? ''] ?? 200;
    return reply.code(status).send({ serverId: core.serverId, reply: answer });
  });

  app.post('/api/assistant/diagnose', async (req, reply) => {
    const p = principalOf(core, req, reply);
    if (!p) return reply;
    if (!core.assistant) return reply.code(503).send({ serverId: core.serverId, reply: { kind: 'error', source: 'local', code: 'NOT_CONFIGURED', text: 'Assistente indisponível.' } });
    const answer = await core.assistant.withKnowledge(p, core.assistant.diagnose(p, req.body), '');
    return reply.code(ASSISTANT_STATUS[answer.code ?? ''] ?? 200).send({ serverId: core.serverId, reply: answer });
  });

  app.get('/api/pending', async (req, reply) => {
    const p = principalOf(core, req, reply);
    if (!p) return reply;
    const r = core.listPending(p);
    if (!r.ok) return reply.code(403).send({ serverId: core.serverId, result: r.result });
    return { serverId: core.serverId, items: r.items };
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/api/pending/:id/${action}`, async (req, reply) => {
      const p = principalOf(core, req, reply);
      if (!p) return reply;
      const body = (req.body ?? {}) as { requestId?: unknown; serverId?: unknown };
      const r =
        action === 'approve'
          ? await core.approve(p, body.requestId, req.params.id, body.serverId)
          : await core.reject(p, body.requestId, req.params.id, body.serverId);
      return sendCommand(core, reply, r);
    });
  }

  app.get('/ws', { websocket: true }, (socket, req) => wsSession(core, socket, token => requestAuthentication.get(req)?.authenticate(token), p => opts.privatePtt?.cancel(p.id)));

  return app;
}

/**
 * Sessão WebSocket:
 *  1. o cliente manda {type:"auth", token} (o token nunca vai na URL);
 *  2. o servidor responde hello, depois snapshot, e só então passa a mandar eventos — tudo no
 *     mesmo ciclo, então nenhum evento escapa entre o snapshot e a assinatura;
 *  3. eventos levam fromRevision/revision; se o cliente notar um buraco, manda {type:"resync"}.
 */
function wsSession(core: ServerCore, socket: WebSocket, authenticate: (token: unknown) => Principal | undefined, onDisconnect?: (p: Principal) => void) {
  let principal: Principal | undefined;
  const cleanups: Array<() => void> = [];
  let meterTimer: NodeJS.Timeout | undefined;
  let revoked = false;
  /** Arrastes em andamento desta tela (fechados se a conexão cair no meio). */
  const gestures = new Set<string>();
  const raw = (msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  /**
   * Fecha com motivo. UNAUTHORIZED leva também `reason` (para a tela explicar):
   * expired = venceu; logout = saiu; unknown_session = token não reconhecido (servidor
   * reiniciado ou sessão que não existe mais); no_auth = não se autenticou.
   */
  const close = (code: number, message: string, reason?: string) => {
    raw({ type: 'error', serverId: core.serverId, code: code === WS_CLOSE.UNAUTHORIZED ? 'UNAUTHORIZED' : 'PROTOCOL', reason, message });
    socket.close(code, message.slice(0, 120));
  };
  /** Derruba a conexão de uma sessão encerrada/vencida e para TODOS os envios dela. */
  const revoke = (why: RevokeReason = 'expired') => {
    if (revoked) return;
    revoked = true;
    stopAll();
    close(
      WS_CLOSE.UNAUTHORIZED,
      why === 'logout' ? 'Sessão encerrada (Sair). Entre de novo com o PIN.' : 'Sessão vencida. Entre de novo com o PIN.',
      why,
    );
  };
  /** Todo envio depois da autenticação passa por aqui: a sessão é conferida ANTES de enviar. */
  const send = (msg: unknown) => {
    if (revoked) return;
    if (principal && !core.auth.isActive(principal)) return revoke();
    raw(msg);
  };
  const stopAll = () => {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = undefined;
    for (const c of cleanups.splice(0)) c();
  };
  const authTimer = setTimeout(() => close(WS_CLOSE.UNAUTHORIZED, 'Autenticação não recebida.', 'no_auth'), 5000);
  authTimer.unref?.();

  const sendSnapshot = () => send({ type: 'snapshot', serverId: core.serverId, snapshot: core.snapshotFor(principal!) });

  const start = (p: Principal) => {
    principal = p;
    clearTimeout(authTimer);
    // Logout derruba na hora; vencimento é conferido a cada segundo (conexão ociosa também cai).
    cleanups.push(core.auth.onRevoke((id, why) => id === p.id && revoke(why)));
    const watch = setInterval(() => !core.auth.isActive(p) && revoke(), 1000);
    watch.unref?.();
    cleanups.push(() => clearInterval(watch));
    send({ type: 'hello', ...core.hello(), role: p.role });
    sendSnapshot();
    cleanups.push(core.subscribeState((ev) => send({ type: 'event', serverId: core.serverId, event: core.eventFor(p, ev) })));
    cleanups.push(
      core.onNotice((n, audience) => {
        if (audience.roles.includes(p.role) || audience.principalId === p.id) send({ ...n, serverId: core.serverId });
      }),
    );
    if (p.role === 'operator') {
      const list = core.listPending(p);
      if (list.ok) send({ type: 'pending_list', serverId: core.serverId, items: list.items });
    }
  };

  socket.on('message', (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (!msg || typeof msg !== 'object') throw new Error();
    } catch {
      return close(WS_CLOSE.PROTOCOL, 'Mensagem inválida (esperado JSON).');
    }
    if (!principal) {
      if (msg.type !== 'auth') return close(WS_CLOSE.UNAUTHORIZED, 'A primeira mensagem deve ser {type:"auth", token}.', 'no_auth');
      const p = authenticate(msg.token);
      if (!p) return close(WS_CLOSE.UNAUTHORIZED, 'Sessão inválida ou servidor reiniciado. Entre de novo com o PIN.', 'unknown_session');
      return start(p);
    }
    const p = principal;
    if (revoked) return;
    if (!core.auth.isActive(p)) return revoke();
    switch (msg.type) {
      case 'ping':
        return send({ type: 'pong', serverId: core.serverId });
      case 'resync':
        return sendSnapshot();
      case 'command':
        return void core.execute(p, msg).then((r) => send({ type: 'result', serverId: core.serverId, ...r }));
      case 'approve':
      case 'reject': {
        const id = typeof msg.pendingId === 'string' ? msg.pendingId : '';
        const run = msg.type === 'approve' ? core.approve(p, msg.requestId, id, msg.serverId) : core.reject(p, msg.requestId, id, msg.serverId);
        return void run.then((r) => send({ type: 'result', serverId: core.serverId, ...r }));
      }
      case 'fader': {
        const gid = typeof msg.gestureId === 'string' ? msg.gestureId : '';
        if (msg.final === true) gestures.delete(gid);
        else if (gid) gestures.add(gid);
        return void core.fader(p, msg).then((r) => {
          // Juntado a outro valor (coalescência): nada a responder. O estado chega pelos eventos.
          if (!r) return;
          // Responde quando o gesto fecha (soltou ou deu erro). Durante o arraste, só eventos.
          if (r.closed) {
            gestures.delete(gid);
            send({ type: 'fader_result', serverId: core.serverId, gestureId: gid, result: r.result });
          }
        });
      }
      // ---------- assistente (E4): só propostas; aplicar passa pela fila e pela autorização ----------
      case 'assistant': {
        const a = core.assistant;
        if (!a) return send({ type: 'assistant_reply', serverId: core.serverId, requestId: msg.requestId, reply: { kind: 'error', source: 'local', text: 'Assistente indisponível.' } });
        return void a.ask(p, msg.text, msg.context).then((reply) => send({ type: 'assistant_reply', serverId: core.serverId, requestId: msg.requestId, reply }));
      }
      case 'assistant_conversation': {
        const a = core.assistant;
        if (!a) return send({ type: 'assistant_reply', serverId: core.serverId, requestId: msg.requestId, reply: { kind: 'error', source: 'local', text: 'Assistente indisponível.' } });
        return void a.withKnowledge(p, a.conversation(p, msg.input), textOf(msg.input)).then((reply) => send({ type: 'assistant_reply', serverId: core.serverId, requestId: msg.requestId, reply }));
      }
      case 'assistant_diagnose': {
        const a = core.assistant;
        if (!a) return send({ type: 'assistant_reply', serverId: core.serverId, requestId: msg.requestId, reply: { kind: 'error', source: 'local', text: 'Assistente indisponível.' } });
        return void a.withKnowledge(p, a.diagnose(p, msg.input), '').then((reply) => send({ type: 'assistant_reply', serverId: core.serverId, requestId: msg.requestId, reply }));
      }
      case 'proposal_apply': {
        const a = core.assistant;
        if (!a) return;
        return void a.apply(p, msg.proposalId, msg.requestId).then((r) => send({ type: 'proposal_result', serverId: core.serverId, requestId: msg.requestId, proposalId: msg.proposalId, ...r }));
      }
      case 'proposal_cancel':
        core.assistant?.cancel(p, msg.proposalId);
        return;
      case 'assistant_feedback': {
        const a = core.assistant;
        if (!a) return;
        const reply = a.feedback(p, msg.proposalId, msg.better);
        return send({ type: 'assistant_reply', serverId: core.serverId, requestId: msg.requestId, reply });
      }
      case 'meters': {
        if (meterTimer) clearInterval(meterTimer);
        meterTimer = undefined;
        if (msg.on !== true) return;
        if (p.role === 'musician') {
          // Os medidores existentes são do PA/master: o músico só pode ver o AUX 1, e a medição
          // específica do AUX 1 ainda não existe. Recusado até existir.
          return send({
            type: 'meters_unavailable',
            serverId: core.serverId,
            code: 'FORBIDDEN',
            message: 'Medidores do PA/master não são liberados para músicos; a medição do AUX 1 (fones) ainda não existe.',
          });
        }
        const source = core.meters;
        if (!source || core.mode === 'real') {
          return send({
            type: 'meters_unavailable',
            serverId: core.serverId,
            message: 'Medidores da mesa real ainda não existem (ficam para a E6).',
          });
        }
        const hz = Math.max(1, Math.min(15, Number(msg.hz) || 10));
        meterTimer = setInterval(() => {
          const frame = source.frame();
          if (frame) send({ ...frame, serverId: core.serverId });
        }, 1000 / hz);
        meterTimer.unref?.();
        return;
      }
      default:
        return send({ type: 'error', serverId: core.serverId, code: 'INVALID', message: `Tipo de mensagem desconhecido: ${String(msg.type)}` });
    }
  });

  socket.on('close', () => {
    if (principal) onDisconnect?.(principal);
    clearTimeout(authTimer);
    stopAll();
    if (principal && gestures.size) void core.endFaders(principal, [...gestures]);
  });
}
