import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { parseChannels, parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { paramKey } from '../src/core/revisions.js';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

/**
 * Permissões do músico nos dois modos (server.musicianAccess):
 * - fones_only (padrão): só os fones;
 * - pa_without_master: fones + canais do PA em passos ≤ 3 dB (acima → aprovação do operador),
 *   mute de um canal por vez; nunca master, cenas, aprovações, desfazer ou arraste no PA.
 * Tudo conferido no SERVIDOR, inclusive contra mensagens WebSocket forjadas.
 */
const band = () => parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'test', 'fixtures', 'legacy-channels.yaml'), 'utf8')));
type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
const clients: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const t of running.splice(0)) await t.server.close();
});
async function start(access?: 'fones_only' | 'pa_without_master', extra: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer({ channels: band(), server: access ? { musicianAccess: access } : {}, ...extra });
  running.push(t);
  return t;
}
async function screen(t: T, pin: string) {
  const c = await wsClient(t.base, await t.login(pin, pin === MUSICIAN_PIN ? t.controller.names.inputs.configured() : undefined));
  clients.push(c);
  const hello = await c.next((m) => m.type === 'hello');
  const snap = await c.next((m) => m.type === 'snapshot');
  let n = 0;
  const cmd = async (command: Record<string, unknown>, extra: Record<string, unknown> = {}) => (await c.request({ type: 'command', command, ...extra })).result;
  const ask = async (text: string) => {
    const requestId = `q${++n}`;
    c.send({ type: 'assistant', requestId, text });
    return (await c.next((m) => m.type === 'assistant_reply' && m.requestId === requestId)).reply;
  };
  const apply = async (proposalId: string) => {
    const requestId = `p${++n}`;
    c.send({ type: 'proposal_apply', requestId, proposalId });
    return c.next((m) => m.type === 'proposal_result' && m.requestId === requestId);
  };
  const fader = async (msg: Record<string, unknown>) => {
    c.send({ type: 'fader', gestureId: `g${++n}`, final: true, ...msg });
    return (await c.next((m) => m.type === 'fader_result')).result;
  };
  return { c, hello, snap, cmd, ask, apply, fader };
}
const v = (t: T, key: string) => (t.mixer.read(key as never) as { value?: unknown }).value;
const SURDO_PA = paramKey.level(9, MASTER);
const SURDO_FONES = paramKey.level(9, auxBus(1));
const tick = () => new Promise((r) => setTimeout(r, 150));

describe('configuração da política do músico', () => {
  it('padrão é fones_only; o limite de passo do PA não pode passar de 3 dB', () => {
    expect(parseConfig({}).server).toMatchObject({ musicianAccess: 'fones_only', musicianPaStepDB: 3 });
    expect(parseConfig({ server: { musicianAccess: 'pa_without_master', musicianPaStepDB: 2 } }).server.musicianPaStepDB).toBe(2);
    expect(() => parseConfig({ server: { musicianPaStepDB: 6 } })).toThrow();
    expect(() => parseConfig({ server: { musicianAccess: 'tudo' } })).toThrow();
  });

  it('o hello informa a política (a tela só mostra o que o servidor permite)', async () => {
    const t = await start();
    expect((await screen(t, MUSICIAN_PIN)).hello).toMatchObject({ musicianAccess: 'fones_only' });
    const t2 = await start('pa_without_master');
    expect((await screen(t2, MUSICIAN_PIN)).hello).toMatchObject({ musicianAccess: 'pa_without_master', musicianPaStepDB: 3 });
  });
});

