import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { GEMINI_API_BASE, GeminiClient } from '../src/knowledge/local/gemini.js';
import { OllamaClient } from '../src/knowledge/local/ollama.js';
import { openLocalKnowledge } from '../src/knowledge/local/open.js';
import { readChatPreference, writeChatPreference } from '../src/knowledge/local/preference.js';
import type { SqlClient } from '../src/knowledge/local/pg-store.js';
import { isPublicSource, redactForExternal } from '../src/knowledge/local/privacy.js';
import { judgeNarrative, KnowledgeError, LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';

const SEED = join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2');
const tmp = () => mkdtempSync(join(tmpdir(), 'mixai-prov-'));
const KEY = 'FAKE-gemini-key-for-tests-0123456789abcdef';
const GOOD = 'Pode ser que o ganho esteja alto; o operador pode conferir o posicionamento do microfone.';
const DIMS = 8;
const OLLAMA_OPTS = { url: 'http://127.0.0.1:11434', embedModel: 'nomic-embed-text', chatModel: 'llama3.2:3b', embedDimensions: DIMS, timeoutMs: 2000 };
const GEMINI_OPTS = { chatModel: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001', embedDimensions: DIMS, timeoutMs: 2000 };

interface Call { url: string; method: string; headers: Record<string, string>; body: string; init: RequestInit }
type Reply = { status?: number; json?: unknown; text?: string; throws?: Error };

/** Gemini falso: registra TUDO que seria enviado e responde conforme o roteiro. */
function fakeGemini(script: { chat?: Reply | (() => Reply); embed?: Reply; health?: Reply } = {}) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: String(init.body ?? ''), init });
    const pick = (r: Reply) => {
      if (r.throws) throw r.throws;
      return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
    };
    if (url.includes(':generateContent')) {
      const c = script.chat ?? { json: { candidates: [{ content: { parts: [{ text: GOOD }] }, finishReason: 'STOP' }] } };
      return pick(typeof c === 'function' ? c() : c);
    }
    if (url.includes(':batchEmbedContents')) {
      const body = JSON.parse(String(init.body)) as { requests: unknown[] };
      return pick(script.embed ?? { json: { embeddings: body.requests.map(() => ({ values: new Array(DIMS).fill(0.5) })) } });
    }
    return pick(script.health ?? { json: { name: 'models/x' } });
  });
  return { fetchFn, calls, /** key = null → cliente SEM chave (undefined usaria o padrão do parâmetro). */
    client: (key: string | null = KEY) => new GeminiClient(GEMINI_OPTS, key ?? undefined, fetchFn as unknown as typeof fetch) };
}

/** Ollama falso mínimo (embeddings e chat). */
function fakeOllama(opts: { up?: boolean; chat?: string; spy?: (body: unknown) => void } = {}) {
  const { up = true, chat = 'Pode ser o cabo; o operador pode conferir a ligação do microfone no palco.' } = opts;
  const fetchFn = async (input: URL | string, init?: RequestInit) => {
    if (!up) throw new TypeError('ECONNREFUSED');
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }] }));
    if (url.endsWith('/api/embed')) return new Response(JSON.stringify({ embeddings: (body.input as string[]).map((t) => { const v = new Array(DIMS).fill(0.01); if (/microfonia|feedback/i.test(t)) v[0] = 1; return v; }) }));
    if (url.endsWith('/api/chat')) { opts.spy?.(body); return new Response(JSON.stringify({ message: { content: chat } })); }
    return new Response('{}', { status: 404 });
  };
  return new OllamaClient(OLLAMA_OPTS, fetchFn as unknown as typeof fetch);
}

const PUBLIC_DOC = '# Microfonia\n\nA microfonia depende do ganho e do posicionamento do microfone no palco. Reduza o retorno do vocal para evitar a realimentação.';
const PRIVATE_DOC = '# Roteiro\n\nSEGREDO-DA-BANDA: a microfonia no palco do evento privado depende do contrato e do cachê combinado.';

async function service(opts: { ollama?: OllamaClient; gemini?: GeminiClient; chat?: 'ollama' | 'gemini'; narrative?: boolean; log?: (m: string) => void; docs?: Record<string, string>; onChat?: (id: string) => void } = {}) {
  const dir = tmp();
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json'));
  await store.init();
  const ollama = opts.ollama ?? fakeOllama();
  const k = new LocalKnowledge({
    store, ollama, chatProviders: [ollama, ...(opts.gemini ? [opts.gemini] : [])], chat: opts.chat,
    inboxDir: join(dir, 'inbox'), seedDir: SEED, maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: opts.narrative ?? true, log: opts.log, onChatProvider: opts.onChat,
  });
  await k.importSeed();
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  for (const [name, text] of Object.entries(opts.docs ?? { 'shure-live.md': PUBLIC_DOC })) writeFileSync(join(dir, 'inbox', name), text);
  await k.ingest();
  return { k, dir, store };
}
const ask = (k: LocalKnowledge, text = 'O Fred está microfonando no PA') => k.enrich({ text, symptom: 'microfonia' });
const generateCalls = (calls: Call[]) => calls.filter((c) => c.url.includes(':generateContent'));

