import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSnapshot, serializeSnapshot } from '../src/core/state.js';
import { paramKey } from '../src/core/revisions.js';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { WS_CLOSE } from '../src/server/http.js';
import { isEvent, MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

type T = Awaited<ReturnType<typeof startTestServer>>;
const servers: T[] = [];
const clients: Array<{ close: () => void }> = [];
async function start(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer(opts);
  servers.push(t);
  return t;
}
async function ws(base: string, token: string | undefined, opts?: { sync?: boolean }) {
  const c = await wsClient(base, token, opts);
  clients.push(c);
  return c;
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.server.close();
});

const VOZ1 = paramKey.level(1, MASTER);
const VOZ1_FONES = paramKey.level(1, auxBus(1));
const MASTER_KEY = paramKey.master();
/** Valor numérico atual de um parâmetro (os padrões do laboratório não são todos -10). */
const num = (t: { mixer: { read: (k: never) => { known: boolean; value?: unknown } } }, key: string) =>
  t.mixer.read(key as never).value as number;
/** O teste lê o token do assistente como o MCP faria (arquivo local gravado pelo servidor). */
const agentToken = (t: T) => readFileSync(`${t.dir}/agent-${t.loaded.config.mixer.mode}.token`, 'utf8');

describe('servidor único: estado e eventos', () => {
  it('cliente novo recebe hello e snapshot consistente ANTES de qualquer evento; -∞/unknown/unavailable distintos', async () => {
    const t = await start();
    await t.controller.setLevel({ channel: 'voz 2', db: -100 }).then((r) => (r.pendingId ? t.controller.setLevel({ channel: 'voz 2', db: -100, confirmationId: r.pendingId }) : r));
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    const hello = await c.next((m) => m.type === 'hello');
    expect(hello).toMatchObject({ mode: 'lab', role: 'operator', serverId: t.server.core.serverId, protocol: 1 });
    const snap = await c.next((m) => m.type === 'snapshot');
    expect(c.inbox.filter(isEvent)).toEqual([]); // nada de evento antes do snapshot
    expect(snap.snapshot.params['ch.2.main.level'].value).toEqual({ status: 'known', value: '-inf' });
    expect(JSON.stringify(snap)).not.toContain('"value":null');
    expect(c.sync.state!.params['ch.2.main.level']!.value).toEqual({ status: 'known', value: -Infinity });
    expect(c.sync.state).toEqual(parseSnapshot(serializeSnapshot(t.controller.state.snapshot())));
  });

  it('dois clientes WebSocket recebem a MESMA alteração (feita por HTTP)', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const a = await ws(t.base, op);
    const b = await ws(t.base, op);
    await Promise.all([a.next((m) => m.type === 'snapshot'), b.next((m) => m.type === 'snapshot')]);
    const r = await t.command(op, { type: 'set_level', channel: 'voz 1', deltaDB: 2 });
    expect(r.json.result.code).toBe('OK');
    const [ea, eb] = await Promise.all([a.next(isEvent), b.next(isEvent)]);
    expect(ea.event).toEqual(eb.event);
    expect(ea.event.changes[0]).toMatchObject({ key: VOZ1, value: { status: 'known', value: -8 }, actor: 'mixai' });
    const fresh = t.controller.state.snapshot();
    expect(a.sync.state).toEqual(fresh);
    expect(b.sync.state).toEqual(fresh);
  });

  it('cliente que reconecta recupera o estado (snapshot novo, mesmas revisões)', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const a = await ws(t.base, op);
    await a.next((m) => m.type === 'snapshot');
    a.close();
    await a.closed;
    await t.command(op, { type: 'set_level', channel: 'voz 3', deltaDB: -4 }); // enquanto estava fora
    await t.command(op, { type: 'set_mute', channels: ['surdo'], muted: true });
    const again = await ws(t.base, op);
    await again.next((m) => m.type === 'snapshot');
    expect(again.sync.state).toEqual(t.controller.state.snapshot());
    expect(again.sync.state!.params['ch.6.main.mute']!.value).toEqual({ status: 'known', value: true });
  });

  it('evento perdido provoca ressincronização e o cliente volta a bater com o servidor', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    await c.next((m) => m.type === 'snapshot');
    c.dropNext(isEvent); // a rede "perde" o próximo evento
    await t.command(op, { type: 'set_level', channel: 'voz 1', deltaDB: 1 });
    await t.command(op, { type: 'set_level', channel: 'voz 2', deltaDB: 1 });
    await c.next((m) => m.type === 'snapshot'); // pedido automaticamente ao ver o buraco
    expect(c.sync.resyncRequests).toBe(1);
    expect(c.sync.state).toEqual(t.controller.state.snapshot());
    await t.command(op, { type: 'set_level', channel: 'voz 3', deltaDB: 1 });
    await c.next(isEvent);
    expect(c.sync.state).toEqual(t.controller.state.snapshot());
  });

  it('estado da ligação é propagado (indisponível → unavailable; volta → ressincroniza)', async () => {
    const t = await start({ mode: 'mock' });
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    await c.next((m) => m.type === 'snapshot');
    (t.mixer as import('../src/mixer/mock.js').MockMixer).simulateDrop();
    const down = await c.next((m) => isEvent(m) && m.event.type === 'link');
    expect(down.event).toMatchObject({ link: 'LOST', available: false });
    expect(c.sync.state!.params[VOZ1]!.value).toEqual({ status: 'unavailable' });
    const blocked = await t.command(op, { type: 'set_level', channel: 'voz 1', deltaDB: 1 });
    expect(blocked.json.result.code).toBe('NO_CONNECTION');
    (t.mixer as import('../src/mixer/mock.js').MockMixer).simulateResync();
    await c.next((m) => m.type === 'snapshot'); // leitura voltou: snapshot novo
    expect(c.sync.state).toEqual(t.controller.state.snapshot());
  });
});

