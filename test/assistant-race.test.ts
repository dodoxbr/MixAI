import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { paramKey } from '../src/core/revisions.js';
import { MASTER } from '../src/mixer/types.js';
import { OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

const band = () => parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8')));
type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
const clients: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const t of running.splice(0)) await t.server.close();
});
async function start() {
  const t = await startTestServer({ channels: band() });
  running.push(t);
  return t;
}
let seq = 0;
async function screen(t: T) {
  const c = await wsClient(t.base, await t.login(OPERATOR_PIN));
  clients.push(c);
  await c.next((m) => m.type === 'snapshot');
  const ask = async (text: string) => {
    const requestId = `a${++seq}`;
    c.send({ type: 'assistant', requestId, text });
    return (await c.next((m) => m.type === 'assistant_reply' && m.requestId === requestId)).reply;
  };
  /** Manda o "Aplicar" e devolve a promessa do resultado (sem esperar). */
  const apply = (proposalId: string) => {
    const requestId = `p${++seq}`;
    c.send({ type: 'proposal_apply', requestId, proposalId });
    return c.next((m) => m.type === 'proposal_result' && m.requestId === requestId, 8000);
  };
  return { c, ask, apply };
}
const v = (t: T, key: string) => (t.mixer.read(key as never) as { value?: unknown }).value;
const SURDO = paramKey.level(9, MASTER);

/**
 * Segura a PRÓXIMA escrita na mesa: o comando de outro cliente fica parado DENTRO da fila
 * (já passou pelas próprias conferências). Assim a corrida é reproduzível.
 */
function holdNextWrite(t: T) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inside = new Promise<void>((r) => (entered = r));
  const orig = t.mixer.write.bind(t.mixer);
  let armed = true;
  t.mixer.write = async (k, val) => {
    if (armed) {
      armed = false;
      entered();
      await gate;
    }
    return orig(k, val);
  };
  return { inside, release };
}

/** Espera o servidor processar mensagens já enviadas (o "Aplicar" entrar na fila). */
const tick = () => new Promise((r) => setTimeout(r, 150));

describe('aplicar proposta é atômico em relação às outras escritas (mesma fila)', () => {
  it('volume: dois clientes aplicam ao mesmo tempo no mesmo canal → um aplica, o outro recalcula', async () => {
    const t = await start();
    const a = await screen(t);
    const b = await screen(t);
    const pa = (await a.ask('sobe o surdo no PA')).proposals[0];
    const pb = (await b.ask('aumenta bastante o surdo no PA')).proposals[0];
    const [ra, rb] = await Promise.all([a.apply(pa.id), b.apply(pb.id)]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual(['applied', 'recalculated']);
    // Nunca as duas empilhadas: o valor é exatamente o de UMA proposta.
    expect([-8, -5]).toContain(v(t, SURDO));
    const recalc = ra.status === 'recalculated' ? ra : rb;
    expect(recalc.proposal.current).toBe(v(t, SURDO) === -8 ? '−8.0 dB' : '−5.0 dB');
  });

  it('volume: comando de outro cliente já na fila → a proposta NÃO é aplicada sobre o valor velho', async () => {
    const t = await start();
    const a = await screen(t);
    const card = (await a.ask('sobe o surdo no PA')).proposals[0]; // −10 → −8
    const hold = holdNextWrite(t);
    const op = await t.login(OPERATOR_PIN);
    const other = t.command(op, { type: 'set_level', channel: 9, db: -14 }); // fica parado dentro da fila
    await hold.inside;
    const res = a.apply(card.id); // ainda vê a revisão antiga; entra na fila atrás
    await tick();
    hold.release();
    expect((await other).json.result.code).toBe('OK');
    const r = await res;
    expect(r.status).toBe('recalculated');
    expect(r.proposal).toMatchObject({ current: '−14.0 dB', result: '−12.0 dB' });
    expect(v(t, SURDO)).toBe(-14); // não virou −8
    expect((await a.apply(r.proposal.id)).status).toBe('applied'); // novo toque em Aplicar
    expect(v(t, SURDO)).toBe(-12);
  });

  it('mute: outro cliente muta o mesmo canal enquanto o Aplicar espera → nada aplicado; nada mais a fazer', async () => {
    const t = await start();
    const a = await screen(t);
    const card = (await a.ask('muta o pandeiro no PA')).proposals[0];
    const hold = holdNextWrite(t);
    const op = await t.login(OPERATOR_PIN);
    const other = t.command(op, { type: 'set_mute', channels: [7], muted: true });
    await hold.inside;
    const res = a.apply(card.id);
    await tick();
    hold.release();
    await other;
    const r = await res;
    expect(r.status).toBe('nothing'); // recalculado: já está mutado
    expect(r.message).toContain('mudou');
    expect(v(t, paramKey.mute(7, MASTER))).toBe(true);
  });

  it('master: mudança aprovada por outro operador na frente → conflito, sem criar pendência velha; depois a aprovação humana continua', async () => {
    const t = await start();
    const a = await screen(t);
    const card = (await a.ask('abaixa o master 2 db')).proposals[0]; // −6 → −8
    const op = await t.login(OPERATOR_PIN);
    const ask = await t.command(op, { type: 'set_master', db: -10 });
    const hold = holdNextWrite(t);
    const approval = t.http(`/api/pending/${ask.json.result.pendingId}/approve`, { token: op, body: { requestId: 'ap-1' } });
    await hold.inside;
    const res = a.apply(card.id);
    await tick();
    hold.release();
    expect((await approval).json.result.code).toBe('OK');
    const r = await res;
    expect(r.status).toBe('recalculated');
    expect(r.proposal).toMatchObject({ destination: 'MASTER', current: '−10.0 dB', result: '−12.0 dB', needsApproval: true });
    expect(v(t, paramKey.master())).toBe(-10);
    expect((await t.http('/api/pending', { token: op })).json.items).toEqual([]); // nenhuma pendência do estado velho
    // a proposta recalculada continua exigindo a aprovação humana da E2
    expect((await a.apply(r.proposal.id)).status).toBe('awaiting_approval');
    expect(v(t, paramKey.master())).toBe(-10);
  });

  it('desfazer: outro comando entra na pilha enquanto o Aplicar espera → não desfaz o ajuste errado', async () => {
    const t = await start();
    const a = await screen(t);
    const op = await t.login(OPERATOR_PIN);
    await t.command(op, { type: 'set_level', channel: 9, deltaDB: 2 }); // surdo −8 (topo da pilha)
    const card = (await a.ask('desfaz o último ajuste')).proposals[0];
    expect(card.current).toContain('Surdo');
    const hold = holdNextWrite(t);
    const other = t.command(op, { type: 'set_level', channel: 1, deltaDB: 2 }); // cavaco: vira o novo topo
    await hold.inside;
    const res = a.apply(card.id);
    await tick();
    hold.release();
    await other;
    const r = await res;
    expect(r.status).toBe('recalculated');
    expect(r.proposal.current).toContain('Cavaco'); // o cartão novo mostra o que seria desfeito agora
    expect(v(t, SURDO)).toBe(-8); // nada foi desfeito sem novo toque
    expect(v(t, paramKey.level(1, MASTER))).toBe(-8);
  });

  it('o cliente não consegue mandar a precondição nem forjar "expect" no comando', async () => {
    const t = await start();
    const a = await screen(t);
    const r = await a.c.request({ type: 'command', expect: { revisions: [] }, command: { type: 'set_level', channel: 9, deltaDB: 1, expect: { revisions: [] } } });
    expect(r.result.code).toBe('INVALID'); // campo desconhecido no comando é recusado
  });
});
