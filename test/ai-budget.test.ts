import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeClient, type AiSettings } from '../src/ai/claude.js';
import { UsageTracker } from '../src/ai/usage.js';
import { parseChannels, parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

const band = () => parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8')));
const CTX = {
  role: 'operator' as const,
  channels: [{ number: 9, name: 'Surdo', aliases: ['surdo'] }],
  state: '9 Surdo: PA −10.0 dB',
  steps: { smallStepDB: 2, mediumStepDB: 3, largeStepDB: 5 },
};
/** Resposta simulada da Anthropic (nenhum crédito real). */
const reply = (usage: unknown = { input_tokens: 900, output_tokens: 80 }, status = 200) =>
  new Response(JSON.stringify({ model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't', name: 'propor_ajuste', input: { acao: 'responder', resposta: 'ok' } }], usage }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const settings = (over: Partial<AiSettings> = {}): AiSettings => ({ ...parseConfig({}).ai, enabled: true, ...over });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'mixai-usage-')), 'ai-usage.json');

describe('orçamento da IA: reserva antes da chamada e reconciliação', () => {
  it('a reserva em andamento conta para o teto e é trocada pelo consumo real ao terminar', async () => {
    let release!: (r: Response) => void;
    const usage = new UsageTracker(tmpFile());
    // maxOutputTokens alto: a reserva (~US$ 0,002) é bem maior que o consumo real (~US$ 0,00013)
    const s = settings({ maxOutputTokens: 4000, dailyBudgetUSD: 0.003 });
    let calls = 0;
    const client = new ClaudeClient(s, 'k', usage, () => {
      calls++;
      return new Promise((r) => (release = r));
    });
    const first = client.interpret('primeiro pedido vago', CTX);
    await Promise.resolve();
    const during = usage.current();
    expect(during.reservedUSD).toBeGreaterThan(0.0015);
    // Segundo pedido enquanto o primeiro está em andamento: a reserva não cabe junto.
    const second = await client.interpret('segundo pedido vago', CTX);
    expect(second).toMatchObject({ ok: false, code: 'AI_BUDGET' });
    expect(calls).toBe(1);
    release(reply());
    const r1 = await first;
    expect(r1.ok).toBe(true);
    const after = usage.current();
    expect(after.reservedUSD).toBe(0);
    expect(after.costUSD).toBeCloseTo((900 * 0.1 + 80 * 0.5) / 1e6, 12); // consumo REAL, não a estimativa
    // Reconciliado: agora cabe outro pedido.
    const third = client.interpret('terceiro pedido vago', CTX);
    await Promise.resolve();
    release(reply());
    expect((await third).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('tempo esgotado: cobra a estimativa inteira (a API pode ter processado)', async () => {
    const usage = new UsageTracker(tmpFile());
    const client = new ClaudeClient(settings({ timeoutMs: 1000 }), 'k', usage, (_u, init) =>
      new Promise((_, reject) => init!.signal?.addEventListener('abort', () => reject(init!.signal!.reason))),
    );
    const r = await client.interpret('vago', CTX);
    expect(r).toMatchObject({ ok: false, code: 'AI_TIMEOUT' });
    expect(r.usage?.estimated).toBe(true);
    const u = usage.current();
    expect(u.reservedUSD).toBe(0);
    expect(u.costUSD).toBeGreaterThan(0);
    expect(u.costUSD).toBeCloseTo(r.usage!.costUSD, 8);
  });

  it('rede caiu e erro 5xx: cobra a estimativa; 429/401: libera sem cobrar', async () => {
    const down = new UsageTracker(tmpFile());
    await new ClaudeClient(settings(), 'k', down, async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }).interpret('vago', CTX);
    expect(down.current().costUSD).toBeGreaterThan(0);

    const five = new UsageTracker(tmpFile());
    await new ClaudeClient(settings(), 'k', five, async () => new Response('{}', { status: 529 })).interpret('vago', CTX);
    expect(five.current().costUSD).toBeGreaterThan(0);

    for (const status of [429, 401]) {
      const u = new UsageTracker(tmpFile());
      const r = await new ClaudeClient(settings(), 'k', u, async () => new Response('{}', { status })).interpret('vago', CTX);
      expect(r.ok).toBe(false);
      expect(u.current()).toMatchObject({ costUSD: 0, reservedUSD: 0 });
    }
  });

  it('resposta sem o consumo informado: fica a estimativa (conservador)', async () => {
    const usage = new UsageTracker(tmpFile());
    const r = await new ClaudeClient(settings(), 'k', usage, async () => reply(null)).interpret('vago', CTX);
    expect(r.ok).toBe(true);
    expect(r.usage?.estimated).toBe(true);
    expect(usage.current().costUSD).toBeGreaterThan(0.0002);
  });

  it('arquivo de consumo corrompido: guarda o original e bloqueia a IA no dia (não sabemos o gasto)', async () => {
    const file = tmpFile();
    writeFileSync(file, '{"day": "hoje", "costUSD": "muito"');
    const usage = new UsageTracker(file);
    let calls = 0;
    const r = await new ClaudeClient(settings(), 'k', usage, async () => {
      calls++;
      return reply();
    }).interpret('vago', CTX);
    expect(r).toMatchObject({ ok: false, code: 'AI_BUDGET' });
    expect(r.ok ? '' : r.message).toContain('ilegível');
    expect(calls).toBe(0);
    expect(readdirSync(join(file, '..')).some((f) => f.includes('.corrupt-'))).toBe(true);
    expect(existsSync(file)).toBe(false);
    // dia seguinte: volta a funcionar
    let now = Date.now();
    const tomorrow = new UsageTracker(file, () => now);
    now += 24 * 3_600_000;
    expect(tomorrow.reserve(0.0001, 1).ok).toBe(true);
  });

  it('consumo de hoje gravado é respeitado depois de reiniciar (inclusive valores negativos ou ausentes = corrompido)', () => {
    const file = tmpFile();
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(file, JSON.stringify({ day, requests: 3, inputTokens: 10, outputTokens: 2, costUSD: 0.49 }));
    expect(new UsageTracker(file).reserve(0.02, 0.5).ok).toBe(false); // 0,49 + 0,02 > 0,50
    const bad = tmpFile();
    writeFileSync(bad, JSON.stringify({ day, requests: 1, inputTokens: 1, outputTokens: 1, costUSD: -5 }));
    expect(new UsageTracker(bad).reserve(0.0001, 1)).toMatchObject({ ok: false, reason: 'blocked' });
  });
});

describe('orçamento da IA no servidor: duas sessões ao mesmo tempo perto do teto', () => {
  const running: Array<Awaited<ReturnType<typeof startTestServer>>> = [];
  const clients: Array<{ close: () => void }> = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const t of running.splice(0)) await t.server.close();
  });

  it('só uma chamada sai; a outra recebe AI_BUDGET; depois da reconciliação, cabe de novo', async () => {
    const pending: Array<(r: Response) => void> = [];
    const t = await startTestServer({
      channels: band(),
      ai: { enabled: true, maxOutputTokens: 4000, dailyBudgetUSD: 0.003 },
      aiKey: 'k',
      aiFetch: () => new Promise((r) => pending.push(r)),
    });
    running.push(t);
    const open = async () => {
      const c = await wsClient(t.base, await t.login(OPERATOR_PIN));
      clients.push(c);
      await c.next((m) => m.type === 'snapshot');
      return c;
    };
    const a = await open();
    const b = await open();
    a.send({ type: 'assistant', requestId: 'qa', text: 'tá embolado o som' });
    b.send({ type: 'assistant', requestId: 'qb', text: 'tá estranho o retorno' });
    const rb = (await b.next((m) => m.type === 'assistant_reply' && m.requestId === 'qb')).reply;
    expect(rb.code).toBe('AI_BUDGET');
    expect(pending.length).toBe(1); // só UMA chamada à API
    pending[0]!(reply());
    const ra = (await a.next((m) => m.type === 'assistant_reply' && m.requestId === 'qa')).reply;
    expect(ra.kind).toBe('answer');
    // reconciliada com o consumo real (bem menor que a reserva): a outra sessão já cabe
    b.send({ type: 'assistant', requestId: 'qb2', text: 'tá estranho o retorno' });
    await new Promise((r) => setTimeout(r, 100));
    expect(pending.length).toBe(2);
    pending[1]!(reply());
    expect((await b.next((m) => m.type === 'assistant_reply' && m.requestId === 'qb2')).reply.kind).toBe('answer');
    // e a mesa nunca travou: parser local responde mesmo com o teto apertado
    a.send({ type: 'assistant', requestId: 'local', text: 'sobe o surdo no PA' });
    expect((await a.next((m) => m.type === 'assistant_reply' && m.requestId === 'local')).reply.kind).toBe('proposals');
  });
});
