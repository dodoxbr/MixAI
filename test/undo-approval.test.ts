import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { paramKey } from '../src/core/revisions.js';
import { MASTER } from '../src/mixer/types.js';
import { OPERATOR_PIN, startTestServer } from './server-support.js';

type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
afterEach(async () => {
  for (const t of running.splice(0)) await t.server.close();
});

const VOZ1 = paramKey.level(1, MASTER);
const MASTER_KEY = paramKey.master();
const LAB_MASTER = -6;

async function setupAll() {
  const t = await startTestServer();
  running.push(t);
  const op = await t.login(OPERATOR_PIN);
  const token = readFileSync(`${t.dir}/agent-lab.token`, 'utf8');
  let n = 0;
  /** O assistente, como o MCP faria. */
  const agent = (command: Record<string, unknown>) =>
    t.http('/api/command', { token, body: { requestId: `ag-${++n}`, targetMode: 'lab', command } }).then((r) => r.json.result);
  const operator = (command: Record<string, unknown>) => t.command(op, command).then((r) => r.json.result);
  const approve = (id: string) => t.http(`/api/pending/${id}/approve`, { token: op, body: { requestId: `ap-${++n}` } }).then((r) => r.json.result);
  /** Pede e, se virar pendência, aprova como operador. */
  const approved = async (run: () => Promise<{ code: string; pendingId?: string }>) => {
    const r = await run();
    return r.code === 'NEEDS_CONFIRMATION' ? approve(r.pendingId!) : r;
  };
  const value = (key: string) => (t.mixer.read(key as never) as { value?: unknown }).value as number;
  return { t, agent, operator, approve, approved, value, agentToken: token };
}

describe('desfazer: operações críticas exigem aprovação humana', () => {
  it('assistente desfaz o próprio ajuste simples direto (preservado)', async () => {
    const { agent, value } = await setupAll();
    expect((await agent({ type: 'set_level', channel: 'voz 1', deltaDB: 2 })).code).toBe('OK');
    const u = await agent({ type: 'undo' });
    expect(u.code).toBe('OK');
    expect(value(VOZ1)).toBe(-10);
  });

  it('master alterado pelo OPERADOR: o assistente não desfaz sem aprovação; não consegue se autoaprovar', async () => {
    const { agent, operator, approve, approved, value } = await setupAll();
    expect((await approved(() => operator({ type: 'set_master', deltaDB: -3 }))).code).toBe('OK');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER - 3);

    const u = await agent({ type: 'undo' });
    expect(u.code).toBe('NEEDS_CONFIRMATION');
    expect(u.message).toContain('aprovação');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER - 3); // nada mudou
    // tentativa de autoaprovação
    expect((await agent({ type: 'undo', confirmationId: u.pendingId })).code).toBe('FORBIDDEN');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER - 3);
    // operador aprova o cartão
    const ok = await approve(u.pendingId);
    expect(ok.code).toBe('OK');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER);
  });

  it('master alterado pelo próprio ASSISTENTE (aprovado antes): desfazer também precisa de aprovação', async () => {
    const { agent, approve, approved, value } = await setupAll();
    expect((await approved(() => agent({ type: 'set_master', deltaDB: -2 }))).code).toBe('OK');
    const u = await agent({ type: 'undo' });
    expect(u.code).toBe('NEEDS_CONFIRMATION');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER - 2);
    expect((await approve(u.pendingId)).code).toBe('OK');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER);
  });

  it('passo grande (crítico) do assistente: desfazer precisa de aprovação', async () => {
    const { agent, approved, value } = await setupAll();
    expect((await approved(() => agent({ type: 'set_level', channel: 'surdo', deltaDB: 10 }))).code).toBe('OK');
    const u = await agent({ type: 'undo' });
    expect(u.code).toBe('NEEDS_CONFIRMATION');
    expect(value(paramKey.level(6, MASTER))).toBe(0);
  });

  it('ajuste simples do OPERADOR: o assistente precisa de aprovação; o operador desfaz direto', async () => {
    const { agent, operator, value } = await setupAll();
    expect((await operator({ type: 'set_level', channel: 'voz 1', deltaDB: 2 })).code).toBe('OK');
    expect((await agent({ type: 'undo' })).code).toBe('NEEDS_CONFIRMATION');
    expect(value(VOZ1)).toBe(-8);
    expect((await operator({ type: 'undo' })).code).toBe('OK');
    expect(value(VOZ1)).toBe(-10);
  });

  it('operador desfaz o master direto (ele é o humano)', async () => {
    const { operator, approved, value } = await setupAll();
    await approved(() => operator({ type: 'set_master', deltaDB: -3 }));
    expect((await operator({ type: 'undo' })).code).toBe('OK');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER);
  });

  it('vários passos: se QUALQUER um é crítico, o conjunto precisa de aprovação', async () => {
    const { agent, approved, value } = await setupAll();
    await approved(() => agent({ type: 'set_master', deltaDB: -1 }));
    await agent({ type: 'set_level', channel: 'voz 1', deltaDB: 1 });
    const u = await agent({ type: 'undo', steps: 2 });
    expect(u.code).toBe('NEEDS_CONFIRMATION');
    expect(value(VOZ1)).toBe(-9);
    // um passo só (o ajuste simples do topo) continua direto
    expect((await agent({ type: 'undo' })).code).toBe('OK');
    expect(value(VOZ1)).toBe(-10);
  });

  it('pendência de desfazer fica obsoleta se a pilha ou os parâmetros mudarem antes da aprovação', async () => {
    const { agent, operator, approve, approved, value } = await setupAll();
    await approved(() => operator({ type: 'set_master', deltaDB: -3 }));
    const u = await agent({ type: 'undo' });
    expect(u.code).toBe('NEEDS_CONFIRMATION');
    await operator({ type: 'set_level', channel: 'voz 2', deltaDB: 1 }); // nova entrada no topo
    const r = await approve(u.pendingId);
    expect(r.code).toBe('CONFIRMATION_STALE');
    expect(value(MASTER_KEY)).toBe(LAB_MASTER - 3);
    expect(value(paramKey.level(2, MASTER))).toBe(-9);
  });
});
