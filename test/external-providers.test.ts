import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageTracker } from '../src/ai/usage.js';
import { ChannelMap } from '../src/core/channels.js';
import { loadConfig, parseChannels, parseConfig, PROJECT_ROOT, type LoadedConfig } from '../src/core/config.js';
import { TechnicalPlanner, autoConfigCases, bandKnowledgeAdapter, plannerResultSchema, type PlannerPolicy, type PlannerProvider } from '../src/autoconfig/index.js';
import { ANTHROPIC_API_BASE, ANTHROPIC_MODELS, AnthropicClient } from '../src/knowledge/local/anthropic.js';
import { BudgetedProvider } from '../src/knowledge/local/budget.js';
import { DEEPSEEK_API_BASE, DEEPSEEK_MODELS, DeepSeekClient } from '../src/knowledge/local/deepseek.js';
import { buildExternalProviders } from '../src/knowledge/local/external-providers.js';
import { GeminiClient } from '../src/knowledge/local/gemini.js';
import { OllamaClient } from '../src/knowledge/local/ollama.js';
import { readPackFromDir } from '../src/knowledge/local/pack.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { ExternalConsent } from '../src/server/external-consent.js';
import { OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

/**
 * DeepSeek e Anthropic como provedores de texto. TUDO com provedores simulados: nenhuma chamada paga ou de rede real.
 * Chaves de teste são fictícias e nunca devem aparecer em URL, corpo, erro, log ou resposta.
 */
const DS_KEY = 'FAKE-deepseek-key-for-tests-0123456789';
const AN_KEY = 'FAKE-anthropic-key-for-tests-0123456789';
const GOOD = 'Pode ser que o ganho esteja alto; o operador pode conferir o posicionamento do microfone no palco.';
const DIMS = 8;
const OLLAMA_OPTS = { url: 'http://127.0.0.1:11434', embedModel: 'nomic-embed-text', chatModel: 'llama3.2:3b', embedDimensions: DIMS, timeoutMs: 2000 };

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
type Reply = { status?: number; json?: unknown; throws?: Error };
function fake(handler: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: String(init.body ?? '') };
    calls.push(call);
    const r = handler(call);
    if (r.throws) throw r.throws;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}
const dsOk = (text = GOOD, extra: Record<string, unknown> = {}) => ({ json: { model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 120, completion_tokens: 40 }, ...extra } });
const anOk = (text = GOOD, extra: Record<string, unknown> = {}) => ({ json: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'segredo-do-raciocinio' }, { type: 'text', text }], usage: { input_tokens: 150, output_tokens: 60 }, ...extra } });
const deepseek = (f: ReturnType<typeof fake>, key: string | null = DS_KEY, model = 'deepseek-flash') => new DeepSeekClient({ chatModel: model, timeoutMs: 2000 }, key ?? undefined, f.fetchFn);
const anthropic = (f: ReturnType<typeof fake>, key: string | null = AN_KEY, model = 'claude-opus-5-5') => new AnthropicClient({ chatModel: model, timeoutMs: 2000 }, key ?? undefined, f.fetchFn);

