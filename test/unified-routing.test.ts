import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { OllamaClient } from '../src/knowledge/local/ollama.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { OPERATOR_PIN, startTestServer } from './server-support.js';

/**
 * Roteamento unificado de provedor/modelo por sessão. TUDO com provedores simulados: nenhuma chamada paga, nenhuma chave real,
 * nenhuma conexão com mesa física. Os fluxos consultados são o resumo documental (diagnóstico/RAG) e o planejador do AutoConfig.
 */
const KEYS = { openai: 'FAKE-openai-key-routing-0123456789', deepseek: 'FAKE-deepseek-key-routing-0123456789', anthropic: 'FAKE-anthropic-key-routing-0123456789', gemini: 'FAKE-gemini-key-routing-0123456789' };
const NARRATIVE = 'Pode ser que o ganho esteja alto; o operador pode conferir o posicionamento do microfone no palco.';
const PLAN = JSON.stringify({ kind: 'proposal', candidate: 's1', evidence: ['e1'] });
const M = ['future-model-one', 'future-model-two'];
const NO_PRICE = 'future-model-unpriced';
const DIAG = 'O Fred está microfonando no PA';
const PUBLIC_DOC = '# Microfonia\n\nA microfonia depende do ganho e do posicionamento do microfone no palco. Reduza o retorno do vocal para evitar a realimentação.';

type Mode = 'ok' | 'refuse' | 'down' | 'hold';
type Who = 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'ollama';
interface Call { who: Who; url: string; body: any; planner: boolean }

const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((t) => t.server.close())); vi.restoreAllMocks(); });

function whoOf(url: string): Who {
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('api.deepseek.com')) return 'deepseek';
  if (url.includes('api.anthropic.com')) return 'anthropic';
  if (url.includes('generativelanguage')) return 'gemini';
  return 'ollama';
}

