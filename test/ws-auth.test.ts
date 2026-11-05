import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { WS_CLOSE } from '../src/server/http.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
const clients: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const t of running.splice(0)) await t.server.close();
});
async function start() {
  const t = await startTestServer();
  running.push(t);
  return t;
}
async function ws(t: T, token: string) {
  const c = await wsClient(t.base, token);
  clients.push(c);
  await c.next((m) => m.type === 'snapshot');
  return c;
}
const agentAsksMaster = (t: T) =>
  t.http('/api/command', {
    token: readFileSync(`${t.dir}/agent-lab.token`, 'utf8'),
    body: { requestId: `ag-${Math.random()}`, targetMode: 'lab', command: { type: 'set_master', deltaDB: -1 } },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WebSocket: autorização em todos os fluxos', () => {
  it('logout com a conexão OCIOSA: cai na hora e para de receber medidores, eventos e pendências', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t, op);
    c.send({ type: 'meters', on: true, hz: 15 });
    await c.next((m) => m.type === 'meters');
    await t.http('/api/logout', { token: op, body: {} }); // o cliente não manda mais nada
    expect((await c.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
    const after = c.inbox.length;
    await agentAsksMaster(t);
    await t.command(await t.login(OPERATOR_PIN), { type: 'set_level', channel: 'voz 1', deltaDB: 1 });
    await sleep(200);
    expect(c.inbox.length).toBe(after);
    expect(c.inbox.some((m) => m.type === 'pending')).toBe(false);
  });

  it('sessão VENCIDA com a conexão ociosa: derrubada sem o cliente mandar nada', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t, op);
    t.clock.advance(13 * 3_600_000); // passou da validade (12 h)
    expect((await c.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('sessão vencida não recebe NENHUMA notificação, mesmo antes da verificação periódica', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t, op);
    t.clock.advance(13 * 3_600_000);
    await agentAsksMaster(t); // gera um cartão de pendência para os operadores
    expect((await c.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
    expect(c.inbox.some((m) => m.type === 'pending')).toBe(false);
  });

  it('músico: medidores do PA/master recusados; nenhum quadro é enviado; não recebe cartões', async () => {
    const t = await start();
    const mus = await t.login(MUSICIAN_PIN);
    const c = await ws(t, mus);
    c.send({ type: 'meters', on: true, hz: 15 });
    const refused = await c.next((m) => m.type === 'meters_unavailable');
    expect(refused.code).toBe('FORBIDDEN');
    await agentAsksMaster(t);
    await sleep(250);
    expect(c.inbox.some((m) => m.type === 'meters')).toBe(false);
    expect(c.inbox.some((m) => m.type === 'pending' || m.type === 'pending_list')).toBe(false);
  });

  it('operador continua recebendo tudo enquanto a sessão vale', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t, op);
    await agentAsksMaster(t);
    expect((await c.next((m) => m.type === 'pending')).card.command.type).toBe('set_master');
  });
});