describe('DeepSeekClient', () => {
  it('endereço fixo e compatível com OpenAI; chave só no cabeçalho; Flash por padrão; sem ferramentas', async () => {
    const f = fake(() => dsOk()); const c = deepseek(f);
    expect(c.model).toBe('deepseek-flash');
    const r = await c.generateDetailed('SISTEMA', 'USUARIO');
    expect(r).toMatchObject({ text: GOOD, model: 'deepseek-flash', usage: { inputTokens: 120, outputTokens: 40 } });
    const call = f.calls[0]!, body = JSON.parse(call.body);
    expect(call.url).toBe(`${DEEPSEEK_API_BASE}chat/completions`);
    expect(call.url.startsWith('https://api.deepseek.com/')).toBe(true);
    expect(call.headers['authorization']).toBe(`Bearer ${DS_KEY}`);
    expect(call.url + call.body).not.toContain(DS_KEY);
    expect(body).toMatchObject({ model: 'deepseek-flash', stream: false, max_tokens: 600, messages: [{ role: 'system', content: 'SISTEMA' }, { role: 'user', content: 'USUARIO' }] });
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'temperature']); // sem tools/functions
  });
  it('sem chave não faz rede; modelos oferecidos: flash e v4-pro, e só eles', async () => {
    const f = fake(() => dsOk()); const c = deepseek(f, null);
    expect(c.configured).toBe(false);
    expect(await c.generateDetailed('s', 'u')).toEqual({ failure: 'auth' });
    expect((await c.health()).detail).toMatch(/sem chave/);
    expect(f.calls).toHaveLength(0);
    expect([...DEEPSEEK_MODELS]).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    const k = deepseek(f);
    expect(k.selectModel('deepseek-v4-pro')).toBe(true); expect(k.model).toBe('deepseek-v4-pro');
    expect(k.selectModel('gpt-5')).toBe(false); expect(k.model).toBe('deepseek-v4-pro');
    expect(await k.embed()).toBeUndefined();
  });
  it.each([
    [401, 'auth', undefined], [403, 'auth', undefined], [402, 'quota', 'insufficient_balance'], [429, 'quota', undefined],
    [500, 'unavailable', undefined], [503, 'unavailable', undefined], [400, 'error', undefined],
  ] as const)('HTTP %i vira %s sem expor corpo nem chave', async (status, failure, reason) => {
    const f = fake(() => ({ status, json: { error: { message: `vazou ${DS_KEY}` } } }));
    const r = await deepseek(f).generateDetailed('s', 'u');
    expect(r.failure).toBe(failure); expect(r.reason).toBe(reason);
    expect(JSON.stringify(r)).not.toContain(DS_KEY); expect(JSON.stringify(r)).not.toContain('vazou');
  });
  it('finish_reason: content_filter = recusa; length = truncada; vazio e erro de rede tratados', async () => {
    const mk = (finish_reason: string, content: unknown = 'texto parcial') => fake(() => ({ json: { choices: [{ finish_reason, message: { content } }] } }));
    expect((await deepseek(mk('content_filter')).generateDetailed('s', 'u')).failure).toBe('refused');
    expect((await deepseek(mk('length')).generateDetailed('s', 'u')).failure).toBe('truncated');
    expect((await deepseek(mk('insufficient_system_resource')).generateDetailed('s', 'u')).failure).toBe('unavailable');
    expect((await deepseek(mk('stop', '   ')).generateDetailed('s', 'u')).failure).toBe('empty');
    expect((await deepseek(fake(() => ({ json: { choices: [] } }))).generateDetailed('s', 'u')).failure).toBe('empty');
    const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
    expect((await deepseek(fake(() => ({ throws: timeout }))).generateDetailed('s', 'u')).failure).toBe('timeout');
    expect((await deepseek(fake(() => ({ throws: new TypeError('ECONNRESET') }))).generateDetailed('s', 'u')).failure).toBe('unavailable');
  });
  it('health usa GET /models (sem consumo) e distingue chave recusada', async () => {
    const f = fake((c) => c.url.endsWith('/models') ? { json: { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } } : { status: 500 });
    const c = deepseek(f);
    expect(await c.health()).toMatchObject({ reachable: true, chatModel: true });
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `${DEEPSEEK_API_BASE}models`, body: '' });
    expect((await deepseek(fake(() => ({ status: 401 }))).health(true)).detail).toMatch(/recusou a chave/);
  });
});

describe('AnthropicClient', () => {
  it('endereço fixo; chave só no cabeçalho; sem ferramentas; só blocos de texto (raciocínio ignorado)', async () => {
    const f = fake(() => anOk()); const c = anthropic(f);
    const r = await c.generateDetailed('SISTEMA', 'USUARIO');
    expect(r).toMatchObject({ text: GOOD, model: 'claude-opus-5-5', usage: { inputTokens: 150, outputTokens: 60 } });
    expect(JSON.stringify(r)).not.toContain('segredo-do-raciocinio');
    const call = f.calls[0]!, body = JSON.parse(call.body);
    expect(call.url).toBe(`${ANTHROPIC_API_BASE}messages`);
    expect(call.headers['x-api-key']).toBe(AN_KEY); expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.url + call.body).not.toContain(AN_KEY);
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1024, system: 'SISTEMA', messages: [{ role: 'user', content: 'USUARIO' }] });
    expect(body.tools).toBeUndefined(); expect(body.tool_choice).toBeUndefined();
  });
  it('modelos: Opus 5.5 e Fable 5.2, selecionáveis; qualquer outro é recusado', () => {
    expect([...ANTHROPIC_MODELS]).toEqual(['claude-opus-5-5', 'claude-fable-5-2']);
    const c = anthropic(fake(() => anOk()));
    expect(c.selectModel('claude-fable-5-2')).toBe(true); expect(c.model).toBe('claude-fable-5-2');
    expect(c.selectModel('claude-opus-4-1')).toBe(false); expect(c.model).toBe('claude-fable-5-2');
  });
  it('o modelo informado pela API é o que aparece como "respondeu"', async () => {
    const f = fake(() => anOk(GOOD, { model: 'claude-fable-5-2' }));
    expect((await anthropic(f).generateDetailed('s', 'u')).model).toBe('claude-fable-5-2');
  });
  it.each([[401, 'auth'], [403, 'auth'], [429, 'quota'], [529, 'unavailable'], [500, 'unavailable'], [400, 'error']] as const)('HTTP %i vira %s', async (status, failure) => {
    const r = await anthropic(fake(() => ({ status, json: { error: { message: `vazou ${AN_KEY}` } } }))).generateDetailed('s', 'u');
    expect(r.failure).toBe(failure); expect(JSON.stringify(r)).not.toContain(AN_KEY);
  });
  it('stop_reason: refusal = recusa de segurança; max_tokens = truncada; sem texto = vazio', async () => {
    const mk = (stop_reason: string, content: unknown[] = [{ type: 'text', text: 'parcial' }]) => fake(() => ({ json: { stop_reason, content } }));
    expect((await anthropic(mk('refusal')).generateDetailed('s', 'u')).failure).toBe('refused');
    expect((await anthropic(mk('max_tokens')).generateDetailed('s', 'u')).failure).toBe('truncated');
    expect((await anthropic(mk('tool_use')).generateDetailed('s', 'u')).failure).toBe('error');
    expect((await anthropic(mk('end_turn', [{ type: 'thinking', thinking: 'x' }])).generateDetailed('s', 'u')).failure).toBe('empty');
  });
  it('sem chave não faz rede; embeddings não existem', async () => {
    const f = fake(() => anOk()); const c = anthropic(f, null);
    expect(await c.generateDetailed('s', 'u')).toEqual({ failure: 'auth' }); expect((await c.health()).detail).toMatch(/sem chave/);
    expect(await c.embed()).toBeUndefined(); expect(f.calls).toHaveLength(0);
  });
});