async function lab(extra: { fallback?: 'ollama' | 'none'; catalogTimeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const modes: Partial<Record<Who, Mode>> = {};
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let heldStarted!: () => void;
  const held = new Promise<void>((r) => { heldStarted = r; });
  const net: typeof fetch = async (input, init) => {
    const url = String(input), who = whoOf(url), raw = init?.body ? String(init.body) : '';
    if (url.endsWith('/api/embed')) return Response.json({ embeddings: (JSON.parse(raw).input as string[]).map((tx) => { const v = new Array(8).fill(0.01); if (/microfonia|feedback/i.test(tx)) v[0] = 1; return v; }) });
    const body = raw ? JSON.parse(raw) : undefined;
    if (!body) { // metadados / saúde (sem prompt)
      if (who === 'ollama') return Response.json({ models: ['qwen3:8b', ...M, NO_PRICE].map((name) => ({ name })) });
      if (who === 'deepseek') return Response.json({ data: [...M, NO_PRICE].map((id) => ({ id })) });
      return Response.json({ id: url.split('/').at(-1) });
    }
    const planner = raw.includes('Você escolhe UMA inspeção');
    calls.push({ who, url, body, planner });
    const mode = modes[who] ?? 'ok';
    if (mode === 'hold') { heldStarted(); await gate; }
    if (mode === 'down') return new Response('{}', { status: 503 });
    const text = planner ? PLAN : NARRATIVE, model = body.model ?? 'm';
    if (who === 'openai') return Response.json(mode === 'refuse' ? { status: 'completed', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'x' }] }] }
      : { status: 'completed', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 80, output_tokens: 20 } });
    if (who === 'deepseek') return Response.json({ model, choices: [{ finish_reason: mode === 'refuse' ? 'content_filter' : 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 80, completion_tokens: 20 } });
    if (who === 'anthropic') return Response.json({ model, stop_reason: mode === 'refuse' ? 'refusal' : 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 80, output_tokens: 20 } });
    if (who === 'gemini') return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 80, totalTokenCount: 100 } });
    return Response.json({ model, done_reason: 'stop', message: { content: text }, prompt_eval_count: 80, eval_count: 20 }); // ollama
  };
  const dir = mkdtempSync(join(tmpdir(), 'mixai-routing-'));
  const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
  const ollama = new OllamaClient({ url: 'http://127.0.0.1:11434', chatModel: 'qwen3:8b', embedModel: 'nomic-embed-text', embedDimensions: 8, timeoutMs: 2000 }, net);
  const embeds: string[][] = [];
  const embed = ollama.embed.bind(ollama);
  ollama.embed = async (texts, kind) => { embeds.push(texts); return embed(texts, kind); };
  const knowledge = new LocalKnowledge({ store, ollama, chatProviders: [ollama], inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'),
    maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: true, ...(extra.fallback ? { externalFallback: extra.fallback } : {}) });
  await knowledge.importSeed(); mkdirSync(join(dir, 'inbox'), { recursive: true }); writeFileSync(join(dir, 'inbox', 'shure-live.md'), PUBLIC_DOC); await knowledge.ingest();
  const prices = Object.fromEntries(M.map((m) => [m, { inputPerMTok: 1, outputPerMTok: 2 }]));
  const providers = Object.fromEntries(['ollama', 'gemini', 'deepseek', 'anthropic', 'openai'].map((id) => [id, { enabled: true, models: id === 'ollama' ? ['qwen3:8b', ...M] : [...M, NO_PRICE], prices: id === 'ollama' ? {} : prices }]));
  const t = await startTestServer({ dir, knowledge, channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8'))),
    knowledgeConfig: { enabled: true, ollama: { narrative: true, chatModel: 'qwen3:8b' } },
    modelCatalog: { enabled: true, ...(extra.catalogTimeoutMs ? { timeoutMs: extra.catalogTimeoutMs } : {}), providers }, modelCatalogFetch: net, autoConfigPlannerFetch: net,
    openaiApiKey: KEYS.openai, geminiApiKey: KEYS.gemini, deepseekApiKey: KEYS.deepseek, aiKey: KEYS.anthropic }); servers.push(t);
  const op = await t.login(OPERATOR_PIN);
  const writes = vi.spyOn(t.mixer, 'write'), execute = vi.spyOn(t.server.core, 'execute');
  const before = t.controller.state.snapshot();
  const select = (provider: Who, model: string, token = op, revision?: number) => t.http('/api/ai/models/selection', { token, body: { schemaVersion: 1, provider, model, expectedRevision: revision ?? 0, confirmExternal: true } });
  const clear = (revision: number, token = op) => t.http('/api/ai/models/selection', { token, method: 'DELETE', body: { schemaVersion: 1, expectedRevision: revision } });
  const diagnose = async (token = op) => { const r = await t.http('/api/assistant/conversation', { token, body: { text: DIAG } }); return r.json.reply; };
  const m1 = async (token = op) => { const r = await t.http('/api/assistant/conversation', { token, body: { text: 'Fred está abafado só no retorno, também sozinho.' } }); expect(r.status).toBe(200); return r.json.reply; };
  const suggest = (token = op) => t.http('/api/autoconfig/suggestions', { token, body: { serverId: t.server.core.serverId, scope: 'AUX1' } });
  const answerAll = async (token = op) => { // M1 já traz destino; responde as perguntas até a proposta
    let r = await suggest(token);
    for (let i = 0; i < 6 && r.json.advice.kind === 'question'; i++) {
      const q = r.json.advice.question, value = q.field === 'comparison' ? 'target_only' : q.field === 'isolation' ? 'alone' : q.choices[0].value;
      r = await t.http('/api/autoconfig/suggestions', { token, body: { serverId: t.server.core.serverId, scope: 'AUX1', answer: { inputFingerprint: r.json.advice.inputFingerprint, value } } });
    }
    return r;
  };
  const untouched = () => { expect(writes).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(t.controller.state.snapshot()).toEqual(before); };
  const sent = (who: Who) => calls.filter((c) => c.who === who);
  return { t, op, calls, modes, select, clear, diagnose, m1, suggest, answerAll, untouched, sent, knowledge, embeds, release: () => open(), held };
}

