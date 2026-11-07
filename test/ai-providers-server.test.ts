import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { GeminiClient } from '../src/knowledge/local/gemini.js';
import { OllamaClient } from '../src/knowledge/local/ollama.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer } from './server-support.js';

const KEY = 'FAKE-gemini-key-for-tests-0123456789abcdef';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((t) => t.server.close())); vi.restoreAllMocks(); });

const ollamaFetch = async (input: URL | string, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }] }));
  if (url.endsWith('/api/embed')) return new Response(JSON.stringify({ embeddings: (JSON.parse(String(init!.body)).input as string[]).map(() => new Array(8).fill(0.1)) }));
  return new Response('{}', { status: 404 });
};

async function start(opts: { key?: string | null; geminiStatus?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-provs-'));
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json'));
  await store.init();
  const ollama = new OllamaClient({ url: 'http://127.0.0.1:11434', embedModel: 'nomic-embed-text', chatModel: 'llama3.2:3b', embedDimensions: 8, timeoutMs: 2000 }, ollamaFetch as unknown as typeof fetch);
  const gemini = new GeminiClient({ chatModel: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001', embedDimensions: 8, timeoutMs: 2000 }, opts.key === null ? undefined : (opts.key ?? KEY),
    (async () => new Response('{}', { status: opts.geminiStatus ?? 200 })) as unknown as typeof fetch);
  const chosen: string[] = [];
  const knowledge = new LocalKnowledge({ store, ollama, chatProviders: [ollama, gemini], inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: true, onChatProvider: (id) => chosen.push(id) });
  const t = await startTestServer({ mode: 'mock', knowledge, dir, channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))) });
  servers.push(t);
  return { t, chosen };
}
const call = (t: { base: string }, path: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(`${t.base}${path}`, { method: init.method, headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) }, body: init.json !== undefined ? JSON.stringify(init.json) : undefined });

describe('API de seleção de provedor', () => {
  it('é exclusiva do operador: músico 403, sem sessão 401', async () => {
    const { t } = await start();
    const musician = await t.login(MUSICIAN_PIN);
    expect((await call(t, '/api/knowledge/providers', musician)).status).toBe(403);
    expect((await call(t, '/api/knowledge/providers', musician, { method: 'POST', json: { chat: 'gemini', confirmExternal: true } })).status).toBe(403);
    expect((await fetch(`${t.base}/api/knowledge/providers`)).status).toBe(401);
    expect((await call(t, '/api/knowledge/providers', 'invalido')).status).toBe(401);
  });
  it('padrão Ollama; Gemini exige confirmação explícita; só então é escolhido', async () => {
    const { t, chosen } = await start();
    const op = await t.login(OPERATOR_PIN);
    const initial = await (await call(t, '/api/knowledge/providers', op)).json();
    expect(initial.chat.selected).toBe('ollama');
    expect(initial.chat.options).toEqual([{ id: 'ollama', external: false, configured: true }, { id: 'gemini', external: true, configured: true }]);

    const refused = await call(t, '/api/knowledge/providers', op, { method: 'POST', json: { chat: 'gemini' } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toMatch(/Confirme que aceita enviar/);
    expect(chosen).toEqual([]);

    const ok = await call(t, '/api/knowledge/providers', op, { method: 'POST', json: { chat: 'gemini', confirmExternal: true } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).chat.selected).toBe('gemini');
    expect(chosen).toEqual(['gemini']);
    expect((await (await call(t, '/api/knowledge/status', op)).json()).providers.chat.selected).toBe('gemini');

    const back = await call(t, '/api/knowledge/providers', op, { method: 'POST', json: { chat: 'ollama' } });
    expect((await back.json()).chat.selected).toBe('ollama');
  });
  it('sem chave ou com chave recusada a troca falha com mensagem curta', async () => {
    const noKey = await start({ key: null });
    const op1 = await noKey.t.login(OPERATOR_PIN);
    const r1 = await call(noKey.t, '/api/knowledge/providers', op1, { method: 'POST', json: { chat: 'gemini', confirmExternal: true } });
    expect(r1.status).toBe(400);
    expect((await r1.json()).message).toMatch(/Falta a chave do Gemini/);
    const denied = await start({ geminiStatus: 403 });
    const op2 = await denied.t.login(OPERATOR_PIN);
    const r2 = await call(denied.t, '/api/knowledge/providers', op2, { method: 'POST', json: { chat: 'gemini', confirmExternal: true } });
    expect((await r2.json()).message).toMatch(/recusou a chave/);
    expect((await (await call(denied.t, '/api/knowledge/providers', op2)).json()).chat.selected).toBe('ollama');
  });
  it('corpo estrito: campo extra (inclusive "apiKey"), provedor desconhecido e confirmação não booleana são recusados', async () => {
    const { t, chosen } = await start();
    const op = await t.login(OPERATOR_PIN);
    for (const json of [{ chat: 'gemini', confirmExternal: true, apiKey: KEY }, { chat: 'openai' }, { chat: 'gemini', confirmExternal: 'sim' }, {}, { chat: 'gemini', url: 'https://evil.example' }]) {
      const res = await call(t, '/api/knowledge/providers', op, { method: 'POST', json });
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(JSON.stringify(await res.json())).not.toContain(KEY);
    }
    expect(chosen).toEqual([]);
  });
  it('requisição de outra origem não troca o provedor (403)', async () => {
    const { t, chosen } = await start();
    const op = await t.login(OPERATOR_PIN);
    const res = await call(t, '/api/knowledge/providers', op, { method: 'POST', json: { chat: 'gemini', confirmExternal: true }, headers: { origin: 'https://site-malicioso.example' } });
    expect(res.status).toBe(403);
    expect(chosen).toEqual([]);
  });
  it('nenhuma resposta da API contém a chave', async () => {
    const { t } = await start();
    const op = await t.login(OPERATOR_PIN);
    await call(t, '/api/knowledge/providers', op, { method: 'POST', json: { chat: 'gemini', confirmExternal: true } });
    for (const path of ['/api/knowledge/providers', '/api/knowledge/status', '/api/knowledge/sources', '/api/knowledge/documents', '/api/knowledge/microphones', '/api/hello', '/api/state']) {
      const res = await call(t, path, op);
      const text = await res.text();
      expect(text, path).not.toContain(KEY);
      expect(text, path).not.toMatch(/AIza/);
    }
  });
});