describe('fones_only (padrão): comportamento atual preservado', () => {
  it('músico ajusta os fones; PA e master recusados; estado sem PA', async () => {
    const t = await start();
    const m = await screen(t, MUSICIAN_PIN);
    const keys = Object.keys(m.snap.snapshot.params);
    expect(keys.some((k) => k.includes('.main.'))).toBe(false);
    expect(keys).not.toContain('master.level');
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', aux: 'fones', deltaDB: 2 })).code).toBe('OK');
    expect(v(t, SURDO_FONES)).toBe(-18);
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 1 })).code).toBe('FORBIDDEN');
    expect((await m.cmd({ type: 'set_mute', channels: ['surdo'], muted: true })).code).toBe('FORBIDDEN');
    expect((await m.fader({ channel: 9, db: -9 })).code).toBe('FORBIDDEN');
    expect(v(t, SURDO_PA)).toBe(-10);
    // consulta sem AUX continua indo para os fones
    expect((await m.cmd({ type: 'mix_state' })).data.bus).toMatch(/Fones|AUX/i);
  });

  it('parser: pedido sem destino vai para os FONES (o único destino deste músico)', async () => {
    const t = await start();
    const r = await (await screen(t, MUSICIAN_PIN)).ask('sobe o surdo');
    expect(r.kind).toBe('proposals');
    expect(r.proposals[0].destination).toBe('FONES');
  });
});