describe('roteamento unificado: o modelo escolhido pelo operador é o que responde', () => {
  it('1. GPT (OpenAI) selecionado → o resumo do diagnóstico usa o GPT, com provedor e modelo registrados', async () => {
    const f = await lab();
    expect((await f.select('openai', M[0]!)).status).toBe(200);
    const reply = await f.diagnose();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'used', provider: 'openai', model: M[0] });
    expect(reply.knowledge.narrative).toMatchObject({ source: 'openai', model: M[0], verified: false });
    expect(f.sent('openai')).toHaveLength(1); expect(f.sent('openai')[0]!.body.model).toBe(M[0]);
    expect(f.sent('ollama')).toHaveLength(0); // o local não foi usado: o modelo escolhido respondeu
    const audit = f.t.server.app.log.recent(50).filter((e) => e.action === 'model_catalog_usage');
    expect(audit.at(-1)!.details).toMatchObject({ flow: 'knowledge', provider: 'openai', model: M[0] });
    expect(JSON.stringify(audit)).not.toContain(NARRATIVE); expect(JSON.stringify(audit)).not.toContain(KEYS.openai);
    f.untouched();
  });
  it('2. DeepSeek selecionado → o resumo documental (RAG) usa a DeepSeek e o modelo escolhido', async () => {
    const f = await lab();
    await f.select('deepseek', M[1]!);
    const reply = await f.diagnose();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'used', provider: 'deepseek', model: M[1] });
    expect(f.sent('deepseek')[0]!.body.model).toBe(M[1]);
    expect(f.sent('openai')).toHaveLength(0); expect(f.sent('anthropic')).toHaveLength(0); expect(f.sent('ollama')).toHaveLength(0);
    f.untouched();
  });
  it('3. Anthropic selecionada → o planejador do AutoConfig usa a Anthropic; o resultado continua não executável', async () => {
    const f = await lab();
    await f.m1();
    await f.select('anthropic', M[0]!);
    const r = await f.answerAll();
    expect(r.status).toBe(200);
    expect(r.json.advice.provider.used).toBe('anthropic');
    expect(r.json.model).toMatchObject({ selected: 'anthropic', used: 'anthropic', external: true });
    expect(r.json.advice).toMatchObject({ authorization: 'not_granted', execution: 'not_executable', realWrites: false });
    expect(r.json.proposal.items[0].deltaDB).toBeUndefined();
    const call = f.sent('anthropic').find((c) => c.planner)!;
    expect(call.body.model).toBe(M[0]);
    expect(f.sent('gemini')).toHaveLength(0); // nenhum cliente legado paralelo
    const audit = f.t.server.app.log.recent(80).filter((e) => e.action === 'model_catalog_usage');
    expect(audit.some((e) => (e.details as any).flow === 'autoconfig' && (e.details as any).provider === 'anthropic')).toBe(true);
    f.untouched();
  });
  it('11. Ollama local selecionado no catálogo → funciona sem nenhuma API externa', async () => {
    const f = await lab();
    await f.select('ollama', M[0]!);
    const reply = await f.diagnose();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', model: M[0] });
    for (const who of ['openai', 'deepseek', 'anthropic', 'gemini'] as const) expect(f.sent(who)).toHaveLength(0);
    f.untouched();
  });
  it('11b. sem seleção no catálogo, o caminho anterior (Ollama configurado) permanece idêntico', async () => {
    const f = await lab();
    await f.m1();
    const r = await f.answerAll(); expect(r.json.advice.provider.used).toMatch(/ollama|deterministic/);
    const reply = await f.diagnose();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', model: 'qwen3:8b' });
    expect(f.sent('ollama').some((c) => c.body.model === 'qwen3:8b')).toBe(true);
    for (const who of ['openai', 'deepseek', 'anthropic', 'gemini'] as const) expect(f.sent(who)).toHaveLength(0);
    f.untouched();
  });
});

