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
export const DS_KEY = 'FAKE-deepseek-key-for-tests-0123456789';
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
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'temperature', 'thinking']); // sem tools/functions
    expect(body.thinking).toEqual({ type: 'disabled' }); // o raciocínio padrão da API consumiria o teto de tokens do resumo
    const g = fake(() => dsOk());
    await new DeepSeekClient({ chatModel: 'deepseek-flash', timeoutMs: 2000, thinking: 'default' }, DS_KEY, g.fetchFn).generateDetailed('s', 'u');
    expect(JSON.parse(g.calls[0]!.body).thinking).toBeUndefined();
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
    const none = await new TechnicalPlanner({ knowledge: knowledgePort, providers: [pProvider('deepseek', true, { failure: 'unavailable' }), oll], policy: pol(), fallbackToLocal: false }).plan(input());
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

// ---- regressão: consentimento unificado, revogação durante a operação, troca de modelo e fallback ----------------
const GEM_KEY = 'FAKE-gemini-key-for-tests-0123456789abcdef';
const gemOk = () => ({ json: { candidates: [{ content: { parts: [{ text: GOOD }] }, finishReason: 'STOP' }], modelVersion: 'gemini-2.5-flash' } });
const geminiClient = (f: ReturnType<typeof fake>, key: string | null = GEM_KEY) => new GeminiClient({ chatModel: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001', embedDimensions: DIMS, timeoutMs: 2000 }, key ?? undefined, f.fetchFn);
const deferred = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; };

describe('regressão: consentimento unificado (Gemini, DeepSeek, Anthropic)', () => {
  it('Gemini também exige o consentimento da sessão: sem ele nada é enviado e o Ollama assume', async () => {
    const f = fake(() => gemOk()); const { k } = await service({ chat: 'ollama', gemini: geminiClient(f) });
    await k.setChatProvider('gemini', true);
    f.calls.length = 0; // a verificação de saúde da seleção não conta
    const ctx = await ask(k);
    expect(f.calls).toHaveLength(0);
    expect(ctx.narrativeStatus).toMatchObject({ provider: 'ollama', fellBackFrom: 'gemini', fallbackReason: 'not_consented' });
    const allowed = await ask(k, yes);
    expect(allowed.narrative?.source).toBe('gemini'); expect(f.calls.some((c) => c.url.includes(':generateContent'))).toBe(true);
  });
  it('provedor selecionado (preferência gravada) + chave presente NÃO enviam nada sem consentimento (nova sessão)', async () => {
    for (const [name, build] of [
      ['gemini', async () => { const f = fake(() => gemOk()); return { f, ...(await service({ chat: 'ollama', gemini: geminiClient(f) })) }; }],
      ['deepseek', async () => { const f = fake((c) => c.url.endsWith('/models') ? { json: { data: [{ id: 'deepseek-flash' }] } } : dsOk()); return { f, ...(await service({ deepseek: deepseek(f) })) }; }],
      ['anthropic', async () => { const f = fake(() => anOk()); return { f, ...(await service({ anthropic: anthropic(f) })) }; }],
    ] as const) {
      const { f, k } = await build();
      await k.setChatProvider(name, true); // a escolha fica gravada na instância (como uma preferência de arquivo)
      f.calls.length = 0;
      const ctx = await ask(k); // "nova sessão": nenhum consentimento
      expect(f.calls.filter((c) => /generateContent|chat\/completions|\/messages/.test(c.url)), name).toHaveLength(0);
      expect(ctx.narrativeStatus?.fellBackFrom, name).toBe(name);
    }
  });
  it('embeddings externos (embedProvider gemini) também só com consentimento: sem ele, busca por palavras e nenhuma consulta sai', async () => {
    const f = fake((c) => c.url.includes(':batchEmbedContents') ? { json: { embeddings: [{ values: new Array(DIMS).fill(0.5) }] } } : gemOk());
    const dir = mkdtempSync(join(tmpdir(), 'mixai-emb-')); const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
    const k = new LocalKnowledge({ store, ollama: geminiClient(f), chatProviders: [fakeOllama().client], inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
    await k.importSeed();
    f.calls.length = 0;
    const denied = await k.search('microfonia no palco');
    expect(f.calls).toHaveLength(0); expect(denied.reason).toMatch(/sem consentimento/);
    await k.search('microfonia no palco', { externalAllowed: () => true });
    expect(f.calls.some((c) => c.url.includes(':batchEmbedContents'))).toBe(true);
  });
  it('preços padrão = tabela oficial da DeepSeek no horário de pico (cache miss)', () => {
    const p = parseConfig({}).knowledge.external.prices;
    expect(p['deepseek-flash']).toEqual({ inputPerMTok: 0.3, outputPerMTok: 1.2 });
    expect(p['deepseek-v4-pro']).toEqual({ inputPerMTok: 1.32, outputPerMTok: 3.96 });
  });
});

describe('regressão: revogação durante uma operação pendente (resumo)', () => {
  it('revogado enquanto o serviço responde: o resultado é descartado e não é exibido; nada novo é enviado depois', async () => {
    const d = deferred(); let granted = true;
    const f = fake((c) => c.url.includes('chat/completions') ? dsOk('RESUMO-NAO-DEVE-APARECER pode ser o ganho do microfone no palco') : { json: {} });
    const client = deepseek(f); const gen = client.generateDetailed.bind(client);
    client.generateDetailed = async (s, u) => { await d.gate; return gen(s, u); };
    const { k } = await service({ chat: 'deepseek', deepseek: client });
    const pending = ask(k, () => granted);
    await new Promise((r) => setTimeout(r, 50));
    granted = false; d.release();
    const ctx = await pending;
    expect(ctx.narrative).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain('RESUMO-NAO-DEVE-APARECER');
    expect(ctx.narrativeStatus).toMatchObject({ status: 'not_consented', provider: 'deepseek' });
    const before = f.calls.length;
    await ask(k, () => granted);
    expect(f.calls.length).toBe(before); // revogado: nenhum envio novo
  });
  it('revogado entre a falha do externo e o próximo envio: o externo não é chamado de novo', async () => {
    let n = 0; const f = fake(() => ({ status: 503 })); const { k } = await service({ chat: 'deepseek', deepseek: deepseek(f) });
    await ask(k, () => n++ === 0);
    await ask(k, () => false);
    expect(f.calls.filter((c) => c.url.includes('chat/completions')).length).toBeLessThanOrEqual(1);
  });
});

describe('regressão: servidor — consentimento, nova sessão, troca de modelo e revogação em operação', () => {
  async function bootReal(opts: { preselect?: 'deepseek' | 'gemini' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-extreal-'));
    const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
    const ollama = fakeOllama().client;
    const gate = deferred(); let hold = false;
    const fd = fake((c) => c.url.endsWith('/models') ? { json: { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } } : dsOk());
    const ds = deepseek(fd); const gen = ds.generateDetailed.bind(ds);
    ds.generateDetailed = async (s, u) => { if (hold) await gate.gate; return gen(s, u); };
    const gf = fake((c) => c.url.includes(':generateContent') ? gemOk() : { json: { name: 'x' } }); const gem = geminiClient(gf);
    const af = fake(() => anOk()); const an = anthropic(af);
    const knowledge = new LocalKnowledge({ store, ollama, chatProviders: [ollama, ds, gem, an], chat: opts.preselect, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: true });
    await knowledge.importSeed(); mkdirSync(join(dir, 'inbox'), { recursive: true }); writeFileSync(join(dir, 'inbox', 'shure-live.md'), PUBLIC_DOC); await knowledge.ingest();
    const t = await startTestServer({ knowledge, dir, channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8'))) }); servers.push(t);
    const open = async () => {
      const token = await t.login(OPERATOR_PIN); const c = await wsClient(t.base, token); sockets.push(c); await c.next((m) => m.type === 'snapshot'); let n = 0;
      const say = async (text = 'O Fred está microfonando no PA') => { const requestId = `q${++n}`; c.send({ type: 'assistant', requestId, text }); return (await c.next((m) => m.type === 'assistant_reply' && m.requestId === requestId, 15000)).reply; };
      const post = (json: unknown) => fetch(`${t.base}/api/knowledge/providers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(json) });
      const get = async () => (await fetch(`${t.base}/api/knowledge/providers`, { headers: { authorization: `Bearer ${token}` } })).json();
      return { token, say, post, get };
    };
    return { t, open, fd, gf, af, ds, an, gem, hold: (v: boolean) => { hold = v; }, release: gate.release };
  }
  const deepseekChats = (fd: ReturnType<typeof fake>) => fd.calls.filter((c) => c.url.includes('chat/completions'));

  it('provedor pré-selecionado com chave presente: sessão nova NÃO envia; confirmar nesta sessão libera; outra sessão não herda', async () => {
    const s = await bootReal({ preselect: 'deepseek' });
    const a = await s.open();
    const info = await a.get();
    expect(info.chat.selected).toBe('deepseek'); expect(info.sessionConsent).toBe(false); // a tela sabe que falta confirmar
    const r0 = await a.say();
    expect(deepseekChats(s.fd)).toHaveLength(0);
    expect(r0.knowledge?.narrative?.source ?? 'ollama').not.toBe('deepseek');
    const ok = await a.post({ chat: 'deepseek', confirmExternal: true });
    expect(ok.status).toBe(200); expect((await ok.json()).sessionConsent).toBe(true);
    const r1 = await a.say();
    expect(deepseekChats(s.fd).length).toBeGreaterThan(0);
    expect(r1.knowledge?.narrative).toMatchObject({ source: 'deepseek', model: 'deepseek-flash' });
    const b = await s.open(); // outra sessão do operador
    const sent = deepseekChats(s.fd).length;
    expect((await b.get()).sessionConsent).toBe(false);
    await b.say(); expect(deepseekChats(s.fd).length).toBe(sent);
  });
  it('Gemini pré-selecionado com chave presente: sessão nova também não envia', async () => {
    const s = await bootReal({ preselect: 'gemini' });
    const a = await s.open(); await a.say();
    expect(s.gf.calls.filter((c) => c.url.includes(':generateContent'))).toHaveLength(0);
    expect((await a.get()).sessionConsent).toBe(false);
  });
  it('troca de modelo sem confirmar é recusada e não muda modelo nem consentimento; com confirmar usa o novo modelo', async () => {
    const s = await bootReal(); const a = await s.open();
    expect((await a.post({ chat: 'deepseek', confirmExternal: true, model: 'deepseek-flash' })).status).toBe(200);
    await a.say(); expect(JSON.parse(deepseekChats(s.fd).at(-1)!.body).model).toBe('deepseek-flash');
    expect((await a.post({ chat: 'deepseek', model: 'deepseek-v4-pro' })).status).toBe(400); expect(s.ds.model).toBe('deepseek-flash');
    expect((await a.get()).sessionConsent).toBe(true); // nada mudou
    expect((await a.post({ chat: 'deepseek', confirmExternal: true, model: 'gpt-5' })).status).toBe(400); expect(s.ds.model).toBe('deepseek-flash');
    expect((await a.post({ chat: 'deepseek', confirmExternal: true, model: 'deepseek-v4-pro' })).status).toBe(200);
    await a.say(); expect(JSON.parse(deepseekChats(s.fd).at(-1)!.body).model).toBe('deepseek-v4-pro');
  });
  it('trocar para outro provedor apaga o consentimento do anterior; voltar a um externo exige confirmar de novo', async () => {
    const s = await bootReal(); const a = await s.open();
    await a.post({ chat: 'deepseek', confirmExternal: true });
    await a.post({ chat: 'gemini', confirmExternal: true });
    expect((await a.post({ chat: 'deepseek' })).status).toBe(400);
    const before = deepseekChats(s.fd).length;
    await a.post({ chat: 'ollama' }); await a.say();
    expect(deepseekChats(s.fd).length).toBe(before);
  });
  it('REVOGAÇÃO durante a operação pendente: a resposta tardia da DeepSeek não é exibida e nada novo sai', async () => {
    const s = await bootReal(); const a = await s.open();
    await a.post({ chat: 'deepseek', confirmExternal: true });
    s.hold(true);
    const pending = a.say();
    await new Promise((r) => setTimeout(r, 400));
    expect((await a.post({ chat: 'ollama' })).status).toBe(200); // revoga o consentimento no meio
    s.hold(false); s.release();
    const reply = await pending;
    expect(reply.knowledge?.narrative?.source).not.toBe('deepseek');
    expect(JSON.stringify(reply)).not.toContain('"source":"deepseek"');
    const sent = deepseekChats(s.fd).length;
    await a.say(); expect(deepseekChats(s.fd).length).toBe(sent);
  });
  it.each(['gemini','deepseek','anthropic'] as const)('consentimento/revogação/isolamento da sessão para %s', async provider => {
    const s = await bootReal(); const a = await s.open(); const b = await s.open();
    expect((await a.post({ chat:provider, confirmExternal:true })).status).toBe(200);
    expect((await a.get()).sessionConsent).toBe(true); expect((await b.get()).sessionConsent).toBe(false);
    const revoke = await fetch(`${s.t.base}/api/knowledge/providers/consent`, {method:'DELETE',headers:{authorization:`Bearer ${a.token}`}});
    expect(revoke.status).toBe(200); expect((await a.get()).sessionConsent).toBe(false);
    const sent = [...s.fd.calls,...s.gf.calls,...s.af.calls].filter(c=>/generateContent|chat\/completions|\/messages/.test(c.url)).length;
    await a.say(); expect([...s.fd.calls,...s.gf.calls,...s.af.calls].filter(c=>/generateContent|chat\/completions|\/messages/.test(c.url))).toHaveLength(sent);
    expect((await a.post({chat:provider,confirmExternal:true})).status).toBe(200);
    const p = s.t.server.core.auth.authenticate(a.token,'127.0.0.1')!;
    await s.t.http('/api/logout',{token:a.token,body:{}});
    expect(s.t.server.core.externalConsent.allowed(p,provider)).toBe(false);
  });
  it.each(['gemini','deepseek','anthropic'] as const)('revogar e reconfirmar %s (ABA) não ressuscita resposta antiga nem a guarda no cache', async provider => {
    const s=await bootReal();const a=await s.open();await a.post({chat:provider,confirmExternal:true});
    const client=provider==='deepseek'?s.ds:provider==='gemini'?s.gem:s.an;
    const calls=()=>[...s.fd.calls,...s.gf.calls,...s.af.calls].filter(c=>/generateContent|chat\/completions|\/messages/.test(c.url)).length;
    const began=deferred(), finish=deferred();const original=client.generateDetailed.bind(client);
    vi.spyOn(client,'generateDetailed').mockImplementationOnce(async (sys,user)=>{const result=await original(sys,user);began.release();await finish.gate;return result;});
    const pending=a.say();await began.gate;
    await fetch(`${s.t.base}/api/knowledge/providers/consent`,{method:'DELETE',headers:{authorization:`Bearer ${a.token}`}});
    expect((await a.post({chat:provider,confirmExternal:true})).status).toBe(200);
    expect((await a.get()).sessionConsent).toBe(true);
    finish.release();const reply=await pending;
    expect(reply.knowledge?.narrative).toBeUndefined();expect(reply.knowledge?.narrativeStatus.status).toBe('not_consented');
    const count=calls();await a.say();expect(calls()).toBeGreaterThan(count);
  });
  it('seleção pendente serializa modelos e não restaura consentimento revogado durante health',async()=>{
    const s=await bootReal();const a=await s.open();const b=await s.open();await a.post({chat:'deepseek',confirmExternal:true});
    const began=deferred(),finish=deferred();vi.spyOn(s.ds,'health').mockImplementationOnce(async()=>{began.release();await finish.gate;return {reachable:true,embedModel:false,chatModel:true,detail:'ok'};});
    const pending=a.post({chat:'deepseek',model:'deepseek-v4-pro',confirmExternal:true});await began.gate;
    expect((await a.get()).sessionConsent).toBe(false);
    expect((await b.post({chat:'anthropic',confirmExternal:true})).status).toBe(409);
    await fetch(`${s.t.base}/api/knowledge/providers/consent`,{method:'DELETE',headers:{authorization:`Bearer ${a.token}`}});finish.release();
    expect((await pending).status).toBe(409);expect(s.ds.model).toBe('deepseek-flash');expect((await a.get()).sessionConsent).toBe(false);
  });
  it('logout durante a seleção não concede uma sessão morta nem muda o modelo',async()=>{
    const s=await bootReal();const a=await s.open();const began=deferred(),finish=deferred();
    vi.spyOn(s.ds,'health').mockImplementationOnce(async()=>{began.release();await finish.gate;return {reachable:true,embedModel:false,chatModel:true,detail:'ok'};});
    const pending=a.post({chat:'deepseek',model:'deepseek-v4-pro',confirmExternal:true});await began.gate;await s.t.http('/api/logout',{token:a.token,body:{}});finish.release();
    expect((await pending).status).toBe(401);expect(s.ds.model).toBe('deepseek-flash');const b=await s.open();expect((await b.get()).sessionConsent).toBe(true); // Ollama local, nenhuma concessão externa.
    expect((await b.get()).chat.selected).toBe('ollama');
  });

});

describe('regressão: planejador — revogação durante a operação e fallback', () => {
  it('consentimento revogado enquanto o provedor externo responde: resposta tardia descartada (stale_policy), sem proposta', async () => {
    let consent = true; const d = deferred();
    const slow: PlannerProvider = { id: 'deepseek', external: true, generate: vi.fn(async () => { await d.gate; return { text: good, model: 'deepseek-flash' }; }) };
    const oll = pProvider('ollama', false);
    const planner = new TechnicalPlanner({ knowledge: knowledgePort, providers: [slow, oll], policy: () => ({ enabled: true, active: true, selected: 'deepseek', externalConsent: consent, revision: consent ? 1 : 2 }) });
    const pending = planner.plan(input());
    await new Promise((r) => setTimeout(r, 20));
    consent = false; d.release();
    const r = await pending;
    expect(r).toMatchObject({ kind: 'refusal', reason: 'stale_policy' });
    expect(oll.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('deepseek-flash');
    const again = await planner.plan(input()); // novo pedido sem consentimento: o externo nem é chamado
    expect(slow.generate).toHaveBeenCalledTimes(1); expect(again.provider.attempts[0]).toEqual({ provider: 'deepseek', status: 'not_consented' });
  });
  it('troca do provedor selecionado durante a operação invalida o resultado', async () => {
    let selected = 'anthropic'; const d = deferred();
    const slow: PlannerProvider = { id: 'anthropic', external: true, generate: vi.fn(async () => { await d.gate; return { text: good }; }) };
    const planner = new TechnicalPlanner({ knowledge: knowledgePort, providers: [slow, pProvider('ollama', false)], policy: () => ({ enabled: true, active: true, selected, externalConsent: true, revision: selected === 'anthropic' ? 1 : 2 }) });
    const pending = planner.plan(input()); await new Promise((r) => setTimeout(r, 20));
    selected = 'ollama'; d.release();
    expect(await pending).toMatchObject({ kind: 'refusal', reason: 'stale_policy' });
  });
});


describe('regressão: preços DeepSeek e estimativa conservadora UTF-8',()=>{
 it.each(['deepseek-flash','deepseek-v4-pro'] as const)('reserva e consumo em %s usam cache miss/pico sem chamar rede paga',async model=>{
  const price=parseConfig({}).knowledge.external.prices[model]!;const sys='é🎵'.repeat(100),user='surdo';const estimated=(Buffer.byteLength(sys)+Buffer.byteLength(user)+128)*price.inputPerMTok/1e6+600*price.outputPerMTok/1e6;
  const f=fake(()=>dsOk(GOOD,{model}));const tracker=new UsageTracker(null);const p=new BudgetedProvider(deepseek(f,DS_KEY,model),{tracker,dailyBudgetUSD:estimated-0.0000001,maxRequestsPerMinute:10,maxOutputTokens:600,price:()=>price});
  expect(await p.generateDetailed(sys,user)).toMatchObject({failure:'quota',reason:'budget'});expect(f.calls).toHaveLength(0);
  const usage=new UsageTracker(null);await new BudgetedProvider(deepseek(f,DS_KEY,model),{tracker:usage,dailyBudgetUSD:1,maxRequestsPerMinute:10,maxOutputTokens:600,price:()=>price}).generateDetailed(sys,user);
  expect(usage.current().costUSD).toBeCloseTo((120*price.inputPerMTok+40*price.outputPerMTok)/1e6,9);
 });
});


describe('regressão: embeddings externos com lease revogada',()=>{
 it('descarta vetor tardio e não usa dados pessoais no envio Gemini',async()=>{
  const f=fake(c=>c.url.includes(':batchEmbedContents')?{json:{embeddings:[{values:new Array(DIMS).fill(0.5)}]}}:gemOk());
  const dir=mkdtempSync(join(tmpdir(),'mixai-vector-lease-'));const store=new FileKnowledgeStore(join(dir,'k.json'));await store.init();const gem=geminiClient(f);
  const k=new LocalKnowledge({store,ollama:gem,chatProviders:[],inboxDir:join(dir,'inbox'),seedDir:join(PROJECT_ROOT,'knowledge','seed','banda-v1_2'),maxDocumentBytes:1048576,maxPassages:3,narrative:false});await k.importSeed();
  const search=vi.spyOn(store,'search'), began=deferred(),finish=deferred();let revision=1;const original=gem.embed.bind(gem);
  vi.spyOn(gem,'embed').mockImplementationOnce(async(...args)=>{const result=await original(...args);began.release();await finish.gate;return result;});
  const epoch=revision;const pending=k.search('Fred microfonia 10.10.1.1 123456',{externalAllowed:()=>revision===epoch});await began.gate;revision+=2;finish.release();const result=await pending;
  expect(search.mock.calls.at(-1)?.[1]).toBeUndefined();expect(result.reason).toMatch(/revogado/);const body=f.calls.find(c=>c.url.includes(':batchEmbedContents'))!.body;
  for(const secret of ['Fred','10.10.1.1','123456'])expect(body).not.toContain(secret);
 });
 it('revogação durante lote de ingestão não persiste vetores tardios nem reenvia lote',async()=>{
  const f=fake(c=>c.url.includes(':batchEmbedContents')?{json:{embeddings:(JSON.parse(c.body).requests as unknown[]).map(()=>({values:new Array(DIMS).fill(0.5)}))}}:{json:{name:'x'}});
  const dir=mkdtempSync(join(tmpdir(),'mixai-ingest-lease-'));const store=new FileKnowledgeStore(join(dir,'k.json'));await store.init();const gem=geminiClient(f);const k=new LocalKnowledge({store,ollama:gem,chatProviders:[],inboxDir:join(dir,'inbox'),seedDir:join(PROJECT_ROOT,'knowledge','seed','banda-v1_2'),maxDocumentBytes:1048576,maxPassages:3,narrative:false});await k.importSeed();mkdirSync(join(dir,'inbox'),{recursive:true});writeFileSync(join(dir,'inbox','shure-live.md'),PUBLIC_DOC);
  const began=deferred(),finish=deferred();let allowed=true;const original=gem.embed.bind(gem);vi.spyOn(gem,'embed').mockImplementationOnce(async(...args)=>{const result=await original(...args);began.release();await finish.gate;return result;});
  const pending=k.ingest({externalAllowed:()=>allowed});await began.gate;allowed=false;finish.release();const report=await pending;
  expect(report.items.find(i=>i.file==='shure-live.md')?.embedded).toBe(0);expect(f.calls.filter(c=>c.url.includes(':batchEmbedContents'))).toHaveLength(1);
 });
});