describe('pa_without_master: músico edita PA e FONES, nunca o master', () => {
  it('consulta: vê os canais do PA e dos fones; nunca o master nem EQ/HPF', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    const keys = Object.keys(m.snap.snapshot.params);
    expect(keys).toContain('ch.9.main.level');
    expect(keys).toContain('ch.9.main.mute');
    expect(keys).toContain('ch.9.aux.1.level');
    expect(keys).not.toContain('master.level');
    expect(keys.some((k) => k.includes('.eq.') || k.includes('.aux.2.'))).toBe(false);
    const st = await m.cmd({ type: 'mix_state' });
    expect(st.code).toBe('OK');
    expect(st.data.master).toBeUndefined(); // a consulta do PA não traz o master para o músico
  });

  it('volume no PA em passos de até 3 dB; mute de um canal; FONES continuam', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 2 })).code).toBe('OK');
    expect(v(t, SURDO_PA)).toBe(-8);
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: -3 })).code).toBe('OK');
    expect(v(t, SURDO_PA)).toBe(-11);
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', db: -9 })).code).toBe('OK'); // absoluto dentro do limite
    expect(v(t, SURDO_PA)).toBe(-9);
    expect((await m.cmd({ type: 'set_mute', channels: ['pandeiro'], muted: true })).code).toBe('OK');
    expect(v(t, paramKey.mute(7, MASTER))).toBe(true);
    expect((await m.cmd({ type: 'set_mute', channels: ['pandeiro'], muted: false })).code).toBe('OK');
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', aux: 'fones', deltaDB: 2 })).code).toBe('OK');
    expect(v(t, SURDO_FONES)).toBe(-18);
  });

  it('mudança grande no PA (relativa ou absoluta) vira aprovação do operador; só aplica depois do "Aprovar"', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    const op = await screen(t, OPERATOR_PIN);
    const big = await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 5 });
    expect(big.code).toBe('NEEDS_CONFIRMATION');
    expect(big.message).toContain('3 dB');
    expect(v(t, SURDO_PA)).toBe(-10); // nada mudou
    const card = (await op.c.next((x) => x.type === 'pending')).card;
    expect(card.requestedBy.label).toMatch(/^músico \(fixture-musician\) · sessão [0-9a-f]{6}$/); // perfil + sessão, nunca o PIN
    expect(card.summary).toContain('limite do músico no PA');
    // o músico não aprova (nem a própria)
    expect((await m.c.request({ type: 'approve', pendingId: card.pendingId })).result.code).toBe('FORBIDDEN');
    expect(v(t, SURDO_PA)).toBe(-10);
    const ok = await op.c.request({ type: 'approve', pendingId: card.pendingId });
    expect(ok.result.code).toBe('OK');
    expect(v(t, SURDO_PA)).toBe(-5);
    // absoluto longe do atual: também precisa do operador
    const abs = await m.cmd({ type: 'set_level', channel: 'surdo', db: 0 });
    expect(abs.code).toBe('NEEDS_CONFIRMATION');
    expect(v(t, SURDO_PA)).toBe(-5);
    const down = await op.cmd({ type: 'set_level', channel: 'tantã', db: -100 }); // o operador também precisa aprovar −∞
    if (down.pendingId) expect((await op.c.request({ type: 'approve', pendingId: down.pendingId })).result.code).toBe('OK');
    expect(v(t, paramKey.level(8, MASTER))).toBe(-Infinity);
    // canal em −∞: abrir direto num valor audível é mudança grande (o −∞ conta como −60 dB)
    expect((await m.cmd({ type: 'set_level', channel: 'tantã', db: -10 })).code).toBe('NEEDS_CONFIRMATION');
    expect(v(t, paramKey.level(8, MASTER))).toBe(-Infinity);
    // +3 a partir do −∞ vai para −57 dB: passo pequeno (e quase inaudível), permitido
    expect((await m.cmd({ type: 'set_level', channel: 'tantã', deltaDB: 3 })).code).toBe('OK');
    expect(v(t, paramKey.level(8, MASTER))).toBe(-57);
  });

  it('master, cenas/snapshots, desfazer, reset e mute em grupo no PA: negados', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    for (const command of [
      { type: 'set_master', deltaDB: -1 },
      { type: 'set_master', db: -6 },
      { type: 'load_snapshot', show: 'Laboratório', snapshot: 'Bar' },
      { type: 'list_snapshots' },
      { type: 'undo' },
      { type: 'reset_lab' },
      { type: 'history' },
      { type: 'set_mute', channels: ['surdo', 'pandeiro'], muted: true },
      { type: 'set_level', channel: 'surdo', aux: 2, deltaDB: 1 },
    ]) {
      expect((await m.cmd(command)).code, JSON.stringify(command)).toBe('FORBIDDEN');
    }
    expect(v(t, paramKey.master())).toBe(-6);
    expect(v(t, paramKey.mute(9, MASTER))).toBe(false);
  });

  it('WebSocket forjado: arraste no PA, confirmação embutida, ganho/phantom e expect são recusados', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    // arraste no PA: um gesto pode cruzar dezenas de dB → recusado mesmo ≤ 3 dB
    const drag = await m.fader({ channel: 9, db: 0 });
    expect(drag.code).toBe('FORBIDDEN');
    expect(drag.message).toContain('passos');
    expect((await m.fader({ channel: 9, db: -9.5 })).code).toBe('FORBIDDEN');
    expect(v(t, SURDO_PA)).toBe(-10);
    // Também nos fones, músicos usam somente passos discretos vinculados
    expect((await m.fader({ channel: 9, aux: 1, db: -15 })).code).toBe('FORBIDDEN');
    // confirmação embutida no comando
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 10, confirmationId: 'x' })).code).toBe('FORBIDDEN');
    // parâmetros físicos não existem no esquema
    expect((await m.cmd({ type: 'set_gain', channel: 'surdo', db: 10 })).code).toBe('INVALID');
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 2, phantom: true })).code).toBe('INVALID');
    // passo grande em vários comandos seguidos continua passando um a um pelo limite (≤ 3 dB cada)
    expect((await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 3.5 })).code).toBe('NEEDS_CONFIRMATION');
    expect(v(t, SURDO_PA)).toBe(-10);
    // aprovação forjada
    expect((await m.c.request({ type: 'approve', pendingId: 'qualquer' })).result.code).toBe('FORBIDDEN');
  });

  it('HTTP forjado também passa pela mesma política', async () => {
    const t = await start('pa_without_master');
    const tok = await t.login(MUSICIAN_PIN, t.controller.names.inputs.configured());
    expect((await t.command(tok, { type: 'set_master', db: 0 })).json.result.code).toBe('FORBIDDEN');
    expect((await t.command(tok, { type: 'set_level', channel: 'surdo', deltaDB: 8 })).json.result.code).toBe('NEEDS_CONFIRMATION');
    expect((await t.command(tok, { type: 'set_level', channel: 'surdo', deltaDB: 1 })).json.result.code).toBe('OK');
    expect((await t.http('/api/pending', { token: tok })).status).toBe(403);
  });

  it('operador e assistente MCP continuam com a autorização de antes', async () => {
    const t = await start('pa_without_master');
    const op = await screen(t, OPERATOR_PIN);
    expect((await op.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 5 })).code).toBe('OK'); // operador: limite geral (6 dB)
    expect((await op.fader({ channel: 9, db: -20 })).code).toBe('OK');
    const agent = readFileSync(`${t.dir}/agent-lab.token`, 'utf8');
    const r = await t.http('/api/command', { token: agent, body: { requestId: 'ag-1', command: { type: 'set_level', channel: 'surdo', deltaDB: 5 } } });
    expect(r.json.result.code).toBe('OK');
    const m2 = await t.http('/api/command', { token: agent, body: { requestId: 'ag-2', command: { type: 'set_master', deltaDB: -1 } } });
    expect(m2.json.result.code).toBe('NEEDS_CONFIRMATION'); // master do assistente: aprovação, como antes
  });

  it('histórico registra perfil e sessão de cada alteração (sem tratar o PIN como pessoa)', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    const op = await screen(t, OPERATOR_PIN);
    await m.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 2 });
    await m.cmd({ type: 'set_mute', channels: ['pandeiro'], aux: 'fones', muted: true });
    const big = await m.cmd({ type: 'set_level', channel: 'violão', deltaDB: 5 });
    await op.c.request({ type: 'approve', pendingId: big.pendingId });
    await m.cmd({ type: 'set_master', db: 0 }); // recusa também fica registrada
    const entries = (await op.cmd({ type: 'history', limit: 20 })).data.entries as Array<{ action: string; ok: boolean; details?: { by?: string } }>;
    const by = entries.map((e) => e.details?.by).filter(Boolean) as string[];
    expect(by.filter((b) => /^músico \(fixture-musician\) · sessão [0-9a-f]{6}$/.test(b)).length).toBeGreaterThanOrEqual(3);
    expect(by.some((b) => /^músico \(fixture-musician\) · sessão [0-9a-f]{6}; aprovado por operador · sessão [0-9a-f]{6}$/.test(b))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(MUSICIAN_PIN);
  });
});