describe('BudgetedProvider: custo por modelo, limites e registro sem segredos', () => {
  const tracker = (clock = Date.now) => new UsageTracker(null, clock);
  const opts = (t: UsageTracker, log: string[] = [], over: Partial<ConstructorParameters<typeof BudgetedProvider>[1]> = {}) => ({ tracker: t, dailyBudgetUSD: 1, maxRequestsPerMinute: 10, maxOutputTokens: 600, log: (m: string) => log.push(m),
    price: (m: string) => (m === 'deepseek-v4-pro' ? { inputPerMTok: 2, outputPerMTok: 8 } : { inputPerMTok: 0.5, outputPerMTok: 2 }), ...over });
  it('troca a reserva pelo consumo real e registra provedor, modelo, tokens e custo — sem chave nem conteúdo', async () => {
    const f = fake(() => dsOk()); const log: string[] = []; const t = tracker();
    const p = new BudgetedProvider(deepseek(f), opts(t, log));
    const r = await p.generateDetailed('SEGREDO-DO-SISTEMA', 'PERGUNTA-PRIVADA');
    expect(r.text).toBe(GOOD);
    expect(t.current().requests).toBe(1); expect(t.current().inputTokens).toBe(120); expect(t.current().costUSD).toBeCloseTo((120 * 0.5 + 40 * 2) / 1e6, 9);
    const line = log.join('\n');
    expect(line).toMatch(/provedor=deepseek modelo=deepseek-flash/); expect(line).toMatch(/tokens_entrada=120 tokens_saida=40/);
    for (const secret of [DS_KEY, 'SEGREDO-DO-SISTEMA', 'PERGUNTA-PRIVADA', GOOD]) expect(line).not.toContain(secret);
  });
  it('custo por modelo: v4-pro cobra mais que flash para os mesmos tokens', async () => {
    const t1 = tracker(), t2 = tracker();
    await new BudgetedProvider(deepseek(fake(() => dsOk()), DS_KEY, 'deepseek-flash'), opts(t1)).generateDetailed('s', 'u');
    await new BudgetedProvider(deepseek(fake(() => dsOk()), DS_KEY, 'deepseek-v4-pro'), opts(t2)).generateDetailed('s', 'u');
    expect(t2.current().costUSD).toBeGreaterThan(t1.current().costUSD * 3);
  });
  it('teto diário esgotado: recusa local, sem chamar a rede', async () => {
    const f = fake(() => dsOk()); const t = tracker();
    const p = new BudgetedProvider(deepseek(f), opts(t, [], { dailyBudgetUSD: 0.000001 }));
    const r = await p.generateDetailed('s'.repeat(2000), 'u');
    expect(r).toMatchObject({ failure: 'quota', reason: 'budget' }); expect(f.calls).toHaveLength(0);
  });
  it('limite por minuto: recusa local', async () => {
    const f = fake(() => dsOk()); const p = new BudgetedProvider(deepseek(f), opts(tracker(), [], { maxRequestsPerMinute: 2 }));
    await p.generateDetailed('s', 'u'); await p.generateDetailed('s', 'u');
    expect(await p.generateDetailed('s', 'u')).toMatchObject({ failure: 'quota', reason: 'rate_limit' });
    expect(f.calls).toHaveLength(2);
  });
  it('saldo insuficiente (402) libera a reserva e informa o motivo; timeout cobra a estimativa', async () => {
    const t = tracker(); const log: string[] = [];
    const bal = new BudgetedProvider(deepseek(fake(() => ({ status: 402 }))), opts(t, log));
    expect(await bal.generateDetailed('s', 'u')).toMatchObject({ failure: 'quota', reason: 'insufficient_balance' });
    expect(t.current().costUSD).toBe(0); expect(log.join()).toMatch(/motivo=insufficient_balance/);
    const slow = new BudgetedProvider(deepseek(fake(() => ({ throws: Object.assign(new Error('x'), { name: 'TimeoutError' }) }))), opts(t, log));
    expect((await slow.generateDetailed('s', 'u')).failure).toBe('timeout');
    expect(t.current().costUSD).toBeGreaterThan(0);
  });
  it('expõe modelo e seleção do provedor interno e não esconde a falta de chave', () => {
    const p = new BudgetedProvider(anthropic(fake(() => anOk()), null), opts(tracker()));
    expect(p.id).toBe('anthropic'); expect(p.external).toBe(true); expect(p.configured).toBe(false);
    expect(p.selectModel('claude-fable-5-2')).toBe(true); expect(p.model).toBe('claude-fable-5-2'); expect(p.modelOptions).toEqual([...ANTHROPIC_MODELS]);
  });
});

