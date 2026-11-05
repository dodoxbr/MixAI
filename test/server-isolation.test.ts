import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Conta controladores criados e registra se a mesa real/biblioteca foi carregada.
const probe = vi.hoisted(() => ({ controllers: 0, real: 0, lib: 0 }));
vi.mock('../src/core/controller.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/core/controller.js')>();
  class Counted extends m.MixController {
    constructor(...args: ConstructorParameters<typeof m.MixController>) {
      super(...args);
      probe.controllers++;
    }
  }
  return { ...m, MixController: Counted };
});
vi.mock('../src/mixer/real.js', async (importOriginal) => {
  probe.real++;
  return importOriginal();
});
vi.mock('soundcraft-ui-connection', async (importOriginal) => {
  probe.lib++;
  return importOriginal();
});

const { RemoteBackend } = await import('../src/mcp/remote.js');
const { createMcpServer } = await import('../src/mcp/server.js');
const { OwnerLock, OwnerLockError } = await import('../src/core/owner-lock.js');
const { listenHosts } = await import('../src/server/listen.js');
const { parseConfig } = await import('../src/core/config.js');
const { Auth } = await import('../src/server/auth.js');
const { hashPin } = await import('../src/server/pin.js');
const { paramKey } = await import('../src/core/revisions.js');
const { MASTER } = await import('../src/mixer/types.js');
const { WS_CLOSE } = await import('../src/server/http.js');
const { OPERATOR_PIN, startTestServer, wsClient, isEvent } = await import('./server-support.js');

type T = Awaited<ReturnType<typeof startTestServer>>;
const servers: T[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.server.close();
});
async function start(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer(opts);
  servers.push(t);
  return t;
}

async function mcpFor(t: T, mode: 'lab' | 'real' | 'mock' = 'lab') {
  const backend = new RemoteBackend({
    baseUrl: t.base,
    mode,
    tokenFile: join(t.dir, `agent-${t.loaded.config.mixer.mode}.token`),
  });
  const server = createMcpServer(backend);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '1.0.0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
  };
}

describe('um só dono: clientes compartilham o mesmo controlador', () => {
  it('MCP + dois navegadores: mudanças de qualquer um aparecem nos outros, com UM controlador', async () => {
    const before = probe.controllers;
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const a = await wsClient(t.base, op);
    const b = await wsClient(t.base, op);
    await Promise.all([a.next((m) => m.type === 'snapshot'), b.next((m) => m.type === 'snapshot')]);
    const call = await mcpFor(t);

    const r = await call('set_channel_level', { channel: 'voz 1', delta_db: 3 });
    expect(r.text).toContain('[OK]');
    const [ea, eb] = await Promise.all([a.next(isEvent), b.next(isEvent)]);
    expect(ea.event).toEqual(eb.event);
    expect(ea.event.changes[0].key).toBe(paramKey.level(1, MASTER));

    await a.request({ type: 'command', command: { type: 'set_mute', channels: ['surdo'], muted: true } });
    await b.next(isEvent);
    const state = await call('get_mix_state');
    expect(state.text).toContain('"muted": true');

    // Assistente pede o master → operador aprova pela tela → o assistente vê no histórico.
    const ask = await call('set_master_level', { delta_db: -1 });
    expect(ask.text).toContain('[NEEDS_CONFIRMATION]');
    const id = /"pendingId": "([0-9a-f]+)"/.exec(ask.text)![1]!;
    const self = await call('set_master_level', { delta_db: -1, confirmation_id: id });
    expect(self.text).toContain('[FORBIDDEN]');
    const ok = await a.request({ type: 'approve', pendingId: id });
    expect(ok.result.code).toBe('OK');
    expect((await call('get_action_log', { limit: 5 })).text).toContain('Master');

    expect(probe.controllers - before).toBe(1);
    expect(a.sync.state).toEqual(t.controller.state.snapshot());
    expect(b.sync.state).toEqual(t.controller.state.snapshot());
    a.close();
    b.close();
  });

  it('segundo servidor (ou console) no mesmo laboratório é recusado pela trava de dono', async () => {
    const t = await start();
    await expect(startTestServer({ dir: t.dir })).rejects.toBeInstanceOf(OwnerLockError);
    expect(() => new OwnerLock(`${t.loaded.labFile}.lock`, 'console').acquire()).toThrow(OwnerLockError);
  });

  it('trava abandonada (dono morto) é reaproveitada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-lock-'));
    const file = join(dir, 'owner-real.lock');
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, role: 'servidor', since: 'ontem' }));
    const lock = new OwnerLock(file, 'servidor').acquire();
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(file)).toBe(false);
  });
});