describe('pa_without_master: assistente', () => {
  it('pedido sem destino: pergunta PA ou FONES (não presume mais os fones)', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    const r = await m.ask('sobe o surdo');
    expect(r.kind).toBe('clarify');
    expect(r.options.map((o: { label: string }) => o.label)).toEqual(['PA', 'Fones']);
    const pa = await m.ask(r.options[0].text);
    expect(pa.proposals[0].destination).toBe('PA');
    expect(pa.proposals[0].needsApproval).toBe(false); // 2 dB
  });

  it('proposta grande no PA avisa que precisa do operador; Aplicar vira cartão de aprovação', async () => {
    const t = await start('pa_without_master');
    const m = await screen(t, MUSICIAN_PIN);
    const r = await m.ask('aumenta bastante o surdo no PA'); // 5 dB
    expect(r.proposals[0].needsApproval).toBe(true);
    const res = await m.apply(r.proposals[0].id);
    expect(res.status).toBe('awaiting_approval');
    expect(v(t, SURDO_PA)).toBe(-10);
  });

  it('master pelo assistente: recusado com explicação', async () => {
    const t = await start('pa_without_master');
    const r = await (await screen(t, MUSICIAN_PIN)).ask('abaixa o master 2 db');
    expect(r.kind).toBe('error');
    expect(r.text).toContain('MASTER');
  });

  it('contexto da IA reflete a permissão: músico com PA vê os canais do PA, nunca o master', async () => {
    const bodies: string[] = [];
    const aiFetch = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({ content: [{ type: 'tool_use', name: 'propor_ajuste', input: { acao: 'responder', resposta: 'ok' } }], usage: { input_tokens: 10, output_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const t = await start('pa_without_master', { ai: { enabled: true }, aiKey: 'k', aiFetch });
    await (await screen(t, MUSICIAN_PIN)).ask('preciso organizar melhor a mix');
    const system = JSON.parse(bodies[0]!).system as string;
    expect(system).toContain('canais do PA');
    expect(system).toContain('9 Surdo: PA −10.0 dB');
    expect(system).not.toContain('Master:');

    const t2 = await start('fones_only', { ai: { enabled: true }, aiKey: 'k', aiFetch });
    await (await screen(t2, MUSICIAN_PIN)).ask('preciso organizar melhor a mix');
    const system2 = JSON.parse(bodies[1]!).system as string;
    expect(system2).toContain('só pode mexer nos FONES');
    expect(system2).not.toContain('PA −10.0 dB');
    expect(system2).not.toContain('Master:');
  });
});