describe('GeminiClient: segredo, rede e erros', () => {
  it('sem chave não faz nenhuma chamada de rede e informa o motivo', async () => {
    const g = fakeGemini();
    const c = g.client(null);
    expect(c.configured).toBe(false);
    expect(await c.health()).toMatchObject({ reachable: false, detail: 'Gemini sem chave configurada' });
    expect(await c.embed(['x'], 'query')).toBeUndefined();
    expect(await c.generateDetailed('s', 'u')).toEqual({ failure: 'auth' });
    expect(g.fetchFn).not.toHaveBeenCalled();
  });
  it('a chave vai SÓ no cabeçalho; URL, corpo e host são fixos', async () => {
    const g = fakeGemini();
    const c = g.client();
    await c.generateDetailed('instrução', 'pergunta');
    await c.embed(['trecho'], 'document');
    await c.health(true);
    expect(g.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of g.calls) {
      expect(call.url.startsWith(GEMINI_API_BASE)).toBe(true);
      expect(new URL(call.url).hostname).toBe('generativelanguage.googleapis.com');
      expect(call.url).not.toContain(KEY);
      expect(call.url).not.toMatch(/[?&]key=/);
      expect(call.body).not.toContain(KEY);
      expect(call.headers['x-goog-api-key']).toBe(KEY);
      expect(call.init.redirect).toBe('error');
      expect(call.init.credentials).toBe('omit');
    }
  });
  it('nome de modelo malicioso é recusado (não vira caminho de URL)', () => {
    for (const bad of ['../x', 'm?key=1', 'a b', 'm/../../o', '', 'x']) expect(() => new GeminiClient({ ...GEMINI_OPTS, chatModel: bad }, KEY), bad).toThrow(/modelo/i);
  });
  it('generateContent: corpo com instrução e pergunta, texto extraído', async () => {
    const g = fakeGemini();
    const r = await g.client().generateDetailed('SISTEMA', 'USUARIO');
    expect(r).toEqual({ text: GOOD });
    const body = JSON.parse(generateCalls(g.calls)[0]!.body);
    expect(body.systemInstruction.parts[0].text).toBe('SISTEMA');
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'USUARIO' }] });
    expect(body.generationConfig.temperature).toBeLessThanOrEqual(0.3);
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'systemInstruction']); // sem ferramentas/funções
  });
  it.each([
    [{ status: 401 }, 'auth'], [{ status: 403 }, 'auth'], [{ status: 429 }, 'quota'], [{ status: 400 }, 'error'], [{ status: 404 }, 'error'], [{ status: 503 }, 'error'],
    [{ throws: new TypeError('fetch failed') }, 'unavailable'], [{ throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 'timeout'],
    [{ json: { promptFeedback: { blockReason: 'SAFETY' } } }, 'refused'], [{ json: { candidates: [{ finishReason: 'SAFETY' }] } }, 'refused'],
    [{ json: { candidates: [] } }, 'empty'], [{ json: { candidates: [{ content: { parts: [{ text: '  ' }] } }] } }, 'empty'],
  ] as Array<[Reply, string]>)('erro %j vira o código "%s" sem vazar o corpo do servidor', async (reply, failure) => {
    const g = fakeGemini({ chat: { ...reply, text: reply.status ? 'detalhe-interno-segredo-do-servidor' : undefined } });
    const r = await g.client().generateDetailed('s', 'u');
    expect(r.failure).toBe(failure);
    expect(JSON.stringify(r)).not.toMatch(/segredo|AIza/);
  });
  it('resposta que não é JSON não derruba: vira falha', async () => {
    const r = await fakeGemini({ chat: { text: '<html>erro</html>' } }).client().generateDetailed('s', 'u');
    expect(r.failure).toBeDefined();
    expect(r.text).toBeUndefined();
  });
  describe('resposta incompleta (regressão: finishReason=MAX_TOKENS)', () => {
    const partial = (finishReason: string, text = 'Pode ser que o ganho esteja alto e o') => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason }] } });
    it('MAX_TOKENS NÃO é resposta concluída, mesmo com texto parcial', async () => {
      const r = await fakeGemini({ chat: partial('MAX_TOKENS') }).client().generateDetailed('s', 'u');
      expect(r).toEqual({ failure: 'truncated' });
      expect(r.text).toBeUndefined();
    });
    it('motivo de parada desconhecido também não conta como concluído; STOP e ausência contam', async () => {
      expect((await fakeGemini({ chat: partial('OTHER') }).client().generateDetailed('s', 'u')).failure).toBe('error');
      expect((await fakeGemini({ chat: partial('MALFORMED_FUNCTION_CALL') }).client().generateDetailed('s', 'u')).failure).toBe('error');
      expect((await fakeGemini({ chat: partial('STOP', GOOD) }).client().generateDetailed('s', 'u')).text).toBe(GOOD);
      expect((await fakeGemini({ chat: { json: { candidates: [{ content: { parts: [{ text: GOOD }] } }] } } }).client().generateDetailed('s', 'u')).text).toBe(GOOD);
    });
    it('partes de raciocínio (thought) nunca entram no texto', async () => {
      const chat = { json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'RACIOCINIO-INTERNO', thought: true }, { text: GOOD }] } }] } };
      expect((await fakeGemini({ chat }).client().generateDetailed('s', 'u')).text).toBe(GOOD);
    });
    it('o teto de tokens padrão comporta o raciocínio e o nível de raciocínio vai no corpo', async () => {
      const g = fakeGemini();
      await g.client().generateDetailed('s', 'u');
      const gc = JSON.parse(generateCalls(g.calls)[0]!.body).generationConfig;
      expect(gc.maxOutputTokens).toBe(2048); // 320 deixava ~10 tokens de texto nos modelos Gemini 3
      expect(gc.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    });
    it('"default" não envia thinkingConfig; teto e nível vêm da configuração', async () => {
      const g = fakeGemini();
      const mk = (extra: object) => new GeminiClient({ ...GEMINI_OPTS, ...extra }, KEY, g.fetchFn as unknown as typeof fetch);
      await mk({ thinkingLevel: 'default', maxOutputTokens: 4096 }).generateDetailed('s', 'u');
      await mk({ thinkingLevel: 'medium', maxOutputTokens: 512 }).generateDetailed('s', 'u');
      const [a, b] = generateCalls(g.calls).map((c) => JSON.parse(c.body).generationConfig);
      expect(a.thinkingConfig).toBeUndefined();
      expect(a.maxOutputTokens).toBe(4096);
      expect(b).toMatchObject({ thinkingConfig: { thinkingLevel: 'medium' }, maxOutputTokens: 512 });
    });
    it('a configuração rejeita teto e nível inválidos e usa os padrões novos', () => {
      const ok = parseConfig({ knowledge: { gemini: {} } }).knowledge.gemini;
      expect(ok).toMatchObject({ chatModel: 'gemini-3.8-flash', maxOutputTokens: 2048, thinkingLevel: 'low' });
      expect(() => parseConfig({ knowledge: { gemini: { maxOutputTokens: 10 } } })).toThrow();
      expect(() => parseConfig({ knowledge: { gemini: { thinkingLevel: 'ultra' } } })).toThrow();
    });
    it('Ollama: done_reason "length" também é resposta incompleta', async () => {
      const fetchFn = async (input: URL | string) => {
        const u = String(input);
        if (u.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }] }));
        return new Response(JSON.stringify({ message: { content: 'Pode ser o cabo e a' }, done_reason: 'length' }));
      };
      const r = await new OllamaClient(OLLAMA_OPTS, fetchFn as unknown as typeof fetch).generateDetailed('s', 'u');
      expect(r).toEqual({ failure: 'truncated' });
    });
    it('no serviço: resposta cortada do Gemini é descartada, registrada só com o motivo, e o Ollama assume', async () => {
      const logs: string[] = [];
      const g = fakeGemini({ chat: partial('MAX_TOKENS') });
      const { k } = await service({ gemini: g.client(), chat: 'gemini', log: (m) => logs.push(m) });
      const ctx = await ask(k);
      expect(generateCalls(g.calls)).toHaveLength(1);
      expect(ctx.narrative?.source).toBe('ollama');
      expect(ctx.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', fellBackFrom: 'gemini', fallbackReason: 'truncated' });
      const line = logs.find((l) => /truncated/.test(l))!;
      expect(line).toMatch(/motivo=truncated:max_tokens, provedor=gemini/);
      expect(logs.join('\n')).not.toMatch(/ganho esteja alto/); // o texto parcial não vai para o log
    });
    it('sem reserva local, o texto parcial nunca é exibido', async () => {
      const g = fakeGemini({ chat: partial('MAX_TOKENS') });
      const dir = tmp();
      const store = new FileKnowledgeStore(join(dir, 'knowledge.json'));
      await store.init();
      const k = new LocalKnowledge({ store, chatProviders: [g.client()], chat: 'gemini', inboxDir: join(dir, 'inbox'), seedDir: SEED, maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: true });
      await k.importSeed();
      mkdirSync(join(dir, 'inbox'), { recursive: true });
      writeFileSync(join(dir, 'inbox', 'shure-live.md'), PUBLIC_DOC);
      await k.ingest();
      const ctx = await ask(k);
      expect(ctx.narrative).toBeUndefined();
      expect(ctx.narrativeStatus).toMatchObject({ status: 'truncated', rule: 'max_tokens', provider: 'gemini' });
    });
  });
  describe('judgeNarrative: limite de exibição sem cortar no meio da frase', () => {
    const sentence = 'Pode ser que o posicionamento do microfone esteja afastado da boca. ';
    it('acima de 700 caracteres corta na última frase completa', () => {
      const v = judgeNarrative(sentence.repeat(20), [{ excerpt: 'outro assunto' }]);
      expect('text' in v).toBe(true);
      const text = (v as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(700);
      expect(text.endsWith('.')).toBe(true);
    });
    it('sem nenhum ponto final aproveitável, não exibe um pedaço de frase', () => {
      expect(judgeNarrative('pode ser que o posicionamento do microfone esteja afastado '.repeat(20), [{ excerpt: 'x' }])).toEqual({ status: 'truncated', rule: 'acima_do_limite' });
    });
    it('texto curto passa inteiro', () => {
      expect(judgeNarrative(GOOD, [{ excerpt: 'x' }])).toEqual({ text: GOOD });
    });
  });
  it('embeddings: tipo de tarefa, dimensão pedida, normalização e lotes de 50', async () => {
    const g = fakeGemini();
    const c = g.client();
    const q = await c.embed(['pergunta'], 'query');
    expect(JSON.parse(g.calls.at(-1)!.body).requests[0]).toMatchObject({ taskType: 'RETRIEVAL_QUERY', outputDimensionality: DIMS, model: 'models/gemini-embedding-001' });
    expect(Math.hypot(...q![0]!)).toBeCloseTo(1, 6);
    const docs = await c.embed(Array.from({ length: 120 }, (_, i) => `trecho ${i}`), 'document');
    expect(docs).toHaveLength(120);
    const batches = g.calls.filter((x) => x.url.includes(':batchEmbedContents')).slice(1);
    expect(batches).toHaveLength(3);
    expect(JSON.parse(batches[0]!.body).requests[0].taskType).toBe('RETRIEVAL_DOCUMENT');
  });
  it('embeddings com dimensão errada, NaN ou erro HTTP viram undefined', async () => {
    expect(await fakeGemini({ embed: { json: { embeddings: [{ values: [1, 2, 3] }] } } }).client().embed(['x'])).toBeUndefined();
    expect(await fakeGemini({ embed: { json: { embeddings: [{ values: new Array(DIMS).fill('a') }] } } }).client().embed(['x'])).toBeUndefined();
    expect(await fakeGemini({ embed: { status: 429 } }).client().embed(['x'])).toBeUndefined();
    expect(await fakeGemini({ embed: { json: { embeddings: [] } } }).client().embed(['x'])).toBeUndefined();
  });
  it('health: chave recusada ≠ indisponível; resultado fica em cache por 60 s e force ignora o cache', async () => {
    const bad = fakeGemini({ health: { status: 403 } });
    expect(await bad.client().health()).toMatchObject({ reachable: false, chatModel: false, detail: 'Gemini recusou a chave' });
    const down = fakeGemini({ health: { throws: new TypeError('fetch failed') } });
    expect(await down.client().health()).toMatchObject({ reachable: false, detail: 'Gemini indisponível' });
    const ok = fakeGemini();
    let now = 1_000_000;
    const c = new GeminiClient(GEMINI_OPTS, KEY, ok.fetchFn as unknown as typeof fetch, () => now);
    expect(await c.health()).toMatchObject({ reachable: true, chatModel: true, embedModel: true });
    const n = ok.calls.length;
    await c.health();
    expect(ok.calls.length).toBe(n);
    now += 61_000;
    await c.health();
    expect(ok.calls.length).toBeGreaterThan(n);
    const m = ok.calls.length;
    await c.health(true);
    expect(ok.calls.length).toBeGreaterThan(m);
  });
});