describe('requestId: proteção contra execução duplicada', () => {
  it('mesmo requestId (em sequência ou ao mesmo tempo) executa uma vez só', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const body = { requestId: 'dup-1', command: { type: 'set_level', channel: 'voz 1', deltaDB: 2 } };
    const [r1, r2] = await Promise.all([t.http('/api/command', { token: op, body }), t.http('/api/command', { token: op, body })]);
    const r3 = await t.http('/api/command', { token: op, body });
    expect(t.mixer.read(VOZ1)).toEqual({ known: true, value: -8 }); // -10 + 2, uma vez
    expect([r1.json.duplicate, r2.json.duplicate].sort()).toEqual([false, true]);
    expect(r3.json.duplicate).toBe(true);
    expect(r3.json.result).toEqual(r1.json.result);
    // pelo WebSocket também
    const c = await ws(t.base, op);
    const w1 = await c.request({ type: 'command', requestId: 'dup-ws', command: { type: 'set_level', channel: 'voz 1', deltaDB: 1 } });
    const w2 = await c.request({ type: 'command', requestId: 'dup-ws', command: { type: 'set_level', channel: 'voz 1', deltaDB: 1 } });
    expect([w1.duplicate, w2.duplicate]).toEqual([false, true]);
    expect(t.mixer.read(VOZ1)).toEqual({ known: true, value: -7 });
  });

  it('sem requestId o comando é recusado', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const r = await t.http('/api/command', { token: op, body: { command: { type: 'status' } } });
    expect(r.json.result.code).toBe('INVALID');
  });
});

describe('perfis: autorização verificada no servidor', () => {
  it('músico tentando alterar master ou PA: recusado (nada muda)', async () => {
    const t = await start();
    const mus = await t.login(MUSICIAN_PIN, t.controller.names.inputs.configured());
    const masterBefore = num(t, MASTER_KEY);
    for (const cmd of [
      { type: 'set_master', deltaDB: -1 },
      { type: 'set_level', channel: 'voz 1', deltaDB: 2 },
      { type: 'set_level', channel: 'voz 1', aux: 'cavaco', deltaDB: 2 }, // outro AUX
      { type: 'set_mute', channels: ['surdo'], muted: true },
      { type: 'load_snapshot', show: 'Laboratório', snapshot: 'Bar' },
      { type: 'undo' },
      { type: 'reset_lab' },
      { type: 'history' },
      { type: 'mix_state', aux: 'cavaco' },
    ]) {
      const r = await t.command(mus, cmd);
      expect(r.status, JSON.stringify(cmd)).toBe(403);
      expect(r.json.result.code).toBe('FORBIDDEN');
    }
    expect(num(t, VOZ1)).toBe(-10);
    expect(num(t, MASTER_KEY)).toBe(masterBefore);
  });

  it('músico alterando o AUX 1 (fones): permitido; vê só o AUX 1 no estado', async () => {
    const t = await start();
    const mus = await t.login(MUSICIAN_PIN, t.controller.names.inputs.configured());
    const before = num(t, paramKey.level(2, auxBus(1)));
    const r = await t.command(mus, { type: 'set_level', channel: 'voz 2', aux: 1, deltaDB: 2 });
    expect(r.json.result.code).toBe('OK');
    expect(num(t, paramKey.level(2, auxBus(1)))).toBe(before + 2);
    const m = await t.command(mus, { type: 'set_mute', channels: ['surdo'], aux: 'aux 1', muted: true });
    expect(m.json.result.code).toBe('OK');
    const state = await t.command(mus, { type: 'mix_state' }); // vai direto para o AUX 1
    expect(state.json.result.ok).toBe(true);
    const snap = await t.http('/api/state', { token: mus });
    const keys = Object.keys(snap.json.snapshot.params);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => /^ch\.\d+\.aux\.1\.(level|mute)$/.test(k))).toBe(true);
    // eventos do PA não vazam valores para o músico, mas a sequência continua íntegra
    const c = await ws(t.base, mus);
    await c.next((x) => x.type === 'snapshot');
    const op = await t.login(OPERATOR_PIN);
    await t.command(op, { type: 'set_level', channel: 'voz 1', deltaDB: 1 });
    await t.command(op, { type: 'set_level', channel: 'voz 1', aux: 1, deltaDB: 1 });
    const e1 = await c.next(isEvent);
    const e2 = await c.next(isEvent);
    expect(e1.event.changes).toEqual([]);
    expect(e2.event.changes.map((x: { key: string }) => x.key)).toEqual([VOZ1_FONES]);
    expect(c.sync.resyncRequests).toBe(0);
  });

  it('sem token ou com token inválido: 401; WebSocket sem auth é fechado', async () => {
    const t = await start();
    expect((await t.http('/api/state')).status).toBe(401);
    expect((await t.http('/api/command', { token: 'xyz', body: { requestId: 'a', command: { type: 'status' } } })).status).toBe(401);
    const c = await ws(t.base, 'invalido', { sync: false });
    expect((await c.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });
});

