import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const corruptCopies = (file: string) =>
  readdirSync(join(file, '..'))
    .filter((f) => f.startsWith('ai-usage.json.corrupt-'))
    .map((f) => join(file, '..', f));

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

  it('arquivo de consumo corrompido: bloqueia a IA no dia e guarda o original intacto', async () => {
    const file = tmpFile();
    const original = '{"day": "hoje", "costUSD": "muito"';
    writeFileSync(file, original);
    const usage = new UsageTracker(file);
    let calls = 0;
    const r = await new ClaudeClient(settings(), 'k', usage, async () => {
      calls++;
      return reply();
    }).interpret('vago', CTX);
    expect(r).toMatchObject({ ok: false, code: 'AI_BUDGET' });
    expect(r.ok ? '' : r.message).toContain('ilegível');
    expect(calls).toBe(0);
    const kept = corruptCopies(file);
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0]!, 'utf8')).toBe(original); // histórico preservado, byte a byte
    expect(existsSync(`${file}.blocked`)).toBe(true); // o bloqueio está gravado
  });
});

describe('bloqueio e falha de gravação valem depois de reiniciar', () => {
  const DAY = 24 * 3_600_000;
  const clockAt = (start = Date.parse('2026-11-05T15:00:00Z')) => {
    const c = { now: start, fn: () => c.now };
    return c;
  };

  it('corrupção → reinício no MESMO dia continua bloqueado → no dia seguinte volta, com a cópia intacta', async () => {
    const file = tmpFile();
    const original = '{"day":"2026-11-05","requests":2,"costUSD":-1}';
    writeFileSync(file, original);
    const c = clockAt();
    expect(new UsageTracker(file, c.fn).reserve(0.0001, 1)).toMatchObject({ ok: false, reason: 'blocked' });

    // reinício no mesmo dia: o arquivo ilegível já saiu do caminho, mas o bloqueio continua
    c.now += 3_600_000;
    expect(existsSync(file)).toBe(false);
    const restarted = new UsageTracker(file, c.fn);
    expect(restarted.current()).toMatchObject({ blocked: true, costUSD: 0 });
    let calls = 0;
    const r = await new ClaudeClient(settings(), 'k', restarted, async () => {
      calls++;
      return reply();
    }).interpret('vago', CTX);
    expect(r).toMatchObject({ ok: false, code: 'AI_BUDGET' });
    expect(calls).toBe(0); // a API nunca foi chamada
    expect(existsSync(file)).toBe(false); // nada gravado no lugar do registro enquanto bloqueado

    // o mesmo processo também libera quando o dia vira
    c.now += DAY;
    expect(restarted.reserve(0.0001, 1).ok).toBe(true);

    // e um reinício já no dia seguinte começa liberado
    const tomorrow = new UsageTracker(file, c.fn);
    expect(tomorrow.current().blocked).toBe(false);
    expect(tomorrow.reserve(0.0001, 1).ok).toBe(true);
    const kept = corruptCopies(file);
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0]!, 'utf8')).toBe(original);
  });

  it('nem o bloqueio dá para gravar → o arquivo ilegível fica onde está (sem sobrescrever) e o reinício bloqueia de novo', () => {
    const file = tmpFile();
    const original = 'isto não é json';
    writeFileSync(file, original);
    mkdirSync(`${file}.blocked`); // marcador impossível de gravar (é uma pasta)
    mkdirSync(`${file}.blocked/x`);
    const c = clockAt();
    expect(new UsageTracker(file, c.fn).reserve(0.0001, 1)).toMatchObject({ ok: false, reason: 'blocked' });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(corruptCopies(file)).toHaveLength(0);
    expect(new UsageTracker(file, c.fn).reserve(0.0001, 1)).toMatchObject({ ok: false, reason: 'blocked' });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('cópia anterior com o mesmo nome nunca é sobrescrita', () => {
    const file = tmpFile();
    const c = clockAt();
    const stamp = new Date(c.now).toISOString().replace(/[:.]/g, '-');
    writeFileSync(`${file}.corrupt-${stamp}`, 'cópia antiga');
    writeFileSync(file, 'nova corrupção');
    new UsageTracker(file, c.fn);
    expect(readFileSync(`${file}.corrupt-${stamp}`, 'utf8')).toBe('cópia antiga');
    expect(readFileSync(`${file}.corrupt-${stamp}-1`, 'utf8')).toBe('nova corrupção');
  });

  it('falha de gravação ANTES da chamada: a API não é chamada; volta quando a gravação volta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-usage-'));
    writeFileSync(join(dir, 'data'), 'arquivo no lugar da pasta'); // gravar em data/ falha
    const file = join(dir, 'data', 'ai-usage.json');
    const usage = new UsageTracker(file);
    let calls = 0;
    const client = new ClaudeClient(settings(), 'k', usage, async () => {
      calls++;
      return reply();
    });
    const r = await client.interpret('vago', CTX);
    expect(r).toMatchObject({ ok: false, code: 'AI_BUDGET' });
    expect(r.ok ? '' : r.message).toContain('gravar');
    expect(calls).toBe(0);
    expect(usage.current()).toMatchObject({ reservedUSD: 0, paused: true });

    rmSync(join(dir, 'data')); // gravação volta a funcionar
    expect((await client.interpret('vago', CTX)).ok).toBe(true);
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ requests: 1, inputTokens: 900, reservedUSD: 0 });
    expect(usage.current().paused).toBe(false);
  });

  it('falha ao gravar o consumo DEPOIS da chamada: IA pausada até gravar; nada do consumo se perde', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-usage-'));
    const file = join(dir, 'data', 'ai-usage.json');
    const usage = new UsageTracker(file);
    let calls = 0;
    const client = new ClaudeClient(settings(), 'k', usage, async () => {
      calls++;
      // a pasta some no meio da chamada: a gravação do consumo real vai falhar
      renameSync(join(dir, 'data'), join(dir, 'data-fora'));
      writeFileSync(join(dir, 'data'), 'bloqueia');
      return reply();
    });
    expect((await client.interpret('vago', CTX)).ok).toBe(true);
    expect(usage.current()).toMatchObject({ paused: true, requests: 1 });

    const blocked = new ClaudeClient(settings(), 'k', usage, async () => {
      calls++;
      return reply();
    });
    const r = await blocked.interpret('vago', CTX);
    expect(r).toMatchObject({ ok: false, code: 'AI_BUDGET' });
    expect(calls).toBe(1); // pausada: nenhuma chamada nova

    rmSync(join(dir, 'data'));
    renameSync(join(dir, 'data-fora'), join(dir, 'data'));
    expect((await blocked.interpret('vago', CTX)).ok).toBe(true);
    expect(calls).toBe(2);
    // o consumo que ficou só em memória foi gravado junto: 2 pedidos
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ requests: 2, inputTokens: 1800, reservedUSD: 0 });
  });

  it('servidor caiu no meio da chamada: ao reiniciar, a reserva gravada é cobrada', () => {
    const file = tmpFile();
    const c = clockAt();
    const before = new UsageTracker(file, c.fn);
    const res = before.reserve(0.3, 0.5);
    expect(res.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).reservedUSD).toBeCloseTo(0.3, 9);
    // "reinício" sem settle: a reserva conta como gasta
    const after = new UsageTracker(file, c.fn);
    expect(after.current()).toMatchObject({ reservedUSD: 0 });
    expect(after.current().costUSD).toBeCloseTo(0.3, 9);
    expect(after.reserve(0.3, 0.5)).toMatchObject({ ok: false, reason: 'budget' });
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

  it('registro corrompido antes de iniciar: parser local segue funcionando; IA bloqueada também depois de reiniciar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-srv-'));
    writeFileSync(join(dir, 'ai-usage.json'), '{"day": quebrado');
    let calls = 0;
    const boot = async () => {
      const t = await startTestServer({
        dir,
        channels: band(),
        ai: { enabled: true },
        aiKey: 'k',
        aiFetch: async () => {
          calls++;
          return reply();
        },
      });
      running.push(t);
      const c = await wsClient(t.base, await t.login(OPERATOR_PIN));
      clients.push(c);
      await c.next((m) => m.type === 'snapshot');
      let n = 0;
      const ask = async (text: string) => {
        const requestId = `q${++n}`;
        c.send({ type: 'assistant', requestId, text });
        return (await c.next((m) => m.type === 'assistant_reply' && m.requestId === requestId)).reply;
      };
      return { t, ask };
    };
    for (let round = 0; round < 2; round++) {
      const { t, ask } = await boot();
      expect((await ask('sobe o surdo no PA')).kind).toBe('proposals'); // parser local
      const vague = await ask('preciso organizar melhor a mix');
      expect(vague.code).toBe('AI_BUDGET');
      expect(vague).toMatchObject({ kind: 'error', source: 'ai' });
      expect(vague.text).toContain('ilegível');
      await t.server.close(); // "reinicia" no mesmo dia
      running.splice(running.indexOf(t), 1);
    }
    expect(calls).toBe(0);
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
    a.send({ type: 'assistant', requestId: 'qa', text: 'preciso organizar melhor a mix' });
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