describe('privacidade para provedor externo', () => {
  it('remove PIN, token, caminho, e-mail, IP, link e nomes de pessoas; preserva a pergunta técnica', () => {
    const out = redactForExternal('O Fred disse senha 987654 token AbCdEf0123456789XyZ_-9876 em C:\\Users\\Fernando\\x.txt, fred@banda.com 192.168.1.14 https://x.io/a?k=1 e a voz do Lucius está abafada', ['Fred', 'Lucius']);
    expect(out).toContain('o músico disse senha [número]');
    expect(out).toContain('[código]');
    expect(out).toContain('[caminho]');
    expect(out).toContain('[email]');
    expect(out).toContain('[ip]');
    expect(out).toContain('[link]');
    expect(out).toContain('a voz do o músico está abafada');
    expect(out).not.toMatch(/Fred|Lucius|987654|AbCdEf|Fernando|banda\.com|192\.168|x\.io/);
    expect(redactForExternal('Minha voz está abafada no retorno AUX 1.')).toBe('Minha voz está abafada no retorno AUX 1.');
    expect(redactForExternal('x'.repeat(500), [], 200)).toHaveLength(200);
    expect(redactForExternal('Fredericoso e Fred', ['Fred'])).toBe('Fredericoso e o músico'); // palavra inteira, não pedaço
  });
  it('só fonte pública (https de verdade) pode ser citada a um serviço externo', () => {
    expect(isPublicSource({ url: 'https://br.akg.com/P3.html' })).toBe(true);
    for (const bad of [undefined, {}, { url: '' }, { url: 'http://br.akg.com/x' }, { url: 'https://local.invalid/documento-local' }, { url: 'https://a.invalid/x' }, { url: 'https://u:p@x.com/' }, { url: 'não é url' }, { url: 'https://x.com', local: true }]) expect(isPublicSource(bad as never), JSON.stringify(bad)).toBe(false);
  });
});

