import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_TTL_MS } from '../src/assistant/diagnostic-context.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { MockMixer } from '../src/mixer/mock.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;
const servers: Server[] = [];
const clients: Array<{ close(): void }> = [];
afterEach(async () => {
  clients.splice(0).forEach(c => c.close());
  for (const t of servers.splice(0)) await t.server.close();
});
async function start(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer({ mode: 'mock', channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), ...opts });
  servers.push(t); return t;
}
const endpoint = '/api/assistant/conversation';
const stamp = (reply: Record<string, any>) => ({ id: reply.diagnosticContext.id, revision: reply.diagnosticContext.revision });
async function http(t: Server, token: string, text: string, context?: ReturnType<typeof stamp>) {
  return t.http(endpoint, { token, body: { text, ...(context ? { context } : {}) } });
}
async function screen(t: Server, token: string) {
  const c = await wsClient(t.base, token); clients.push(c);
  await c.next(m => m.type === 'snapshot');
  let seq = 0;
  const ask = async (text: string, context?: ReturnType<typeof stamp>, type = 'assistant') => {
    const requestId = `context-${++seq}`;
    c.send(type === 'assistant' ? { type, requestId, text, context } : { type, requestId, input: { text, context } });
    return (await c.next(m => m.type === 'assistant_reply' && m.requestId === requestId)).reply;
  };
  return { c, ask };
}