describe('troca, revogação, logout e isolamento', () => {
  it('4. troca de modelo durante a operação → a resposta do modelo antigo é descartada e nada dela aparece', async () => {
    const f = await lab(); f.modes.openai = 'hold';
    await f.select('openai', M[0]!);
    const pending = f.diagnose(); await f.held;
    expect((await f.select('deepseek', M[1]!, f.op, 1)).status).toBe(200);
    f.release();
    const reply = await pending;
    expect(reply.knowledge.narrative).toBeUndefined();
    expect(reply.knowledge).toMatchObject({ degraded: true, narrativeStatus: { status: 'not_consented' } });
    expect(JSON.stringify(reply)).not.toContain(NARRATIVE);
    f.modes.openai = 'ok';
    const next = await f.diagnose(); // a próxima consulta usa o novo modelo, sem reaproveitar a anterior
    expect(next.knowledge.narrativeStatus).toMatchObject({ status: 'used', provider: 'deepseek', model: M[1] });
    expect(f.sent('openai')).toHaveLength(1);
    f.untouched();
  });
  it('5. revogação (limpar a seleção) → nenhum novo envio externo; o caminho local segue', async () => {
    const f = await lab();
    await f.m1(); await f.select('openai', M[0]!);
    expect((await f.answerAll()).json.advice.provider.used).toBe('openai');
    const sentBefore = f.sent('openai').length;
    expect((await f.clear(1)).status).toBe(200);
    const r = await f.answerAll(); expect(r.json.advice.provider.used).not.toBe('openai');
    const reply = await f.diagnose();
    expect(f.sent('openai')).toHaveLength(sentBefore); // nada novo saiu depois da revogação
    expect(reply.knowledge.narrativeStatus).toMatchObject({ provider: 'ollama' });
    f.untouched();
  });
  it('4b. AutoConfig: troca de modelo ou revogação durante a consulta → resposta antiga descartada, sem proposta', async () => {
    for (const change of ['switch', 'clear', 'logout'] as const) {
      const f = await lab(); await f.m1(); f.modes.anthropic = 'hold';
      await f.select('anthropic', M[0]!);
      const pending = f.suggest(); // o relato do M1 já traz canal, destino, comparação e isolamento: a primeira consulta chega ao modelo
      await f.held;
      if (change === 'switch') await f.select('deepseek', M[1]!, f.op, 1);
      if (change === 'clear') await f.clear(1);
      if (change === 'logout') await f.t.http('/api/logout', { token: f.op, body: {} });
      f.release();
      const done = await pending;
      expect([200, 401, 409]).toContain(done.status);
      expect(JSON.stringify(done.json)).not.toContain('"items"');
      if (done.status === 200) expect(done.json.advice).toMatchObject({ kind: 'refusal', reason: 'stale_policy' });
      f.untouched();
    }
  }, 30_000);
  it('5b. revogação durante o envio → resposta descartada, no resumo e no AutoConfig', async () => {
    const f = await lab(); f.modes.openai = 'hold';
    await f.select('openai', M[0]!);
    const pending = f.diagnose(); await f.held;
    await f.clear(1); f.release();
    const reply = await pending;
    expect(reply.knowledge.narrative).toBeUndefined(); expect(JSON.stringify(reply)).not.toContain(NARRATIVE);
    f.untouched();
  });
  it('6. logout → o consentimento é revogado; a resposta tardia não chega e uma nova sessão não herda nada', async () => {
    const f = await lab(); f.modes.openai = 'hold';
    await f.select('openai', M[0]!);
    const pending = f.diagnose(); await f.held;
    await f.t.http('/api/logout', { token: f.op, body: {} });
    f.release(); await pending.catch(() => undefined);
    f.modes.openai = 'ok';
    const again = await f.t.login(OPERATOR_PIN);
    expect((await f.t.http('/api/ai/models', { token: again })).json.selection).toBeNull();
    const before = f.sent('openai').length;
    const reply = await f.diagnose(again);
    expect(f.sent('openai')).toHaveLength(before); // sessão nova: nenhum envio externo
    expect(reply.knowledge.narrativeStatus).toMatchObject({ provider: 'ollama' });
    f.untouched();
  });
  it('7. duas sessões simultâneas → cada uma usa o seu modelo; limpar uma não afeta a outra', async () => {
    const f = await lab(), other = await f.t.login(OPERATOR_PIN);
    await f.select('openai', M[0]!); await f.select('deepseek', M[1]!, other);
    const [a, b] = await Promise.all([f.diagnose(), f.diagnose(other)]);
    expect(a.knowledge.narrativeStatus).toMatchObject({ provider: 'openai', model: M[0] });
    expect(b.knowledge.narrativeStatus).toMatchObject({ provider: 'deepseek', model: M[1] });
    await f.clear(1, other);
    const a2 = await f.diagnose();
    expect(a2.knowledge.narrativeStatus).toMatchObject({ provider: 'openai', model: M[0] });
    const b2 = await f.diagnose(other);
    expect(b2.knowledge.narrativeStatus).toMatchObject({ provider: 'ollama' });
    expect(f.sent('deepseek')).toHaveLength(1); expect(f.sent('anthropic')).toHaveLength(0);
    f.untouched();
  });
});