describe('seleção de provedor', () => {
  it('padrão é Ollama; sem Gemini habilitado ele nem aparece e não pode ser escolhido', async () => {
    const { k } = await service();
    expect(k.providers()).toEqual({ chat: { selected: 'ollama', options: [{ id: 'ollama', external: false, configured: true }] }, embed: { id: 'ollama', external: false }, narrative: true });
    await expect(k.setChatProvider('gemini', true)).rejects.toThrow(/não está habilitado/);
    expect((await k.status()).providers.chat.selected).toBe('ollama');
  });
  it('Gemini exige confirmação, chave e resposta do serviço; só então vira o escolhido e a escolha é persistida', async () => {
    const chosen: string[] = [];
    const g = fakeGemini();
    const { k } = await service({ gemini: g.client(), onChat: (id) => chosen.push(id) });
    expect(k.providers().chat.options).toEqual([{ id: 'ollama', external: false, configured: true }, { id: 'gemini', external: true, configured: true }]);
    await expect(k.setChatProvider('gemini')).rejects.toThrow(/Confirme que aceita enviar/);
    expect(g.fetchFn).not.toHaveBeenCalled(); // sem confirmação nada sai
    expect((await k.setChatProvider('gemini', true)).chat.selected).toBe('gemini');
    expect(chosen).toEqual(['gemini']);
    expect((await k.setChatProvider('ollama')).chat.selected).toBe('ollama');
    expect(chosen).toEqual(['gemini', 'ollama']);
  });
  it('sem chave, chave recusada ou serviço fora: a troca é recusada com mensagem clara', async () => {
    const noKey = await service({ gemini: fakeGemini().client(null) });
    await expect(noKey.k.setChatProvider('gemini', true)).rejects.toThrow(/Falta a chave do Gemini/);
    const denied = await service({ gemini: fakeGemini({ health: { status: 403 } }).client() });
    await expect(denied.k.setChatProvider('gemini', true)).rejects.toThrow(/recusou a chave/);
    const down = await service({ gemini: fakeGemini({ health: { throws: new TypeError('x') } }).client() });
    await expect(down.k.setChatProvider('gemini', true)).rejects.toThrow(/não respondeu agora/);
    for (const t of [noKey, denied, down]) expect(t.k.providers().chat.selected).toBe('ollama');
    await expect(noKey.k.setChatProvider('gemini', true)).rejects.toBeInstanceOf(KnowledgeError);
  });
  it('com o Gemini escolhido o resumo vem dele e é marcado com a origem', async () => {
    const g = fakeGemini();
    const { k } = await service({ gemini: g.client(), chat: 'gemini' });
    const r = await ask(k);
    expect(r.narrative).toMatchObject({ text: GOOD, source: 'gemini', verified: false });
    expect(r.narrativeStatus).toMatchObject({ status: 'used', provider: 'gemini' });
    expect((await k.status()).narrativeStats.usedBy).toEqual({ gemini: 1 });
  });
});