describe('B3B HTTP/WS, autenticação e concorrência', () => {
  it('HTTP → PA preserva fonte/sintoma/relato; nenhum builder, execute, pendência ou write', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN);
    const before = t.controller.state.snapshot();
    const build = vi.spyOn(t.server.core.assistant!.builder, 'build');
    const execute = vi.spyOn(t.server.core, 'execute');
    const first = await http(t, op, 'Meu cavaco está estridente. O que podemos fazer? Dado privado fora do relato.');
    const done = await http(t, op, 'PA.', stamp(first.json.reply));
    expect(done.status).toBe(200);
    expect(done.json.reply.text).toContain('Cavaco (canal 1). Destino: PA');
    expect(done.json.reply.diagnosis.evidence).toEqual(first.json.reply.diagnosis.evidence);
    expect(JSON.stringify(done.json.reply)).not.toContain('Dado privado');
    expect(done.json.reply.diagnosticContext).toBeNull();
    expect(done.json.reply.references.length).toBeGreaterThan(0);
    expect(done.json.reply.diagnosis.audioAnalysis).toBe('not_performed');
    expect(done.json.reply.proposals).toBeUndefined();
    expect(build).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect((t.mixer as MockMixer).writes).toEqual([]);
    expect(t.controller.state.snapshot()).toEqual(before);
    expect((await t.http('/api/pending', { token: op })).json.items).toEqual([]);
    expect(JSON.stringify(t.server.app.log.recent(500))).not.toContain('Meu cavaco está estridente');
  });

  it('HTTP e WS compartilham só a mesma sessão, inclusive reconexão', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN);
    const { ask, c } = await screen(t, op);
    const first = await ask('Meu cavaco está estridente');
    c.close();
    const next = await screen(t, op);
    const done = await next.ask('Fones', stamp(first), 'assistant_conversation');
    expect(done.text).toContain('AUX 1 compartilhado');
    expect(done.diagnosis.evidence[0].detail).toBe('Meu cavaco está estridente');
    expect((await http(t, op, 'PA')).json.reply.code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
  });

  it('duas respostas concorrentes da mesma revisão: uma avança e a outra é recusada', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN);
    const first = (await http(t, op, 'Minha voz está abafada')).json.reply;
    const [fred, lucius] = await Promise.all([http(t, op, 'Fred', stamp(first)), http(t, op, 'Lucius', stamp(first))]);
    expect([fred.status, lucius.status].sort()).toEqual([200, 409]);
    const winner = fred.status === 200 ? fred : lucius;
    const loser = fred.status === 409 ? fred : lucius;
    expect(loser.json.reply.code).toBe('DIAGNOSIS_CONTEXT_STALE');
    const done = await http(t, op, 'PA', stamp(winner.json.reply));
    expect(done.json.reply.text).toContain(fred.status === 200 ? 'Voz Fred' : 'Voz Lucius');
    expect(done.json.reply.proposals).toBeUndefined();
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it('dois sockets, mesma sessão: revisão antiga e cancelamento antigo não substituem assunto novo', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN);
    const a = await screen(t, op); const b = await screen(t, op);
    const first = await a.ask('Meu cavaco está estridente');
    const next = await b.ask('Meu surdo está magro');
    expect((await a.ask('PA', stamp(first))).code).toBe('DIAGNOSIS_CONTEXT_STALE');
    expect((await a.ask('cancelar diagnóstico', stamp(first))).code).toBe('DIAGNOSIS_CONTEXT_STALE');
    const done = await b.ask('PA', stamp(next));
    expect(done.text).toContain('Surdo (canal 9)');
    expect(JSON.stringify(done)).not.toContain('Meu cavaco');
  });

  it('sessões distintas com o mesmo PIN não compartilham contexto nem broadcasts', async () => {
    const t = await start(); const a = await t.login(OPERATOR_PIN); const b = await t.login(OPERATOR_PIN);
    const other = await screen(t, b);
    const first = (await http(t, a, 'Meu cavaco está estridente')).json.reply;
    expect((await http(t, b, 'PA')).json.reply.code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
    expect((await http(t, b, 'PA', stamp(first))).status).toBe(409);
    expect((await http(t, a, 'Fones', stamp(first))).json.reply.text).toContain('Cavaco');
    await other.c.request({ type: 'command', command: { type: 'mix_state', aux: 1 } });
    expect(other.c.inbox.some(m => m.type === 'assistant_reply')).toBe(false);
  });

  it('TTL exato, logout HTTP sem WS e expiração da autenticação eliminam estado', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN);
    const pending = (await http(t, op, 'Meu cavaco está estridente')).json.reply;
    t.clock.advance(CONTEXT_TTL_MS); t.server.core.sweep();
    expect(t.server.core.assistant!.diagnosticContexts.size).toBe(0);
    expect((await http(t, op, 'PA', stamp(pending))).status).toBe(409);
    await http(t, op, 'Meu cavaco está estridente');
    await t.http('/api/logout', { token: op, body: {} });
    expect(t.server.core.assistant!.diagnosticContexts.size).toBe(0);
    expect((await http(t, op, 'PA')).status).toBe(401);
    const fresh = await t.login(OPERATOR_PIN);
    expect((await http(t, fresh, 'PA')).json.reply.code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
    await http(t, fresh, 'Meu cavaco está estridente');
    t.clock.advance(13 * 3_600_000);
    expect((await http(t, fresh, 'PA')).status).toBe(401);
    expect(t.server.core.assistant!.diagnosticContexts.size).toBe(0);
  });

  it('cancelar simultaneamente a logout não ressuscita contexto', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN);
    const first = (await http(t, op, 'Meu cavaco está estridente')).json.reply;
    const { c } = await screen(t, op);
    await Promise.all([http(t, op, 'cancelar', stamp(first)), t.http('/api/logout', { token: op, body: {} })]);
    expect((await c.closed).code).toBe(4401);
    expect(t.server.core.assistant!.diagnosticContexts.size).toBe(0);
    expect((await http(t, op, 'PA')).status).toBe(401);
    await t.server.close();
    expect(t.server.core.assistant!.diagnosticContexts.size).toBe(0);
  });

  it('comandos explícitos de nível/mute têm prioridade; respostas curtas e ambiguidade não geram propostas', async () => {
    const aiFetch = vi.fn(async () => { throw new Error('Não deve chamar modelo'); });
    const t = await start({ ai: { enabled: true }, aiKey: 'test', aiFetch });
    const { ask } = await screen(t, await t.login(OPERATOR_PIN));
    for (const text of ['PA', 'Fones', 'sim', 'confirmo', '2', '+2 dB', 'isso mesmo']) {
      expect((await ask(text)).code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
    }
    for (const text of ['sobe o cavaco 2 dB no fone', 'muta o cavaco no PA']) {
      const pending = await ask('Meu cavaco está estridente');
      const command = await ask(text, stamp(pending));
      expect(command.kind).toBe('proposals');
      expect(command.diagnosticContext).toBeNull();
      expect((await ask('PA')).code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
    }
    const pending = await ask('Meu cavaco está estridente');
    expect((await ask('sim', stamp(pending))).code).toBe('DIAGNOSIS_CLARIFY');
    expect((await ask('abaixa o cavaco que está estridente', stamp(pending))).code).toBe('DIAGNOSIS_AMBIGUOUS');
    expect((await ask('PA', stamp(pending))).kind).toBe('diagnosis');
    expect(aiFetch).not.toHaveBeenCalled();
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it('rate-limit limita consulta; cancelamento e comandos mantêm disponibilidade', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN); const { ask } = await screen(t, op);
    const first = (await http(t, op, 'Meu cavaco está estridente')).json.reply;
    for (let i = 0; i < 19; i++) expect((await http(t, op, 'sim')).status).toBe(200);
    expect((await http(t, op, 'PA')).status).toBe(429);
    expect((await http(t, op, 'cancelar', stamp(first))).status).toBe(200);
    expect((await ask('muta o cavaco no PA')).kind).toBe('proposals');
    t.clock.advance(60_000);
    expect((await http(t, op, 'Meu cavaco está estridente')).status).toBe(200);
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it('endpoint técnico não aceita comandos/identidade forjados e protege músicos/agentes', async () => {
    const t = await start(); const op = await t.login(OPERATOR_PIN);
    expect((await t.http(endpoint, { body: { text: 'PA' } })).status).toBe(401);
    for (const body of [{ text: 'PA', principalId: 'other' }, { text: 'PA', context: { id: 'fake', revision: 1 } }, { text: 'PA', command: { type: 'set_level', db: 0 } }]) {
      expect((await t.http(endpoint, { token: op, body })).status).toBe(400);
    }
    expect((await http(t, op, 'sobe o cavaco no PA')).status).toBe(400);
    const agent = readFileSync(join(t.dir, 'agent-mock.token'), 'utf8');
    for (const token of [await t.login(MUSICIAN_PIN), agent]) {
      expect((await http(t, token, 'Meu cavaco está estridente')).status).toBe(403);
      const { ask } = await screen(t, token);
      expect((await ask('PA', undefined, 'assistant_conversation')).code).toBe('FORBIDDEN');
    }
    expect(t.server.core.assistant!.diagnosticContexts.size).toBe(0);
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });
});