describe('configuração e construção', () => {
  it('padrões seguros: desligados, Flash, Opus, fallback ollama, teto diário', () => {
    const k = parseConfig({}).knowledge;
    expect(k.deepseek).toMatchObject({ enabled: false, chatModel: 'deepseek-flash' });
    expect(k.anthropic).toMatchObject({ enabled: false, chatModel: 'claude-opus-5-5' });
    expect(k.external).toMatchObject({ fallback: 'ollama', dailyBudgetUSD: 1, maxRequestsPerMinute: 10 });
    expect(k.external.prices['claude-fable-5-2']).toEqual({ inputPerMTok: 8, outputPerMTok: 40 });
    expect(k.chatProvider).toBe('ollama');
  });
  it('só aceita modelos conhecidos e os provedores no seletor', () => {
    expect(() => parseConfig({ knowledge: { deepseek: { chatModel: 'deepseek-chat' } } })).toThrow();
    expect(() => parseConfig({ knowledge: { anthropic: { chatModel: 'claude-x' } } })).toThrow();
    expect(parseConfig({ knowledge: { chatProvider: 'deepseek' } }).knowledge.chatProvider).toBe('deepseek');
    expect(() => parseConfig({ knowledge: { chatProvider: 'openai' } })).toThrow();
    expect(() => parseConfig({ knowledge: { embedProvider: 'deepseek' } })).toThrow();
  });
  it('a chave da DeepSeek vem só do ambiente/secrets e nunca da config pública', () => {
    const env = { MIXAI_DEEPSEEK_API_KEY: DS_KEY } as NodeJS.ProcessEnv;
    const loaded = loadConfig(env, ['node', 'x', '--lab']);
    expect(loaded.secrets?.deepseekApiKey).toBe(DS_KEY);
    expect(JSON.stringify(loaded.config)).not.toContain(DS_KEY);
  });
  it('buildExternalProviders: nada por padrão; habilitado sem chave não é "configurado"; com chave vem com controle de custo', () => {
    const base = parseConfig({});
    const mk = (cfg: Record<string, unknown>, secrets: Record<string, string> = {}) => ({ config: parseConfig({ knowledge: cfg }), secrets, dataDir: mkdtempSync(join(tmpdir(), 'mixai-ext-')) }) as unknown as LoadedConfig;
    expect(buildExternalProviders({ config: base, secrets: {}, dataDir: tmpdir() } as unknown as LoadedConfig)).toEqual([]);
    const no = buildExternalProviders(mk({ deepseek: { enabled: true }, anthropic: { enabled: true } }));
    expect(no.map((p) => [p.id, (p as { configured?: boolean }).configured])).toEqual([['deepseek', false], ['anthropic', false]]);
    const yes = buildExternalProviders(mk({ deepseek: { enabled: true } }, { deepseekApiKey: DS_KEY }));
    expect(yes[0]).toBeInstanceOf(BudgetedProvider); expect((yes[0] as BudgetedProvider).configured).toBe(true);
  });
});