describe('falhas, preço, recusa e prazo', () => {
  it('8. modelo indisponível → reserva local (política ollama), nunca outro serviço externo', async () => {
    const f = await lab(); f.modes.openai = 'down';
    await f.select('openai', M[0]!);
    const reply = await f.diagnose();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', fellBackFrom: 'openai', fallbackReason: 'unavailable' });
    expect(f.sent('deepseek')).toHaveLength(0); expect(f.sent('anthropic')).toHaveLength(0); expect(f.sent('gemini')).toHaveLength(0);
    f.untouched();
  });
  it('8b. política sem reserva (none) → nenhum resumo; o motor determinístico segue sozinho', async () => {
    const f = await lab({ fallback: 'none' }); f.modes.openai = 'down';
    await f.select('openai', M[0]!);
    const reply = await f.diagnose();
    expect(reply.knowledge.narrative).toBeUndefined();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'unavailable', provider: 'openai' });
    expect(f.sent('ollama')).toHaveLength(0);
  });
  it('9. preço desconhecido → a chamada paga é bloqueada antes de sair (resumo e AutoConfig)', async () => {
    const f = await lab();
    expect((await f.select('openai', NO_PRICE)).status).toBe(200);
    await f.m1();
    const r = await f.answerAll(); expect(f.sent('openai')).toHaveLength(0); expect(r.json.advice.provider.used).not.toBe('openai');
    const reply = await f.diagnose();
    expect(f.sent('openai')).toHaveLength(0);
    expect(reply.knowledge.narrativeStatus).toMatchObject({ provider: 'ollama', fellBackFrom: 'openai', fallbackReason: 'quota' });
    f.untouched();
  });
  it('10. recusa de segurança → nenhum fallback (nem local nem externo), no resumo e no AutoConfig', async () => {
    const f = await lab(); f.modes.openai = 'refuse';
    await f.select('openai', M[0]!);
    await f.m1();
    const r = await f.answerAll();
    expect(r.json.advice).toMatchObject({ kind: 'refusal', reason: 'provider_refused' }); expect(r.json.proposal).toBeNull();
    const reply = await f.diagnose();
    expect(reply.knowledge.narrative).toBeUndefined();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'refused', provider: 'openai' });
    expect(f.sent('ollama')).toHaveLength(0); expect(f.sent('deepseek')).toHaveLength(0);
    f.untouched();
  });
  it('14. estouro de prazo → resposta degradada identificando o provedor que de fato respondeu', async () => {
    const f = await lab({ catalogTimeoutMs: 1000 }); f.modes.openai = 'hold';
    await f.select('openai', M[0]!);
    const reply = await f.diagnose();
    f.release();
    expect(reply.knowledge.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', fellBackFrom: 'openai', fallbackReason: 'timeout' });
    expect(reply.knowledge.narrative.source).toBe('ollama');
    f.untouched();
  });
});

describe('embeddings independentes e contratos', () => {
  it('12. trocar o modelo de conversa não altera o embedder nem reindexa a base', async () => {
    const f = await lab();
    const before = f.knowledge.providers().embed, docs = (await f.knowledge.status()).chunks;
    await f.select('openai', M[0]!); await f.diagnose(); await f.select('deepseek', M[1]!, f.op, 1); await f.diagnose();
    expect(f.knowledge.providers().embed).toEqual(before);
    expect((await f.knowledge.status()).chunks).toEqual(docs);
    for (const who of ['openai', 'deepseek'] as const) for (const c of f.sent(who)) expect(JSON.stringify(c.url + JSON.stringify(c.body))).not.toMatch(/embed/i);
    f.untouched();
  });
  it('só o operador usa o roteamento: músico não seleciona nem recebe resumo externo', async () => {
    const f = await lab();
    const musician = await f.t.login((await import('./server-support.js')).MUSICIAN_PIN);
    expect((await f.select('openai', M[0]!, musician)).status).toBe(403);
    expect(f.sent('openai')).toHaveLength(0);
  });
});
