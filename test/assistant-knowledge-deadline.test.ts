import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { KNOWLEDGE_DEADLINE_MS } from '../src/assistant/service.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

/**
 * HOTFIX lab-assistant-timeout. A interface desiste em 25 s ("Sem resposta no prazo…"), mas a consulta documental (busca + resumo do
 * qwen3 local, até 8 s + 32 s) segurava a resposta. Com o modelo frio/ocupado a orientação local chegava tarde demais e era descartada.
 */
const TEXT = 'O surdo no canal 8 está sem grave no PA. Está faltando peso no som. Quero identificar a causa antes de mexer em qualquer ajuste.';
const dirs: string[] = [];
const running: Awaited<ReturnType<typeof startTestServer>>[] = [];
const clients: Awaited<ReturnType<typeof wsClient>>[] = [];
afterEach(async () => { clients.splice(0).forEach((c) => c.ws.close()); for (const t of running.splice(0)) await t.server.close(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); });

async function lab(enrich: () => Promise<unknown>, deadlineMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-dl-')); dirs.push(dir);
  const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
  const knowledge = new LocalKnowledge({ store, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
  const spy = vi.spyOn(knowledge, 'enrich').mockImplementation(enrich as never);
  const channels = parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8')));
  const t = await startTestServer({ channels, knowledge, dir, knowledgeConfig: deadlineMs ? { replyDeadlineMs: deadlineMs } : {} }); running.push(t);
  const c = await wsClient(t.base, await t.login(OPERATOR_PIN)); clients.push(c);
  await c.next((m) => m.type === 'snapshot');
  let n = 0;
  const ask = async (text: string) => {
    const requestId = `q${++n}`; const t0 = Date.now();
    c.send({ type: 'assistant', requestId, text });
    const m = await c.next((x) => x.type === 'assistant_reply' && x.requestId === requestId, 8000);
    return { reply: m.reply, ms: Date.now() - t0 };
  };
  return { t, ask, spy };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slowEnrich = (ms: number) => async () => { await sleep(ms); return { mode: 'vector', degraded: false, passages: [], narrativeStatus: { status: 'used', provider: 'ollama' }, narrative: { text: 'resumo tardio', source: 'ollama', verified: false } }; };

describe('prazo da consulta documental dentro da resposta do assistente', () => {
  it('REPRODUÇÃO/CORREÇÃO: modelo lento (3 s) com prazo de 1 s — a orientação local chega no prazo, degradada e sem o resumo', async () => {
    const { ask, spy, t } = await lab(slowEnrich(3000), 1000);
    const write = vi.spyOn(t.mixer, 'write');
    const { reply, ms } = await ask(TEXT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ms).toBeLessThan(2500);
    expect(reply.kind).toBe('diagnosis');
    expect(reply.knowledge).toMatchObject({ degraded: true, mode: 'deterministic', passages: [], narrativeStatus: { status: 'timeout' } });
    expect(reply.knowledge.narrative).toBeUndefined();
    expect(reply.knowledge.reason).toMatch(/demorou mais de 1 s/);
    expect(JSON.stringify(reply)).not.toContain('resumo tardio');
    expect(write).not.toHaveBeenCalled();
  });
  it('o resultado tardio não vira cache: o pedido seguinte consulta de novo', async () => {
    const { ask, spy } = await lab(slowEnrich(1500), 1000);
    await ask(TEXT);
    await ask(TEXT);
    expect(spy.mock.calls.length).toBe(2);
  });
  it('consulta rápida: o conteúdo passa intacto, sem degradação', async () => {
    const { ask } = await lab(async () => ({ mode: 'vector', degraded: false, passages: [], narrativeStatus: { status: 'used', provider: 'ollama' }, narrative: { text: 'resumo ok', source: 'ollama', verified: false } }), 5000);
    const { reply } = await ask(TEXT);
    expect(reply.knowledge).toMatchObject({ degraded: false, narrative: { text: 'resumo ok' } });
  });
  it('consulta que rejeita não derruba a resposta nem gera rejeição não tratada', async () => {
    const { ask } = await lab(async () => { throw new Error('ollama caiu'); }, 1000);
    const { reply } = await ask(TEXT);
    expect(reply.kind).toBe('diagnosis');
  });
  it('o prazo padrão do servidor fica abaixo do prazo da interface, com folga', () => {
    const ui = readFileSync(join(PROJECT_ROOT, 'web', 'src', 'app', 'core', 'live.service.ts'), 'utf8');
    const uiMs = Number(/assistant\([^)]*timeoutMs = ([\d_]+)/.exec(ui)?.[1]?.replace(/_/g, ''));
    expect(uiMs).toBe(25_000);
    expect(KNOWLEDGE_DEADLINE_MS).toBeLessThanOrEqual(uiMs - 4000);
    // O resto do trabalho do servidor (parser local + montagem) é instantâneo; sobra folga para a rede.
  });
  it('a configuração tem padrão 20 s e recusa prazo que alcance o da interface (25 s)', async () => {
    const { parseConfig } = await import('../src/core/config.js');
    expect(parseConfig({}).knowledge.replyDeadlineMs).toBe(20_000);
    expect(() => parseConfig({ knowledge: { replyDeadlineMs: 25_000 } })).toThrow();
    expect(() => parseConfig({ knowledge: { replyDeadlineMs: 500 } })).toThrow();
  });
});