describe('modo fixo: LAB nunca vira REAL', () => {
  it('LAB recusa comando direcionado ao modo REAL (HTTP e MCP configurado como real); a mesa real nem é carregada', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const r = await t.command(op, { type: 'set_level', channel: 'voz 1', deltaDB: 2 }, { targetMode: 'real' });
    expect(r.status).toBe(409);
    expect(r.json.result.code).toBe('MODE_MISMATCH');
    const call = await mcpFor(t, 'real');
    const m = await call('set_channel_level', { channel: 'voz 1', delta_db: 2 });
    expect(m.text).toContain('[MODE_MISMATCH]');
    expect(t.mixer.read(paramKey.level(1, MASTER))).toEqual({ known: true, value: -10 });
    expect(probe.real).toBe(0);
    expect(probe.lib).toBe(0);
  });
});

describe('reinício do servidor', () => {
  it('invalida sessões e o estado de sincronização antigos', async () => {
    const t1 = await startTestServer();
    const op = await t1.login(OPERATOR_PIN);
    const c = await wsClient(t1.base, op);
    await c.next((m) => m.type === 'snapshot');
    const oldId = t1.server.core.serverId;
    const port = t1.server.port;
    await t1.server.close();
    await c.closed; // o servidor antigo derrubou a conexão

    const t2 = await start({ dir: t1.dir, port });
    expect(t2.server.core.serverId).not.toBe(oldId);
    // sessão antiga não vale mais
    expect((await t2.http('/api/state', { token: op })).status).toBe(401);
    const stale = await wsClient(t2.base, op, { sync: false });
    expect((await stale.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
    // o cliente que guardava o estado do servidor antigo descarta tudo ao ver o novo serverId
    const op2 = await t2.login(OPERATOR_PIN);
    const fresh = await wsClient(t2.base, op2);
    await fresh.next((m) => m.type === 'snapshot');
    c.sync.handle({ type: 'hello', serverId: t2.server.core.serverId });
    expect(c.sync.state).toBeUndefined();
    expect(c.sync.restarts).toBe(1);
    // e um evento do servidor novo, sem snapshot, pede ressincronização em vez de ser aplicado
    expect(c.sync.handle({ type: 'event', serverId: t2.server.core.serverId, event: { type: 'params', fromRevision: 0, revision: 1, changes: [] } })).toBe('resync');
    // o assistente relê o token novo sozinho
    const call = await mcpFor(t2);
    expect((await call('mixer_status')).text).toContain('[OK]');
    fresh.close();
  });
});

describe('rede do Yoga: endereço de escuta explícito', () => {
  const cfg = (lan: { enabled: boolean; host: string }, ip = '10.10.1.1') => parseConfig({ mixer: { ip }, server: { lan } });
  it('padrão: só 127.0.0.1; portas 8790 (LAB) e 8791 (REAL)', async () => {
    expect(listenHosts(cfg({ enabled: false, host: '' }))).toEqual(['127.0.0.1']);
    const { serverPort } = await import('../src/core/config.js');
    expect(serverPort(parseConfig({ mixer: { mode: 'lab' } }))).toBe(8790);
    expect(serverPort(parseConfig({ mixer: { mode: 'real' } }))).toBe(8791);
  });
  it('rede local só quando configurada, com IP privado específico e diferente do IP da mesa', () => {
    expect(listenHosts(cfg({ enabled: true, host: '192.168.0.20' }))).toEqual(['127.0.0.1', '192.168.0.20']);
    expect(() => listenHosts(cfg({ enabled: true, host: '0.0.0.0' }))).toThrow(/todas as interfaces/);
    expect(() => listenHosts(cfg({ enabled: true, host: '8.8.8.8' }))).toThrow(/internet/);
    expect(() => listenHosts(cfg({ enabled: true, host: '10.10.1.1' }))).toThrow(/IP da MESA/);
    expect(() => listenHosts(cfg({ enabled: true, host: '' }))).toThrow(/Wi-Fi/);
  });
});

describe('segredos', () => {
  it('token do assistente só vale vindo da própria máquina', () => {
    const auth = new Auth({ agentToken: 'segredo-local' });
    expect(auth.authenticate('segredo-local', '127.0.0.1')?.role).toBe('agent');
    expect(auth.authenticate('segredo-local', '192.168.0.33')).toBeUndefined();
  });

  it('PIN e token nunca aparecem em log nem em arquivo de configuração', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'mixai-logs-'));
    const t = await start({ logDir });
    await t.http('/api/login', { body: { pin: '9999' } }); // errado
    const op = await t.login(OPERATOR_PIN);
    await t.command(op, { type: 'set_level', channel: 'voz 1', deltaDB: 1 });
    await t.command(await t.login('1357'), { type: 'set_master', deltaDB: -1 }); // recusado (músico)
    const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('\n');
    expect(logs).toContain('server_forbidden');
    expect(logs).toContain('server_login_failed');
    for (const secret of [OPERATOR_PIN, '9999', op, readFileSync(join(t.dir, 'agent-lab.token'), 'utf8')]) {
      expect(logs).not.toContain(secret);
    }
    const h = hashPin('2468');
    expect(h).not.toContain('2468');
    expect(h.startsWith('scrypt$')).toBe(true);
  });
});