// ---- encadeamento do resumo: consentimento, fallback e recusa -----------------------------------------------------
const PUBLIC_DOC = '# Microfonia\n\nA microfonia depende do ganho e do posicionamento do microfone no palco. Reduza o retorno do vocal para evitar a realimentação.';
function fakeOllama(chat = 'Pode ser que o ganho do retorno esteja alto; o operador pode conferir o posicionamento do microfone em relação às caixas.') {
  const calls: string[] = [];
  const fetchFn = async (input: URL | string, init?: RequestInit) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push(url);
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }] }));
    if (url.endsWith('/api/embed')) return new Response(JSON.stringify({ embeddings: (body.input as string[]).map((t) => { const v = new Array(DIMS).fill(0.01); if (/microfonia|feedback/i.test(t)) v[0] = 1; return v; }) }));
    if (url.endsWith('/api/chat')) return new Response(JSON.stringify({ message: { content: chat } }));
    return new Response('{}', { status: 404 });
  };
  return { client: new OllamaClient(OLLAMA_OPTS, fetchFn as unknown as typeof fetch), calls };
}
async function service(o: { chat?: 'deepseek' | 'anthropic' | 'ollama'; deepseek?: DeepSeekClient; anthropic?: AnthropicClient; gemini?: GeminiClient; fallback?: 'ollama' | 'none'; ollama?: ReturnType<typeof fakeOllama> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-ext-'));
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json')); await store.init();
  const ollama = o.ollama ?? fakeOllama();
  const k = new LocalKnowledge({ store, ollama: ollama.client, chatProviders: [ollama.client, ...(o.gemini ? [o.gemini] : []), ...(o.deepseek ? [o.deepseek] : []), ...(o.anthropic ? [o.anthropic] : [])],
    chat: o.chat, externalFallback: o.fallback, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: true });
  await k.importSeed(); mkdirSync(join(dir, 'inbox'), { recursive: true }); writeFileSync(join(dir, 'inbox', 'shure-live.md'), PUBLIC_DOC); await k.ingest();
  return { k, dir };
}
const ask = (k: LocalKnowledge, allowed?: (id: string) => boolean) => k.enrich({ text: 'O Fred está microfonando no PA', symptom: 'microfonia' }, allowed ? { externalAllowed: allowed as never } : undefined);
const yes = () => true;

describe('resumo: consentimento por sessão, fallback e recusa', () => {
  it('SEM consentimento a DeepSeek não é chamada: o Ollama local assume e isso fica visível', async () => {
    const f = fake(() => dsOk()); const { k } = await service({ chat: 'deepseek', deepseek: deepseek(f) });
    const ctx = await ask(k);
    expect(f.calls).toHaveLength(0);
    expect(ctx.narrativeStatus).toMatchObject({ status: 'used', provider: 'ollama', fellBackFrom: 'deepseek', fallbackReason: 'not_consented' });
    expect(ctx.narrative?.source).toBe('ollama');
  });
  it('SEM consentimento e SEM fallback: nenhum resumo e nenhum envio', async () => {
    const f = fake(() => dsOk()); const { k } = await service({ chat: 'deepseek', deepseek: deepseek(f), fallback: 'none' });
    const ctx = await ask(k);
    expect(f.calls).toHaveLength(0); expect(ctx.narrative).toBeUndefined();
    expect(ctx.narrativeStatus).toMatchObject({ status: 'not_consented', provider: 'deepseek' });
  });
  it('COM consentimento a DeepSeek responde e o resultado identifica provedor e modelo que de fato responderam', async () => {
    const f = fake((c) => c.url.includes('chat/completions') ? dsOk(GOOD, { model: 'deepseek-v4-pro' }) : { json: {} }); const { k } = await service({ chat: 'deepseek', deepseek: deepseek(f) });
    const ctx = await ask(k, yes);
    expect(ctx.narrative).toMatchObject({ source: 'deepseek', model: 'deepseek-v4-pro', verified: false });
    expect(ctx.narrativeStatus).toMatchObject({ status: 'used', provider: 'deepseek', model: 'deepseek-v4-pro' });
    // só trechos públicos e a pergunta saem; nunca nomes de pessoas
    const sent = JSON.parse(f.calls.find((c) => c.url.includes('chat/completions'))!.body).messages[1].content as string;
    expect(sent).not.toMatch(/Fred/); expect(sent).toContain('<trecho');
  });
  it('Anthropic: consentimento obrigatório e o modelo escolhido é o que responde', async () => {
    const f = fake((c) => c.url.endsWith('/messages') ? anOk(GOOD, { model: 'claude-fable-5-2' }) : { json: {} }); const a = anthropic(f);
    const { k } = await service({ chat: 'anthropic', anthropic: a });
    expect(await k.setChatProvider('anthropic', true, 'claude-fable-5-2').then(() => a.model)).toBe('claude-fable-5-2');
    expect((await ask(k)).narrativeStatus).toMatchObject({ provider: 'ollama', fallbackReason: 'not_consented' });
    const withConsent = await ask(k, yes);
    expect(withConsent.narrative).toMatchObject({ source: 'anthropic', model: 'claude-fable-5-2' });
    expect(JSON.parse(f.calls.find((c) => c.url.endsWith('/messages'))!.body).model).toBe('claude-fable-5-2');
  });
  it('consentimento é por provedor: conceder DeepSeek não libera a Anthropic', async () => {
    const fa = fake(() => anOk()); const fd = fake(() => dsOk());
    const { k } = await service({ chat: 'anthropic', anthropic: anthropic(fa), deepseek: deepseek(fd) });
    await ask(k, (id) => id === 'deepseek');
    expect(fa.calls).toHaveLength(0); expect(fd.calls).toHaveLength(0);
  });
  it('indisponibilidade (503) usa SÓ o Ollama local — nunca outro serviço externo, mesmo com Gemini habilitado', async () => {
    const fd = fake(() => ({ status: 503 })); const gem = fake(() => ({ json: { candidates: [{ content: { parts: [{ text: GOOD }] }, finishReason: 'STOP' }] } }));
    const gemini = new GeminiClient({ chatModel: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001', embedDimensions: DIMS, timeoutMs: 2000 }, 'FAKE-gemini-key-for-tests-0123456789abcdef', gem.fetchFn);
    const { k } = await service({ chat: 'deepseek', deepseek: deepseek(fd), gemini });
    const ctx = await ask(k, yes);
    expect(ctx.narrativeStatus).toMatchObject({ provider: 'ollama', fellBackFrom: 'deepseek', fallbackReason: 'unavailable' });
    expect(gem.calls).toHaveLength(0);
  });
  it('saldo insuficiente (402) cai para o Ollama como "quota" e sem reaproveitar a chave em outro lugar', async () => {
    const fd = fake(() => ({ status: 402 })); const { k } = await service({ chat: 'deepseek', deepseek: deepseek(fd) });
    expect((await ask(k, yes)).narrativeStatus).toMatchObject({ provider: 'ollama', fellBackFrom: 'deepseek', fallbackReason: 'quota' });
    expect(fd.calls).toHaveLength(1);
  });
  it('fallback "none": falha do externo não aciona o Ollama', async () => {
    const fd = fake(() => ({ status: 503 })); const oll = fakeOllama(); const { k } = await service({ chat: 'deepseek', deepseek: deepseek(fd), fallback: 'none', ollama: oll });
    oll.calls.length = 0;
    const ctx = await ask(k, yes);
    expect(ctx.narrative).toBeUndefined(); expect(ctx.narrativeStatus).toMatchObject({ status: 'unavailable', provider: 'deepseek' });
    expect(oll.calls.some((u) => u.endsWith('/api/chat'))).toBe(false);
  });
  it('RECUSA de segurança não faz fallback para nenhum provedor', async () => {
    for (const [name, mkSvc] of [
      ['deepseek', () => service({ chat: 'deepseek', deepseek: deepseek(fake((c) => c.url.includes('chat/completions') ? { json: { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] } } : { json: {} })) })],
      ['anthropic', () => service({ chat: 'anthropic', anthropic: anthropic(fake((c) => c.url.endsWith('/messages') ? { json: { stop_reason: 'refusal', content: [] } } : { json: {} })) })],
    ] as const) {
      const { k } = await mkSvc();
      const ctx = await ask(k, yes);
      expect(ctx.narrative, name).toBeUndefined();
      expect(ctx.narrativeStatus, name).toMatchObject({ status: 'refused', provider: name });
      expect(ctx.narrativeStatus?.fellBackFrom, name).toBeUndefined();
    }
  });
  it('seleção manual entre Ollama, Gemini, DeepSeek e Anthropic: confirmação, chave e modelo validados', async () => {
    const fd = fake((c) => c.url.endsWith('/models') ? { json: { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } } : dsOk());
    const { k } = await service({ deepseek: deepseek(fd), anthropic: anthropic(fake(() => ({ json: {} }))) });
    const info = k.providers();
    expect(info.chat.options.map((o) => o.id)).toEqual(['ollama', 'deepseek', 'anthropic']);
    expect(info.chat.options[1]).toMatchObject({ external: true, configured: true, model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'] });
    expect(info.chat.options[2]!.models).toEqual(['claude-opus-5-5', 'claude-fable-5-2']);
    await expect(k.setChatProvider('deepseek')).rejects.toThrow(/Confirme que aceita enviar/);
    await expect(k.setChatProvider('deepseek', true, 'gpt-5')).rejects.toThrow(/Modelo não oferecido/);
    expect((await k.setChatProvider('deepseek', true, 'deepseek-v4-pro')).chat).toMatchObject({ selected: 'deepseek' });
    expect(k.providers().chat.options[1]!.model).toBe('deepseek-v4-pro');
    expect((await k.setChatProvider('ollama')).chat.selected).toBe('ollama');
  });
  it('troca recusada não deixa o modelo trocado pela metade', async () => {
    const fd = fake(() => ({ status: 401 })); const d = deepseek(fd);
    const { k } = await service({ deepseek: d });
    await expect(k.setChatProvider('deepseek', true, 'deepseek-v4-pro')).rejects.toThrow(/recusou a chave/);
    expect(d.model).toBe('deepseek-flash'); expect(k.providers().chat.selected).toBe('ollama');
    await expect(k.setChatProvider('deepseek', false, 'deepseek-v4-pro')).rejects.toThrow(/Confirme/);
    expect(d.model).toBe('deepseek-flash');
    const noKey = (await service({ deepseek: deepseek(fake(() => ({ json: {} })), null) })).k;
    await expect(noKey.setChatProvider('deepseek', true)).rejects.toThrow(/Falta a chave da DeepSeek/);
  });
  it('provedor desabilitado na configuração não pode ser escolhido', async () => {
    const { k } = await service();
    await expect(k.setChatProvider('deepseek', true)).rejects.toThrow(/não está habilitado/);
    await expect(k.setChatProvider('anthropic', true)).rejects.toThrow(/não está habilitado/);
  });
});

describe('ExternalConsent', () => {
  const op = { id: 's1', role: 'operator', label: 'operador' } as const, other = { id: 's2', role: 'operator', label: 'operador' } as const;
  it('vale para quem confirmou e para o provedor selecionado; nova seleção, revogação e Ollama apagam', () => {
    const c = new ExternalConsent();
    expect(c.allowed(op, 'deepseek')).toBe(false);
    c.selection(op, 'deepseek', false); expect(c.allowed(op, 'deepseek')).toBe(false);
    c.selection(op, 'deepseek', true);
    expect(c.allowed(op, 'deepseek')).toBe(true); expect(c.allowed(op, 'anthropic')).toBe(false); expect(c.allowed(other, 'deepseek')).toBe(false);
    c.selection(op, 'anthropic', true); expect(c.allowed(op, 'deepseek')).toBe(false); expect(c.allowed(op, 'anthropic')).toBe(true);
    c.revoke('s1'); expect(c.allowed(op, 'anthropic')).toBe(false);
    c.selection(op, 'ollama', true); expect(c.allowed(op, 'ollama')).toBe(false);
  });
});

// ---- servidor: a seleção confirmada é o consentimento; ele chega ao assistente por sessão --------------------------
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
const sockets: Awaited<ReturnType<typeof wsClient>>[] = [];
afterEach(async () => { sockets.splice(0).forEach((s) => s.ws.close()); await Promise.all(servers.splice(0).map((t) => t.server.close())); vi.restoreAllMocks(); });
const TEXT = 'O surdo no canal 8 está sem grave no PA. Está faltando peso no som. Quero identificar a causa antes de mexer em qualquer ajuste.';

describe('servidor: consentimento por sessão chega ao assistente', () => {
  async function boot() {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-extsrv-'));
    const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
    const ollama = fakeOllama().client;
    const fd = fake((c) => c.url.endsWith('/models') ? { json: { data: [{ id: 'deepseek-flash' }] } } : dsOk());
    const knowledge = new LocalKnowledge({ store, ollama, chatProviders: [ollama, deepseek(fd)], inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: true });
    const seen: Array<(id: string) => boolean> = [];
    vi.spyOn(knowledge, 'enrich').mockImplementation(async (_i, o) => { seen.push((o?.externalAllowed ?? (() => false)) as never); return { mode: 'vector', degraded: false, passages: [], narrativeStatus: { status: 'disabled' } }; });
    const t = await startTestServer({ knowledge, dir, channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8'))) }); servers.push(t);
    const token = await t.login(OPERATOR_PIN);
    const c = await wsClient(t.base, token); sockets.push(c); await c.next((m) => m.type === 'snapshot');
    let n = 0;
    const say = async () => { const requestId = `q${++n}`; c.send({ type: 'assistant', requestId, text: TEXT }); await c.next((m) => m.type === 'assistant_reply' && m.requestId === requestId, 8000); };
    const select = (json: unknown) => fetch(`${t.base}/api/knowledge/providers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(json) });
    return { t, say, select, seen, fd };
  }
  it('sem selecionar/confirmar nada, o assistente nunca autoriza envio externo', async () => {
    const { say, seen } = await boot();
    await say();
    expect(seen).toHaveLength(1); expect(seen[0]!('deepseek')).toBe(false); expect(seen[0]!('anthropic')).toBe(false);
  });
  it('selecionar sem confirmar é recusado; confirmar libera só DeepSeek, só nesta sessão; voltar ao Ollama revoga', async () => {
    const { say, select, seen, t } = await boot();
    expect((await select({ chat: 'deepseek' })).status).toBe(400);
    await say(); expect(seen[0]!('deepseek')).toBe(false);
    const ok = await select({ chat: 'deepseek', confirmExternal: true, model: 'deepseek-flash' });
    expect(ok.status).toBe(200);
    await say(); expect(seen[1]!('deepseek')).toBe(true); expect(seen[1]!('anthropic')).toBe(false);
    const other = await t.login(OPERATOR_PIN); // outra sessão do operador não herda o consentimento
    expect(other).not.toBe('');
    await select({ chat: 'ollama' });
    await say(); expect(seen[2]!('deepseek')).toBe(false);
  });
  it('músico não escolhe provedor (403)', async () => {
    const { t } = await boot();
    const musician = await t.login((await import('./server-support.js')).MUSICIAN_PIN);
    const r = await fetch(`${t.base}/api/knowledge/providers`, { method: 'POST', headers: { authorization: `Bearer ${musician}`, 'content-type': 'application/json' }, body: JSON.stringify({ chat: 'deepseek', confirmExternal: true }) });
    expect(r.status).toBe(403);
  });
});

// ---- planejador do AutoConfig -------------------------------------------------------------------------------------
const channels = parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8')));
const names = new ChannelMap(channels, { inputs: 12, aux: 6 });
const knowledgePort = bandKnowledgeAdapter(names, readPackFromDir(join(PROJECT_ROOT, 'knowledge/seed/banda-v1_2')).microphones);
const good = JSON.stringify({ kind: 'proposal', candidate: 's1', evidence: ['e1'] });
const pProvider = (id: string, external: boolean, response: { text?: string; failure?: any; model?: string } = { text: good }): PlannerProvider => ({ id, external, generate: vi.fn(async () => response) });
const pol = (over: Partial<PlannerPolicy> = {}) => (): PlannerPolicy => ({ enabled: true, active: true, selected: 'deepseek', externalConsent: true, revision: 1, ...over });
const input = () => structuredClone(autoConfigCases[0]!.input);

describe('planejador com DeepSeek/Anthropic', () => {
  it('com consentimento usa o provedor externo e informa provedor e modelo; sem comandos nem autorização', async () => {
    const ds = pProvider('deepseek', true, { text: good, model: 'deepseek-v4-pro' });
    const r = await new TechnicalPlanner({ knowledge: knowledgePort, providers: [ds, pProvider('ollama', false)], policy: pol() }).plan(input());
    expect(plannerResultSchema.safeParse(r).success).toBe(true);
    if (r.kind !== 'proposal') throw new Error(JSON.stringify(r));
    expect(r.provider).toMatchObject({ used: 'deepseek', model: 'deepseek-v4-pro' });
    expect(r).toMatchObject({ authorization: 'not_granted', execution: 'not_executable', realWrites: false, measurements: 'unavailable' });
    expect(r.proposal.suggestions[0].targetValue).toBeNull();
  });
  it('sem consentimento o externo nem é chamado e o Ollama local responde', async () => {
    const ds = pProvider('anthropic', true); const oll = pProvider('ollama', false);
    const r = await new TechnicalPlanner({ knowledge: knowledgePort, providers: [ds, oll], policy: pol({ selected: 'anthropic', externalConsent: false }) }).plan(input());
    expect(ds.generate).not.toHaveBeenCalled(); expect(oll.generate).toHaveBeenCalledTimes(1);
    expect(r.provider.attempts[0]).toEqual({ provider: 'anthropic', status: 'not_consented' });
  });
  it('recusa do provedor externo encerra o plano: sem fallback para o Ollama', async () => {
    const ds = pProvider('deepseek', true, { failure: 'refused' }); const oll = pProvider('ollama', false);
    const r = await new TechnicalPlanner({ knowledge: knowledgePort, providers: [ds, oll], policy: pol() }).plan(input());
    expect(r).toMatchObject({ kind: 'refusal', reason: 'provider_refused' }); expect(oll.generate).not.toHaveBeenCalled();
  });
  it('indisponibilidade usa o Ollama (padrão) ou nada (fallbackToLocal=false); saldo/quota idem', async () => {
    for (const failure of ['unavailable', 'quota', 'timeout']) {
      const oll = pProvider('ollama', false);
      const r = await new TechnicalPlanner({ knowledge: knowledgePort, providers: [pProvider('deepseek', true, { failure }), oll], policy: pol() }).plan(input());
      expect(r.kind, failure).toBe('proposal'); expect(r.provider.used).toBe('ollama'); expect(oll.generate).toHaveBeenCalledTimes(1);
    }
    const oll = pProvider('ollama', false);
    const none = await new TechnicalPlanner({ knowledge: knowgledgePortSafe(), providers: [pProvider('deepseek', true, { failure: 'unavailable' }), oll], policy: pol(), fallbackToLocal: false }).plan(input());
    expect(oll.generate).not.toHaveBeenCalled(); expect(none.provider.used).toBe('deterministic');
  });
  it('nunca troca de um externo para outro: com Gemini também registrado, a cadeia é só selecionado + Ollama', async () => {
    const gem = pProvider('gemini', true); const oll = pProvider('ollama', false);
    await new TechnicalPlanner({ knowledge: knowledgePort, providers: [pProvider('deepseek', true, { failure: 'unavailable' }), gem, oll], policy: pol() }).plan(input());
    expect(gem.generate).not.toHaveBeenCalled();
  });
  it('o modelo ainda só escolhe um candidato do servidor: saída fora do contrato (comando) é descartada', async () => {
    const bad = pProvider('deepseek', true, { text: JSON.stringify({ kind: 'proposal', candidate: 's1', evidence: ['e1'], setFader: { channel: 8, db: 3 } }) });
    const r = await new TechnicalPlanner({ knowledge: knowledgePort, providers: [bad], policy: pol() }).plan(input());
    expect(r).toMatchObject({ kind: 'refusal', reason: 'invalid_model_output' });
  });
});
function knowgledgePortSafe() { return knowledgePort; }