describe('confirmação humana', () => {
  /** Master inicial do laboratório. */
  const LAB_MASTER = -6;
  async function agentAsksMaster(t: T) {
    const r = await t.http('/api/command', {
      token: agentToken(t),
      body: { requestId: 'ag-1', targetMode: 'lab', command: { type: 'set_master', deltaDB: -2 } },
    });
    expect(r.json.result.code).toBe('NEEDS_CONFIRMATION');
    expect(r.json.result.message).toContain('aprovação de um operador');
    expect(r.json.result.message).not.toContain('confirmation_id');
    return r.json.result.pendingId as string;
  }

  it('assistente não confirma a própria operação crítica (nem com o pendingId, nem pelo canal de aprovação)', async () => {
    const t = await start();
    const id = await agentAsksMaster(t);
    const viaCommand = await t.http('/api/command', {
      token: agentToken(t),
      body: { requestId: 'ag-2', targetMode: 'lab', command: { type: 'set_master', deltaDB: -2, confirmationId: id } },
    });
    expect(viaCommand.json.result.code).toBe('FORBIDDEN');
    const viaApprove = await t.http(`/api/pending/${id}/approve`, { token: agentToken(t), body: { requestId: 'ag-3' } });
    expect(viaApprove.status).toBe(403);
    expect(viaApprove.json.result.code).toBe('FORBIDDEN');
    const mus = await t.login(MUSICIAN_PIN, t.controller.names.inputs.configured());
    expect((await t.http(`/api/pending/${id}/approve`, { token: mus, body: { requestId: 'm-1' } })).json.result.code).toBe('FORBIDDEN');
    expect(num(t, MASTER_KEY)).toBe(LAB_MASTER);
    expect(t.controller.isPendingOpen(id)).toBe(true); // as tentativas não consumiram a pendência
  });

  it('operador autenticado vê o cartão e confirma: aplicado uma vez; o assistente é avisado pelo histórico', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    await c.next((m) => m.type === 'pending_list');
    const id = await agentAsksMaster(t);
    const card = await c.next((m) => m.type === 'pending');
    expect(card.card).toMatchObject({ pendingId: id, status: 'open', requestedBy: { role: 'agent' }, command: { type: 'set_master', deltaDB: -2 } });
    expect(card.card.summary).toContain('MASTER');
    const listed = await t.http('/api/pending', { token: op });
    expect(listed.json.items.map((x: { pendingId: string }) => x.pendingId)).toEqual([id]);

    const res = await c.request({ type: 'approve', pendingId: id });
    expect(res.result.code).toBe('OK');
    expect(num(t, MASTER_KEY)).toBe(LAB_MASTER - 2);
    const resolved = await c.next((m) => m.type === 'pending_resolved');
    expect(resolved).toMatchObject({ pendingId: id, status: 'approved', by: 'operador' });
    const again = await t.http(`/api/pending/${id}/approve`, { token: op, body: { requestId: 'op-2' } });
    expect(again.json.result.code).toBe('CONFIRMATION_USED'); // reutilizada
    expect(num(t, MASTER_KEY)).toBe(LAB_MASTER - 2);
    expect((await t.http('/api/pending', { token: op })).json.items).toEqual([]);
  });

  it('operador recusa: nada muda e a pendência não serve mais', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const id = await agentAsksMaster(t);
    expect((await t.http(`/api/pending/${id}/reject`, { token: op, body: { requestId: 'r-1' } })).json.result.ok).toBe(true);
    expect((await t.http(`/api/pending/${id}/approve`, { token: op, body: { requestId: 'r-2' } })).json.result.code).toBe('CONFIRMATION_USED');
    expect(num(t, MASTER_KEY)).toBe(LAB_MASTER);
  });

  it('confirmação expirada ou de pendência inexistente: recusada', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    const expired = await agentAsksMaster(t);
    t.clock.advance(61_000);
    const r1 = await t.http(`/api/pending/${expired}/approve`, { token: op, body: { requestId: 'e-1' } });
    expect(r1.json.result.code).toBe('CONFIRMATION_EXPIRED');
    expect(await c.next((m) => m.type === 'pending_resolved' && m.pendingId === expired)).toMatchObject({ status: 'expired' });
    expect(num(t, MASTER_KEY)).toBe(LAB_MASTER);
    expect((await t.http('/api/pending/naoexiste/approve', { token: op, body: { requestId: 'e-3' } })).json.result.code).toBe('NOT_FOUND');
  });

  it('pendência obsoleta: mudança no parâmetro depois do pedido invalida a aprovação', async () => {
    const t = await start({ mode: 'mock' });
    const op = await t.login(OPERATOR_PIN);
    const token = agentToken(t);
    const ask = await t.http('/api/command', { token, body: { requestId: 's-1', targetMode: 'mock', command: { type: 'set_master', deltaDB: -2 } } });
    const id = ask.json.result.pendingId as string;
    (t.mixer as import('../src/mixer/mock.js').MockMixer).simulateExternalChange(paramKey.master(), -15);
    const res = await t.http(`/api/pending/${id}/approve`, { token: op, body: { requestId: 's-2' } });
    expect(res.json.result.code).toBe('CONFIRMATION_STALE');
    expect(t.mixer.read(paramKey.master())).toEqual({ known: true, value: -15 });
  });

  it('reset do laboratório invalida TODAS as pendências (também as de parâmetros que não mudaram)', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    const id = await agentAsksMaster(t); // o master está no valor inicial: o reset não o muda
    const reset = await t.command(op, { type: 'reset_lab' });
    expect(reset.json.result.code).toBe('OK');
    t.server.core.sweep();
    expect(await c.next((m) => m.type === 'pending_resolved' && m.pendingId === id)).toMatchObject({ status: 'invalidated' });
    const res = await t.http(`/api/pending/${id}/approve`, { token: op, body: { requestId: 'z-1' } });
    expect(res.json.result.code).toBe('CONFIRMATION_STALE');
    expect(num(t, MASTER_KEY)).toBe(LAB_MASTER);
  });
});

