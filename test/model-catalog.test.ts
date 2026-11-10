import { expect, it, vi, afterEach } from 'vitest';
import { ModelCatalogService, SessionModelConsent, modelCatalogConfigSchema, selectionRequestSchema, type CatalogProviderDefinition, type CatalogProviderId, type CatalogActor, type ModelConsentPort } from '../src/ai/model-catalog/index.js';
import { UsageTracker } from '../src/ai/usage.js';
import { OpenAITextClient } from '../src/ai/model-catalog/openai.js';
const actor = (id = 'one'): CatalogActor => ({ id, role: 'operator' });
function fixture(extra: { price?: boolean; dailyBudgetUSD?: number; maxRequestsPerMinute?: number; active?: (actor: CatalogActor) => boolean; consent?: ModelConsentPort; generate?: (model: string) => Promise<any>; health?: () => Promise<any> } = {}) {
  const calls: string[] = [], tracker = new UsageTracker(null);
  const provider: CatalogProviderDefinition = { id: 'openai', enabled: true, configured: true, external: true, models: ['model-one'],
    price: () => extra.price === false ? undefined : { inputPerMTok: 1, outputPerMTok: 2 },
    create: model => ({ id: 'openai', external: true, model, health: extra.health ?? (async () => ({ reachable: true, chatModel: true, embedModel: false, detail: 'ok' })), embed: async () => undefined,
      generateDetailed: async () => { calls.push(model); return extra.generate ? extra.generate(model) : { text: 'advice', usage: { inputTokens: 8, outputTokens: 5 } }; } }),
  };
  const service = new ModelCatalogService({ config: modelCatalogConfigSchema.parse({ enabled: true, timeoutMs: 1000 }), providers: [provider], tracker,
    dailyBudgetUSD: extra.dailyBudgetUSD ?? 1, maxRequestsPerMinute: extra.maxRequestsPerMinute ?? 100,
    mode: () => 'lab', active: extra.active ?? (() => true), consent: extra.consent });
  const select = (id = 'one', model = 'model-one', expectedRevision = 0) => service.select(actor(id), { provider: 'openai', model, expectedRevision, confirmExternal: true });
  return { service, tracker, calls, select };
}
afterEach(() => vi.useRealTimers());
it('contrato versionado aceita IDs novos, recusa URLs, segredos e parâmetros de execução', () => {
  for (const provider of ['openai', 'gemini', 'deepseek', 'anthropic', 'ollama'] as const) {
    expect(selectionRequestSchema.safeParse({ schemaVersion: 1, provider, model: 'future-model-v9', expectedRevision: 0 }).success).toBe(true);
  }
  expect(selectionRequestSchema.safeParse({ schemaVersion: 1, provider: 'ollama', model: 'namespace/qwen:custom', expectedRevision: 0 }).success).toBe(true);
  for (const model of ['https://evil.invalid', '../bad', 'x y', 'model\nkey', 'a/b']) {
    expect(selectionRequestSchema.safeParse({ schemaVersion: 1, provider: 'openai', model, expectedRevision: 0 }).success).toBe(false);
  }
  expect(selectionRequestSchema.safeParse({ schemaVersion: 2, provider: 'openai', model: 'next-model', expectedRevision: 0 }).success).toBe(false);
  expect(selectionRequestSchema.safeParse({ schemaVersion: 1, provider: 'openai', model: 'next-model', expectedRevision: 0, apiKey: 'secret' }).success).toBe(false);
});
it('seleção e consentimento são por sessão e modelo; outra seleção não afeta outra sessão', async () => {
  const { service, select, calls } = fixture();
  await expect(service.select(actor(), { provider: 'openai', model: 'model-one', expectedRevision: 0 })).rejects.toMatchObject({ code: 'NOT_CONSENTED' });
  await select(); await select('two', 'model-two');
  expect(service.view(actor()).selection?.model).toBe('model-one');
  expect(service.view(actor('two')).selection?.model).toBe('model-two');
  await service.generate(actor(), 'sys', 'relato', 1);
  await service.generate(actor('two'), 'sys', 'relato', 1);
  expect(calls).toEqual(['model-one', 'model-two']);
  await expect(service.generate(actor('three'), 'sys', 'relato', 0)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  await expect(service.select(actor(), { provider: 'openai', model: 'model-two', expectedRevision: 1 })).rejects.toMatchObject({ code: 'NOT_CONSENTED' });
});
it('modelo sem preço fica explicitamente desconhecido e não gera chamada paga', async () => {
  const { service, select, calls, tracker } = fixture({ price: false });
  expect(service.view(actor()).providers[0].models[0]).toMatchObject({ price: null, generationAllowed: false });
  await select();
  await expect(service.generate(actor(), 'sys', 'relato', 1)).rejects.toMatchObject({ code: 'PRICE_UNKNOWN' });
  expect(calls).toEqual([]); expect(tracker.current().costUSD).toBe(0);
});
it('reserva global impede gasto concorrente; consumo informado reconcilia orçamento', async () => {
  let release!: (data: any) => void;
  const { service, select, tracker } = fixture({ dailyBudgetUSD: 0.004, generate: () => new Promise(r => { release = r; }) });
  await select(); await select('two');
  const pending = service.generate(actor(), 's', 'u', 1);
  await expect(service.generate(actor('two'), 's', 'u', 1)).rejects.toMatchObject({ code: 'BUDGET' });
  expect(tracker.current().reservedUSD).toBeGreaterThan(0);
  release({ text: 'ok', usage: { inputTokens: 8, outputTokens: 5 } });
  const result = await pending;
  expect(result.cost).toMatchObject({ estimatedUSD: 0.000018, usageReported: true });
  expect(tracker.current()).toMatchObject({ reservedUSD: 0, requests: 1, inputTokens: 8, outputTokens: 5 });
});
it('troca durante geração mantém modelo original no envio, cobra consumo e descarta resposta antiga', async () => {
  let release!: (data: any) => void;
  const { service, select, calls, tracker } = fixture({ generate: () => new Promise(r => { release = r; }) });
  await select(); const pending = service.generate(actor(), 's', 'u', 1);
  await select('one', 'model-two', 1);
  release({ text: 'old advice', usage: { inputTokens: 3, outputTokens: 2 } });
  await expect(pending).rejects.toMatchObject({ code: 'STALE' });
  expect(calls).toEqual(['model-one']); expect(service.view(actor()).selection?.model).toBe('model-two');
  expect(tracker.current().requests).toBe(1);
});
it.each(['revoke', 'logout', 'consent', 'stop'] as const)('resposta tardia após %s nunca é entregue', async change => {
  let release!: (data: any) => void, active = true;
  const consent = new SessionModelConsent();
  const { service, select, tracker } = fixture({ active: () => active, consent, generate: () => new Promise(r => { release = r; }) });
  await select(); const pending = service.generate(actor(), 's', 'u', 1);
  if (change === 'revoke') service.revoke('one');
  if (change === 'logout') active = false;
  if (change === 'consent') consent.revoke(actor());
  if (change === 'stop') service.stop();
  release({ text: 'private', usage: { inputTokens: 2, outputTokens: 1 } });
  await expect(pending).rejects.toBeInstanceOf(Error); expect(tracker.current().requests).toBe(1);
});
it('rate limit, revisão obsoleta e concorrência por sessão bloqueiam antes da chamada', async () => {
  let release!: (data: any) => void;
  const f = fixture({ generate: () => new Promise(r => { release = r; }) });
  await f.select(); const pending = f.service.generate(actor(), 's', 'u', 1);
  await expect(f.service.generate(actor(), 's', 'u', 1)).rejects.toMatchObject({ code: 'BUSY' });
  await expect(f.service.generate(actor(), 's', 'u', 0)).rejects.toMatchObject({ code: 'STALE' });
  release({ text: 'ok' }); await pending;
  const limited = fixture({ maxRequestsPerMinute: 1 }); await limited.select();
  await expect(limited.service.generate(actor(), 's', 'u', 1)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
});
it('timeout contabiliza reserva integral, não repete e ignora resposta posterior', async () => {
  vi.useFakeTimers();
  const f = fixture({ generate: () => new Promise(() => {}) }); await f.select();
  const pending = f.service.generate(actor(), 's', 'u', 1);
  await vi.advanceTimersByTimeAsync(1001);
  const result = await pending;
  expect(result.result.failure).toBe('timeout'); expect(result.cost.usageReported).toBe(false);
  expect(f.tracker.current()).toMatchObject({ reservedUSD: 0, requests: 1 }); expect(f.calls).toHaveLength(1);
});
it('consentimento da missão A pode ser injetado sem alterar seu módulo; recusa permanece fechada', async () => {
  const port: ModelConsentPort = { grant: vi.fn(), allowed: () => false, revoke: vi.fn() };
  const f = fixture({ consent: port }); await f.select();
  await expect(f.service.generate(actor(), 's', 'u', 1)).rejects.toMatchObject({ code: 'NOT_CONSENTED' });
  expect(port.grant).toHaveBeenCalledWith(actor(), expect.objectContaining({ provider: 'openai', model: 'model-one', revision: 1 }));
  expect(f.calls).toEqual([]);
});
it('limite de entrada conta bytes UTF-8 e preço não é fabricado', async () => {
  const f = fixture(); await f.select();
  await expect(f.service.generate(actor(), 's', '🎵'.repeat(4000), 1)).rejects.toMatchObject({ code: 'INVALID' });
  expect(f.calls).toHaveLength(0);
});
const openaiOK = () => ({ status: 'completed', model: 'custom-gpt', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'advice' }] }], usage: { input_tokens: 8, output_tokens: 5 } });
it('OpenAI: chave só em cabeçalho oficial, Responses sem ferramentas/armazenamento, uso real informado', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new OpenAITextClient('custom-gpt', 'FAKE_SERVER_KEY', { maxOutputTokens: 123, timeoutMs: 1000 }, async (url, init) => {
    calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify(String(url).includes('/models/') ? { id: 'custom-gpt' } : openaiOK()));
  });
  expect((await client.health()).chatModel).toBe(true);
  expect(await client.generateDetailed('s', 'u')).toMatchObject({ text: 'advice', usage: { inputTokens: 8, outputTokens: 5 } });
  const call = calls[1], body = JSON.parse(String(call.init.body));
  expect(call.url).toBe('https://api.openai.com/v1/responses');
  expect(body).toMatchObject({ model: 'custom-gpt', max_output_tokens: 123, store: false, stream: false });
  expect(body.tools).toBeUndefined(); expect(String(call.init.body)).not.toContain('FAKE_SERVER_KEY'); expect(call.url).not.toContain('FAKE_SERVER_KEY');
  expect(call.init.redirect).toBe('error'); expect(call.init.credentials).toBe('omit');
});
it.each([[401, 'auth'], [403, 'auth'], [429, 'quota'], [503, 'unavailable'], [404, 'error']] as const)('OpenAI HTTP %i é sanitizado (%s)', async (status, failure) => {
  const client = new OpenAITextClient('custom-gpt', 'FAKE_KEY', { maxOutputTokens: 64, timeoutMs: 1000 }, async () => new Response('FAKE_KEY private contents', { status }));
  expect(await client.generateDetailed('s', 'u')).toEqual({ failure });
});
it.each(['refusal', 'incomplete', 'tool', 'bad-json', 'missing', 'timeout'] as const)('OpenAI recusa saída %s sem executar ferramentas', async kind => {
  const client = new OpenAITextClient('custom-gpt', 'FAKE_KEY', { maxOutputTokens: 64, timeoutMs: 1000 }, async () => {
    if (kind === 'timeout') throw Object.assign(new Error('secret'), { name: 'TimeoutError' });
    const result = openaiOK();
    if (kind === 'refusal') result.output[0].content[0].type = 'refusal';
    if (kind === 'incomplete') result.status = 'incomplete';
    if (kind === 'tool') result.output[0].type = 'function_call';
    return new Response(kind === 'bad-json' ? 'invalid' : JSON.stringify(kind === 'missing' ? {} : result));
  });
  expect((await client.generateDetailed('s', 'u')).text).toBeUndefined();
});
it('seleções concorrentes não se sobrepõem e clear invalida uma validação ainda pendente', async () => {
  let release!: (data: any) => void;
  const f = fixture({ health: () => new Promise(r => { release = r; }) });
  const pending = f.select();
  await expect(f.select()).rejects.toMatchObject({ code: 'BUSY' });
  f.service.clear(actor(), 0);
  release({ reachable: true, chatModel: true, embedModel: false, detail: 'ok' });
  await expect(pending).rejects.toMatchObject({ code: 'STALE' });
  expect(f.service.view(actor()).selection).toBeNull();
});
it.each(['auth', 'quota', 'unavailable', 'refused', 'truncated'] as const)('falha %s nunca tenta outro provedor nem devolve texto parcial', async failure => {
  const f = fixture({ generate: async () => ({ text: 'should not display', failure }) }); await f.select();
  const result = await f.service.generate(actor(), 's', 'u', 1);
  expect(result.result.text).toBeUndefined(); expect(result.result.failure).toBe(failure); expect(f.calls).toHaveLength(1);
  expect(f.tracker.current().reservedUSD).toBe(0);
  if (failure === 'auth' || failure === 'quota') expect(f.tracker.current().costUSD).toBe(0);
  else expect(f.tracker.current().costUSD).toBeGreaterThan(0);
});
it('adapta o contrato ExternalConsent da missão A em instâncias por sessão, sem revogar outro operador', async () => {
  const { ExternalConsent } = await import('../src/server/external-consent.js');
  const backends: InstanceType<typeof ExternalConsent>[] = [];
  const consent = new SessionModelConsent(() => { const backend = new ExternalConsent(); backends.push(backend); return backend; });
  const f = fixture({ consent }); await f.select(); await f.select('two', 'model-two');
  expect(backends).toHaveLength(2);
  await f.service.generate(actor(), 's', 'u', 1); await f.service.generate(actor('two'), 's', 'u', 1);
  backends[0].revoke('one');
  await expect(f.service.generate(actor(), 's', 'u', 1)).rejects.toMatchObject({ code: 'NOT_CONSENTED' });
  await expect(f.service.generate(actor('two'), 's', 'u', 1)).resolves.toMatchObject({ execution: 'not_executable' });
});
it('registro legado compartilhado também bloqueia preço desconhecido em vez de inventar fallback', async () => {
  const { BudgetedProvider } = await import('../src/knowledge/local/budget.js');
  const generate = vi.fn(async () => ({ text: 'not sent' }));
  const provider = new BudgetedProvider({ id: 'deepseek', external: true, model: 'unknown-new-model', health: async () => ({ reachable: true, chatModel: true, embedModel: false, detail: 'ok' }), embed: async () => undefined, generateDetailed: generate },
    { tracker: new UsageTracker(null), dailyBudgetUSD: 1, maxRequestsPerMinute: 10, maxOutputTokens: 64, price: () => undefined });
  expect(await provider.generateDetailed('s', 'u')).toMatchObject({ failure: 'quota', reason: 'budget' });
  expect(generate).not.toHaveBeenCalled();
});
