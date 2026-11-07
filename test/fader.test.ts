import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { paramKey } from '../src/core/revisions.js';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
const clients: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const t of running.splice(0)) await t.server.close();
});
async function start(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer(opts);
  running.push(t);
  return t;
}
async function ws(t: T, token: string) {
  const c = await wsClient(t.base, token);
  clients.push(c);
  await c.next((m) => m.type === 'snapshot');
  return c;
}
const VOZ1 = paramKey.level(1, MASTER);
const value = (t: T, key: string) => (t.mixer.read(key as never) as { value?: number }).value;

/** Simula um arraste: muitos valores seguidos e o "soltou" no fim. */
function drag(c: Awaited<ReturnType<typeof ws>>, gestureId: string, from: number, to: number, steps: number, extra: Record<string, unknown> = {}) {
  for (let i = 1; i <= steps; i++) {
    c.send({ type: 'fader', gestureId, channel: 1, db: from + ((to - from) * i) / steps, ...extra });
  }
  c.send({ type: 'fader', gestureId, channel: 1, db: to, final: true, ...extra });
  return c.next((m) => m.type === 'fader_result' && m.gestureId === gestureId);
}

describe('arraste de fader (gesto humano)', () => {
  it('arraste longo: sem pedir confirmação por passo, conta como UM comando e UM desfazer', async () => {
    const t = await start({ safety: { maxActionsPerSecond: 5 } }); // limite real de comandos discretos
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t, op);
    const other = await ws(t, op);
    let writes = 0;
    const write = t.mixer.write.bind(t.mixer);
    t.mixer.write = async (k, v) => {
      writes++;
      return write(k, v);
    };
    const r = await drag(c, 'g1', -10, -40, 40);
    expect(r.result.code).toBe('OK');
    expect(value(t, VOZ1)).toBe(-40); // 30 dB num gesto, sem pendência
    expect(writes).toBeLessThan(41); // valores intermediários juntados
    await other.next((m) => m.type === 'event'); // a outra tela acompanhou
    expect(other.sync.state).toBeDefined();
    const undo = await t.command(op, { type: 'undo' });
    expect(undo.json.result.code).toBe('OK');
    expect(value(t, VOZ1)).toBe(-10); // um desfazer volta o gesto inteiro
    expect((await t.command(op, { type: 'undo' })).json.result.message).toContain('nada para desfazer');
  });

  it('respeita o teto de volume e o fundo (-∞)', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t, op);
    await drag(c, 'g2', -10, 10, 3);
    expect(value(t, VOZ1)).toBe(0); // teto do canal
    await drag(c, 'g3', 0, -100, 3);
    expect(value(t, VOZ1)).toBe(-Infinity);
  });

  it('músico: arraste recusado no PA e AUX; somente passos discretos', async () => {
    const t = await start();
    const mus = await t.login(MUSICIAN_PIN, t.controller.names.inputs.configured());
    const c = await ws(t, mus);
    const pa = await drag(c, 'm1', -10, -20, 2);
    expect(pa.result.code).toBe('FORBIDDEN');
    expect(value(t, VOZ1)).toBe(-10);
    const before = value(t, paramKey.level(1, auxBus(1)))!;
    const fones = await drag(c, 'm2', before, before - 6, 3, { aux: 1 });
    expect(fones.result.code).toBe('FORBIDDEN');
    expect(value(t, paramKey.level(1, auxBus(1)))).toBe(before);
  });

  it('assistente não arrasta fader', async () => {
    const t = await start();
    const c = await ws(t, readFileSync(`${t.dir}/agent-lab.token`, 'utf8'));
    const r = await drag(c, 'a1', -10, -12, 1);
    expect(r.result.code).toBe('FORBIDDEN');
  });

  it('tela cai no meio do arraste: o gesto vira um item no desfazer', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const c = await ws(t, op);
    c.send({ type: 'fader', gestureId: 'g4', channel: 1, db: -14 });
    c.send({ type: 'fader', gestureId: 'g4', channel: 1, db: -18 });
    await c.next((m) => m.type === 'event' && m.event.changes?.some((x: { value: { value: number } }) => x.value.value === -18));
    c.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 100));
    expect((await t.command(op, { type: 'undo' })).json.result.code).toBe('OK');
    expect(value(t, VOZ1)).toBe(-10);
  });

  it('o master não tem arraste: só set_master, que sempre vira pendência', async () => {
    const t = await start();
    const op = await t.login(OPERATOR_PIN);
    const r = await t.command(op, { type: 'set_master', db: -20 });
    expect(r.json.result.code).toBe('NEEDS_CONFIRMATION');
  });
});