describe('autenticação por PIN', () => {
  it('PIN errado repetido bloqueia o aparelho; o PIN certo depois do bloqueio também espera', async () => {
    const t = await start();
    for (let i = 0; i < 5; i++) expect((await t.http('/api/login', { body: { pin: '0000' } })).status).toBe(401);
    const blocked = await t.http('/api/login', { body: { pin: OPERATOR_PIN } });
    expect(blocked.status).toBe(429);
    expect(blocked.json.result.code).toBe('RATE_LIMIT');
    t.clock.advance(31_000);
    expect((await t.http('/api/login', { body: { pin: OPERATOR_PIN } })).status).toBe(200);
  });

  it('logout encerra a sessão (HTTP e WebSocket)', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    await c.next((m) => m.type === 'snapshot');
    await t.http('/api/logout', { token: op, body: {} });
    expect((await t.http('/api/state', { token: op })).status).toBe(401);
    c.send({ type: 'ping' });
    expect((await c.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });
});

describe('medidores simulados (desacoplados do estado)', () => {
  it('LAB envia quadros marcados como simulados, sem mexer nas revisões', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t.base, op);
    await c.next((m) => m.type === 'snapshot');
    const rev = t.controller.state.snapshot().revision;
    c.send({ type: 'meters', on: true, hz: 15 });
    const f1 = await c.next((m) => m.type === 'meters');
    await c.next((m) => m.type === 'meters');
    expect(f1).toMatchObject({ simulated: true, source: 'lab' });
    expect(Object.keys(f1.levels)).toContain('master');
    expect(t.controller.state.snapshot().revision).toBe(rev);
    expect(c.inbox.filter(isEvent)).toEqual([]);
    c.send({ type: 'meters', on: false });
  });
});
