import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Result } from '../core/controller.js';
import type { Principal } from './auth.js';
import { fail, type CommandResponse, type ServerCore } from './core.js';

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

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

function principalOf(core: ServerCore, req: FastifyRequest, reply: FastifyReply): Principal | undefined {
  const p = core.auth.authenticate(bearer(req), req.socket.remoteAddress);
  if (!p) {
    void reply.code(401).send({ serverId: core.serverId, result: fail('UNAUTHORIZED', 'Sessão inválida ou servidor reiniciado. Entre de novo com o PIN.') });
  }
  return p;
}

function sendCommand(core: ServerCore, reply: FastifyReply, r: CommandResponse) {
  return reply.code(HTTP_STATUS[r.result.code] ?? 200).send({ serverId: core.serverId, ...r });
}

/**
 * Monta o app HTTP + WebSocket sobre o ServerCore. Pode ser chamado mais de uma vez (uma
 * instância por endereço de escuta: 127.0.0.1 e, se configurado, o IP do Wi-Fi), sempre com o
 * MESMO core: um só controlador, um só estado, uma só fila.
 */
export async function buildHttp(core: ServerCore, opts: { logger?: boolean; webRoot?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Cabeçalhos de segurança da interface: só carrega código e conexões do próprio servidor.
  app.addHook('onSend', async (req, reply, payload) => {
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

  app.get('/api/hello', async () => core.hello());

  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { pin?: unknown };
    const ip = req.socket.remoteAddress ?? '?';
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
    return { serverId: core.serverId, role: p.role, snapshot: core.snapshotFor(p.role) };
  });

  app.post('/api/command', async (req, reply) => {
    const p = principalOf(core, req, reply);
    if (!p) return reply;
    return sendCommand(core, reply, await core.execute(p, (req.body ?? {}) as object));
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

  app.get('/ws', { websocket: true }, (socket, req) => wsSession(core, socket, req.socket.remoteAddress));

  return app;
}

/**
 * Sessão WebSocket:
 *  1. o cliente manda {type:"auth", token} (o token nunca vai na URL);
 *  2. o servidor responde hello, depois snapshot, e só então passa a mandar eventos — tudo no
 *     mesmo ciclo, então nenhum evento escapa entre o snapshot e a assinatura;
 *  3. eventos levam fromRevision/revision; se o cliente notar um buraco, manda {type:"resync"}.
 */
function wsSession(core: ServerCore, socket: WebSocket, ip: string | undefined) {
  let principal: Principal | undefined;
  const cleanups: Array<() => void> = [];
  let meterTimer: NodeJS.Timeout | undefined;
  let revoked = false;
  /** Arrastes em andamento desta tela (fechados se a conexão cair no meio). */
  const gestures = new Set<string>();
  const raw = (msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const close = (code: number, reason: string) => {
    raw({ type: 'error', code: code === WS_CLOSE.UNAUTHORIZED ? 'UNAUTHORIZED' : 'PROTOCOL', message: reason });
    socket.close(code, reason);
  };
  /** Derruba a conexão de uma sessão encerrada/vencida e para TODOS os envios dela. */
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    stopAll();
    close(WS_CLOSE.UNAUTHORIZED, 'Sessão encerrada ou vencida. Entre de novo com o PIN.');
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
  const authTimer = setTimeout(() => close(WS_CLOSE.UNAUTHORIZED, 'Autenticação não recebida.'), 5000);
  authTimer.unref?.();

  const sendSnapshot = () => send({ type: 'snapshot', serverId: core.serverId, snapshot: core.snapshotFor(principal!.role) });

  const start = (p: Principal) => {
    principal = p;
    clearTimeout(authTimer);
    // Logout derruba na hora; vencimento é conferido a cada segundo (conexão ociosa também cai).
    cleanups.push(core.auth.onRevoke((id) => id === p.id && revoke()));
    const watch = setInterval(() => !core.auth.isActive(p) && revoke(), 1000);
    watch.unref?.();
    cleanups.push(() => clearInterval(watch));
    send({ type: 'hello', ...core.hello(), role: p.role });
    sendSnapshot();
    cleanups.push(core.subscribeState((ev) => send({ type: 'event', serverId: core.serverId, event: core.eventFor(p.role, ev) })));
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
      if (msg.type !== 'auth') return close(WS_CLOSE.UNAUTHORIZED, 'A primeira mensagem deve ser {type:"auth", token}.');
      const p = core.auth.authenticate(msg.token, ip);
      if (!p) return close(WS_CLOSE.UNAUTHORIZED, 'Sessão inválida ou servidor reiniciado. Entre de novo com o PIN.');
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
    clearTimeout(authTimer);
    stopAll();
    if (principal && gestures.size) void core.endFaders(principal, [...gestures]);
  });
}