describe('o que sai do computador', () => {
  it('só trechos de fonte pública e a pergunta sem nomes nem números; documento local nunca sai', async () => {
    const g = fakeGemini();
    const { k } = await service({ gemini: g.client(), chat: 'gemini', docs: { 'shure-live.md': PUBLIC_DOC, 'roteiro-privado.md': PRIVATE_DOC } });
    const r = await ask(k, 'O Fred está microfonando no PA, senha 987654 em C:\\Users\\Fernando\\x');
    expect(r.passages.some((p) => /SEGREDO-DA-BANDA/.test(p.excerpt))).toBe(true); // o local aparece NA TELA do operador...
    const sent = generateCalls(g.calls).map((c) => c.body).join('\n');
    expect(sent).toContain('microfonia'); // ...mas o que foi ao Gemini é só o público
    expect(sent).not.toContain('SEGREDO-DA-BANDA');
    expect(sent).not.toContain('contrato');
    expect(sent).not.toMatch(/Fred|987654|Fernando|C:/);
    expect(sent).toContain('o músico');
    expect(sent).not.toContain(KEY);
  });
  it('só documento local para citar: nada é enviado, vira "withheld" e o Ollama local assume', async () => {
    const g = fakeGemini();
    const { k } = await service({ gemini: g.client(), chat: 'gemini', docs: { 'roteiro-privado.md': PRIVATE_DOC } });
    const r = await ask(k);
    expect(generateCalls(g.calls)).toHaveLength(0);
    expect(r.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', fellBackFrom: 'gemini', fallbackReason: 'withheld' });
    expect(r.narrative!.source).toBe('ollama');
  });
  it('embeddings externos: documento local é ignorado e o do catálogo vai como RETRIEVAL_DOCUMENT', async () => {
    const g = fakeGemini();
    const dir = tmp();
    const store = new FileKnowledgeStore(join(dir, 'k.json'));
    await store.init();
    const gem = g.client();
    const k = new LocalKnowledge({ store, ollama: gem, chatProviders: [gem], inboxDir: join(dir, 'inbox'), seedDir: SEED, maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
    await k.importSeed();
    mkdirSync(join(dir, 'inbox'), { recursive: true });
    writeFileSync(join(dir, 'inbox', 'shure-live.md'), PUBLIC_DOC);
    writeFileSync(join(dir, 'inbox', 'roteiro-privado.md'), PRIVATE_DOC);
    const report = await k.ingest();
    expect(report.items.find((i) => i.file === 'roteiro-privado.md')).toMatchObject({ status: 'skipped', reason: 'documento local não é enviado a provedor externo' });
    expect(report.items.find((i) => i.file === 'shure-live.md')!.status).toBe('ingested');
    const all = g.calls.map((c) => c.body).join('\n');
    expect(all).not.toContain('SEGREDO-DA-BANDA');
    expect(all).toContain('RETRIEVAL_DOCUMENT');
  });
});

describe('indisponibilidade e fallback', () => {
  const failing: Array<[string, Reply, string]> = [
    ['cota', { status: 429, text: 'quota detalhe-secreto' }, 'quota'],
    ['chave recusada', { status: 403, text: 'key detalhe-secreto' }, 'auth'],
    ['erro do servidor', { status: 500, text: 'oops detalhe-secreto' }, 'error'],
    ['sem rede', { throws: new TypeError('fetch failed: getaddrinfo detalhe-secreto') }, 'unavailable'],
    ['bloqueio do provedor', { json: { promptFeedback: { blockReason: 'SAFETY' } } }, 'refused'],
  ];
  it.each(failing)('Gemini com %s → Ollama local responde, com o motivo registrado e sem vazar nada', async (_n, reply, reason) => {
    const logs: string[] = [];
    const { k } = await service({ gemini: fakeGemini({ chat: reply }).client(), chat: 'gemini', log: (m) => logs.push(m) });
    const r = await ask(k);
    expect(r.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', fellBackFrom: 'gemini', fallbackReason: reason });
    expect(r.narrative).toBeDefined();
    const stats = (await k.status()).narrativeStats;
    expect(stats.dropped[reason]).toBe(1);
    expect(stats.usedBy).toEqual({ ollama: 1 });
    const text = logs.join('\n') + JSON.stringify(r) + JSON.stringify(await k.status());
    expect(logs.join('\n')).toContain(`motivo=${reason}, provedor=gemini`);
    expect(text).not.toMatch(/detalhe-secreto|AIza/);
  });
  it('Gemini e Ollama fora: sem resumo, motor determinístico e diagnóstico intactos', async () => {
    const { k } = await service({ ollama: fakeOllama({ up: false }), gemini: fakeGemini({ chat: { throws: new TypeError('x') } }).client(), chat: 'gemini' });
    const r = await ask(k);
    expect(r.narrative).toBeUndefined();
    expect(r.narrativeStatus).toMatchObject({ status: 'unavailable' });
    expect(r.passages.length).toBeGreaterThan(0); // busca por palavras continua
    expect(r.mode).toBe('keyword');
  });
  it('descarte de segurança NÃO tenta outro modelo: resposta do Gemini com phantom é descartada', async () => {
    const g = fakeGemini({ chat: { json: { candidates: [{ content: { parts: [{ text: 'Pode ser o phantom desligado; o operador pode conferir o cabo e o microfone.' }] } }] } } });
    let ollamaCalls = 0;
    const { k } = await service({ ollama: fakeOllama({ spy: () => { ollamaCalls++; } }), gemini: g.client(), chat: 'gemini' });
    const r = await ask(k);
    expect(r.narrative).toBeUndefined();
    expect(r.narrativeStatus).toMatchObject({ status: 'blocked', rule: 'phantom', provider: 'gemini' });
    expect(ollamaCalls).toBe(0);
  });
  it('as proteções valem para o texto do Gemini: valor de processamento e afirmar ter ouvido', async () => {
    for (const [text, rule] of [['Corte 3 dB em 250 Hz no canal para testar.', 'valor_de_processamento'], ['Pelo áudio que ouvi, há excesso de graves no vocal agora.', 'afirma_ter_ouvido_ou_medido']] as const) {
      const g = fakeGemini({ chat: { json: { candidates: [{ content: { parts: [{ text }] } }] } } });
      const { k } = await service({ gemini: g.client(), chat: 'gemini' });
      expect((await ask(k)).narrativeStatus).toMatchObject({ status: 'blocked', rule, provider: 'gemini' });
    }
  });
  it('o Ollama como provedor escolhido nunca chama o Gemini', async () => {
    const g = fakeGemini();
    const { k } = await service({ gemini: g.client(), chat: 'ollama' });
    const r = await ask(k);
    expect(r.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama' });
    expect(g.fetchFn).not.toHaveBeenCalled();
  });
});

describe('configuração e isolamento de segredos', () => {
  const dirWith = (local: string, secrets?: string) => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yaml'), '{}\n');
    writeFileSync(join(dir, 'channels.yaml'), 'channels: []\naux: []\n');
    writeFileSync(join(dir, 'config.local.yaml'), local);
    if (secrets) writeFileSync(join(dir, 'secrets.yaml'), secrets);
    return dir;
  };
  it('Gemini desligado e Ollama como padrão; escolher Gemini sem habilitar é erro', () => {
    const k = parseConfig({}).knowledge;
    expect(k).toMatchObject({ chatProvider: 'ollama', embedProvider: 'ollama', gemini: { enabled: false } });
    expect(() => parseConfig({ knowledge: { chatProvider: 'gemini' } })).toThrow(/knowledge\.gemini\.enabled/);
    expect(() => parseConfig({ knowledge: { embedProvider: 'gemini', gemini: { enabled: true } } })).toThrow(/outra knowledge\.collection/);
    expect(parseConfig({ knowledge: { chatProvider: 'gemini', gemini: { enabled: true } } }).knowledge.chatProvider).toBe('gemini');
    expect(parseConfig({ knowledge: { embedProvider: 'gemini', collection: 'gem', gemini: { enabled: true } } }).knowledge.collection).toBe('gem');
    expect(() => parseConfig({ knowledge: { gemini: { chatModel: '../x' } } })).toThrow();
    expect(() => parseConfig({ knowledge: { gemini: { endpoint: 'https://evil.example' } } })).toThrow(); // endereço não é configurável
  });
  it('a chave é recusada no config.local.yaml e aceita em secrets.yaml ou no ambiente', () => {
    expect(() => loadConfig({ MIXAI_CONFIG_DIR: dirWith(`knowledge:\n  gemini:\n    geminiApiKey: "${KEY}"\n`) } as never, [])).toThrow(/segredo/);
    expect(() => loadConfig({ MIXAI_CONFIG_DIR: dirWith(`knowledge:\n  gemini:\n    apiKey: "${KEY}"\n`) } as never, [])).toThrow(/segredo/);
    const viaFile = loadConfig({ MIXAI_CONFIG_DIR: dirWith('knowledge:\n  enabled: true\n', `geminiApiKey: "${KEY}"\n`) } as never, []);
    expect(viaFile.secrets?.geminiApiKey).toBe(KEY);
    const viaEnv = loadConfig({ MIXAI_CONFIG_DIR: dirWith('knowledge:\n  enabled: true\n'), MIXAI_GEMINI_API_KEY: KEY } as never, []);
    expect(viaEnv.secrets?.geminiApiKey).toBe(KEY);
    expect(JSON.stringify(viaEnv.config)).not.toContain(KEY); // a chave nunca entra na configuração pública
    expect(() => loadConfig({ MIXAI_CONFIG_DIR: dirWith('{}\n', 'geminiApiKey: "curta"\n') } as never, [])).toThrow();
  });
  const loaded = (dir: string, knowledge: Record<string, unknown>, secrets: Record<string, unknown> = {}) => ({ config: parseConfig({ knowledge: { enabled: true, ...knowledge } }), channels: { channels: [], aux: [] }, configDir: dir, logDir: null, labFile: join(dir, 'lab.json'), dataDir: dir, secrets }) as never;
  it('status, provedores e logs de abertura nunca contêm a chave', async () => {
    const dir = tmp();
    const logs: string[] = [];
    const g = fakeGemini();
    const k = await openLocalKnowledge(loaded(dir, { gemini: { enabled: true } }, { geminiApiKey: KEY }), { geminiFetch: g.fetchFn as unknown as typeof fetch, log: (m) => logs.push(m) });
    await k!.setChatProvider('gemini', true);
    const dump = JSON.stringify(await k!.status()) + JSON.stringify(k!.providers()) + logs.join('\n');
    expect(dump).not.toContain(KEY);
    expect(dump).not.toMatch(/AIza/);
    expect(readFileSync(join(dir, 'knowledge', 'provider.json'), 'utf8')).toBe('{"version":1,"chat":"gemini"}');
  });
  it('Gemini escolhido mas sem habilitar/sem chave volta ao Ollama e explica no log', async () => {
    const logs: string[] = [];
    const noEnable = await openLocalKnowledge(loaded(tmp(), {}), { log: (m) => logs.push(m) });
    expect(noEnable!.providers().chat.options.map((o) => o.id)).toEqual(['ollama']);
    const noKey = await openLocalKnowledge(loaded(tmp(), { chatProvider: 'gemini', gemini: { enabled: true } }), { log: (m) => logs.push(m) });
    expect(noKey!.providers().chat.selected).toBe('ollama');
    expect(noKey!.providers().chat.options.find((o) => o.id === 'gemini')).toMatchObject({ configured: false });
    expect(logs.some((l) => /Gemini foi escolhido mas não está habilitado ou sem chave/.test(l))).toBe(true);
  });
  it('a escolha do operador é lembrada na próxima abertura, mas só vale se o Gemini continuar configurado', async () => {
    const dir = tmp();
    const g = fakeGemini();
    const deps = { geminiFetch: g.fetchFn as unknown as typeof fetch };
    const cfg = loaded(dir, { gemini: { enabled: true } }, { geminiApiKey: KEY });
    const first = await openLocalKnowledge(cfg, deps);
    await first!.setChatProvider('gemini', true);
    expect((await openLocalKnowledge(cfg, deps))!.providers().chat.selected).toBe('gemini');
    expect((await openLocalKnowledge(loaded(dir, { gemini: { enabled: true } }, {}), deps))!.providers().chat.selected).toBe('ollama'); // chave removida
    expect((await openLocalKnowledge(loaded(dir, {}), deps))!.providers().chat.selected).toBe('ollama'); // Gemini desabilitado
    await first!.setChatProvider('ollama');
    expect((await openLocalKnowledge(cfg, deps))!.providers().chat.selected).toBe('ollama');
  });
  it('preferência corrompida ou com campo extra é ignorada', () => {
    const file = join(tmp(), 'provider.json');
    expect(readChatPreference(file)).toBeUndefined();
    writeChatPreference(file, 'gemini');
    expect(readChatPreference(file)).toBe('gemini');
    for (const bad of ['{', '[]', '{"version":1,"chat":"openai"}', '{"version":1,"chat":"gemini","apiKey":"x"}', '{"version":2,"chat":"gemini"}']) {
      writeFileSync(file, bad);
      expect(readChatPreference(file), bad).toBeUndefined();
    }
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
  it('embeddings do Gemini: o PostgreSQL usa a dimensão do Gemini na coleção própria', async () => {
    const ddl: string[] = [];
    const client: SqlClient = { query: async (t: string) => { ddl.push(t); return { rows: [] } as never; }, end: async () => undefined };
    const k = await openLocalKnowledge(loaded(tmp(), { store: 'postgres', collection: 'gem', embedProvider: 'gemini', gemini: { enabled: true, embedDimensions: 1536 } }, { geminiApiKey: KEY }), { pgClient: client, geminiFetch: fakeGemini().fetchFn as unknown as typeof fetch });
    expect(k!.providers().embed).toEqual({ id: 'gemini', external: true });
    expect(ddl.join('\n')).toContain('vector(1536)');
    expect(ddl).toContain('CREATE SCHEMA IF NOT EXISTS kb_gem');
  });
});
