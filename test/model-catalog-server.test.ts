import { expect, it, vi, afterEach } from 'vitest';
import { startTestServer, OPERATOR_PIN, MUSICIAN_PIN } from './server-support.js';
import type { CatalogProviderId } from '../src/ai/model-catalog/index.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(t => t.server.close())); });
const secret = 'FAKE_MODEL_CATALOG_SERVER_KEY_123456';
const keys = { openai: secret + '_OPENAI', gemini: secret + '_GEMINI', deepseek: secret + '_DEEPSEEK', anthropic: secret + '_ANTHROPIC' };
const models = ['future-model-one', 'future-model-two'];
const all = ['ollama', 'gemini', 'deepseek', 'anthropic', 'openai'] as const;
async function boot(extra: { mode?: 'lab' | 'mock'; unknownPrice?: boolean; missingKey?: boolean; deniedModel?: boolean; deferred?: boolean } = {}) {
  const calls: Array<{ url: string; body: any; headers: unknown }> = [];
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(r => { started = r; });
  const modelCatalogFetch: typeof fetch = async (url, init) => {
    const address = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: address, body, headers: init?.headers });
    if (!body) {
      if (extra.deniedModel) return new Response('secret provider error', { status: 403 });
      if (address.endsWith('/api/tags')) return Response.json({ models: models.map(name => ({ name })) });
      if (address === 'https://api.deepseek.com/models') return Response.json({ data: models.map(id => ({ id })) });
      return Response.json({ id: address.split('/').at(-1) });
    }
    started(); if (extra.deferred) await new Promise<void>(r => { release = r; });
    if (address.endsWith('/responses')) return Response.json({ status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Texto consultivo fictício.' }] }], usage: { input_tokens: 8, output_tokens: 5 } });
    if (address.endsWith('/messages')) return Response.json({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Texto consultivo fictício.' }], usage: { input_tokens: 8, output_tokens: 5 } });
    if (address.endsWith('/chat/completions')) return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: 'Texto consultivo fictício.' } }], usage: { prompt_tokens: 8, completion_tokens: 5 } });
    if (address.includes(':generateContent')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Texto consultivo fictício.' }] } }], usageMetadata: { promptTokenCount: 8, totalTokenCount: 13 } });
    if (address.endsWith('/api/chat')) return Response.json({ done_reason: 'stop', message: { content: 'Texto consultivo fictício.' }, prompt_eval_count: 8, eval_count: 5 });
    throw Error('Unexpected fake URL');
  };
  const prices = extra.unknownPrice ? {} : Object.fromEntries(models.map(model => [model, { inputPerMTok: 1, outputPerMTok: 2 }]));
  const t = await startTestServer({ mode: extra.mode, modelCatalog: { enabled: true, providers: Object.fromEntries(all.map(id => [id, { enabled: true, models, prices }])) }, modelCatalogFetch,
    openaiApiKey: extra.missingKey ? undefined : keys.openai, geminiApiKey: keys.gemini, deepseekApiKey: keys.deepseek, aiKey: keys.anthropic });
  servers.push(t); const token = await t.login(OPERATOR_PIN);
  const select = (provider: CatalogProviderId, model = models[0], expectedRevision = 0, session = token) => t.http('/api/ai/models/selection', { token: session, body: { schemaVersion: 1, provider, model, expectedRevision, confirmExternal: true } });
  return { t, token, select, calls, waiting, release: () => release() };
}
it.each(all)('%s: ID livre validado na API, cliente existente com modelo independente e limite de tokens', async provider => {
  const f = await boot(); const writes = vi.spyOn(f.t.mixer, 'write'), execute = vi.spyOn(f.t.server.core, 'execute'), before = f.t.controller.state.snapshot();
  const view = await f.t.http('/api/ai/models', { token: f.token });
  expect(view.status).toBe(200); expect(view.json.providers).toHaveLength(5); expect(f.calls).toHaveLength(0);
  expect((await f.select(provider)).status).toBe(200);
  const result = await f.t.http('/api/ai/models/complete', { token: f.token, body: { schemaVersion: 1, expectedRevision: 1, text: 'Relato sintético.' } });
  expect(result.status).toBe(200); expect(result.json.result).toMatchObject({ text: 'Texto consultivo fictício.', usage: { inputTokens: 8, outputTokens: 5 } });
  expect(result.json).toMatchObject({ execution: 'not_executable', selection: { provider, model: models[0] } });
  const generation = f.calls.find(c => c.body)!;
  if (provider === 'gemini') expect(generation.url).toContain(models[0] + ':generateContent'); else expect(generation.body.model).toBe(models[0]);
  const limit = provider === 'openai' ? generation.body.max_output_tokens : provider === 'gemini' ? generation.body.generationConfig.maxOutputTokens : provider === 'ollama' ? generation.body.options.num_predict : generation.body.max_tokens;
  if (provider !== 'ollama') {
    const sent = JSON.stringify(generation.headers);
    expect(sent).toContain(keys[provider]);
    for (const [id, key] of Object.entries(keys)) if (id !== provider) expect(sent).not.toContain(key);
  }
  if (provider === 'ollama') expect(result.json.cost).toMatchObject({ estimatedUSD: 0, status: 'local_no_api_charge' });
  expect(limit).toBe(1024); expect(JSON.stringify(generation.body)).not.toContain(secret);
  expect(JSON.stringify(view.json) + JSON.stringify(result.json)).not.toContain(secret);
  expect(writes).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(f.t.controller.state.snapshot()).toEqual(before);
});
it('sessões escolhem modelos diferentes, sem alterar preferências globais do diagnóstico ou AutoConfig', async () => {
  const f = await boot(), other = await f.t.login(OPERATOR_PIN);
  await f.select('openai'); await f.select('deepseek', models[1], 0, other);
  const a = (await f.t.http('/api/ai/models', { token: f.token })).json;
  const b = (await f.t.http('/api/ai/models', { token: other })).json;
  expect(a.selection).toMatchObject({ provider: 'openai', model: models[0] }); expect(b.selection).toMatchObject({ provider: 'deepseek', model: models[1] });
  expect(f.t.server.core.externalConsent.allowed({ id: 'unknown', role: 'operator', label: 'fixture' }, 'openai')).toBe(false);
});
it('operator-only, sem origem estrangeira/credenciais no corpo; consentimento deve ser explícito e por modelo', async () => {
  const f = await boot(), musician = await f.t.login(MUSICIAN_PIN);
  expect((await f.t.http('/api/ai/models', { token: musician })).status).toBe(403);
  expect((await f.t.http('/api/ai/models')).status).toBe(401);
  const body = { schemaVersion: 1, provider: 'openai', model: models[0], expectedRevision: 0 };
  expect((await f.t.http('/api/ai/models/selection', { token: f.token, body })).status).toBe(403);
  expect(f.calls).toHaveLength(0);
  for (const extra of [{ apiKey: secret }, { tools: [] }, { url: 'https://evil.invalid' }, { approved: true }, { sessionId: 'other' }]) {
    expect((await f.t.http('/api/ai/models/selection', { token: f.token, body: { ...body, ...extra, confirmExternal: true } })).status).toBe(400);
  }
  const origin = await fetch(f.t.base + '/api/ai/models/selection', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: JSON.stringify({ ...body, confirmExternal: true }) });
  expect(origin.status).toBe(403); expect(f.calls).toHaveLength(0);
});
it('modelos desconhecidos/não autorizados e chave ausente falham sem geração nem vazamento', async () => {
  const missing = await boot({ missingKey: true }); expect((await missing.select('openai')).json.code).toBe('NOT_CONFIGURED'); expect(missing.calls).toHaveLength(0);
  const denied = await boot({ deniedModel: true }); const failure = await denied.select('openai');
  expect(failure.status).toBe(422); expect(failure.json.code).toBe('MODEL_UNAVAILABLE'); expect(JSON.stringify(failure.json)).not.toContain(secret);
  expect(denied.calls.every(c => !c.body)).toBe(true);
});
it('custo desconhecido não é inventado; seleção só valida e geração é bloqueada', async () => {
  const f = await boot({ unknownPrice: true }); await f.select('openai');
  const r = await f.t.http('/api/ai/models/complete', { token: f.token, body: { schemaVersion: 1, expectedRevision: 1, text: 'fixture' } });
  expect(r.status).toBe(409); expect(r.json.code).toBe('PRICE_UNKNOWN'); expect(f.calls.every(c => !c.body)).toBe(true);
});
it('LAB exclusivo; default desligado não monta rotas', async () => {
  const f = await boot({ mode: 'mock' }); expect((await f.t.http('/api/ai/models', { token: f.token })).status).toBe(404); expect(f.calls).toHaveLength(0);
  const t = await startTestServer(); servers.push(t); expect((await t.http('/api/ai/models', { token: await t.login(OPERATOR_PIN) })).status).toBe(404);
});
it('logout durante resposta pendente descarta o texto, revoga seleção e mantém contabilização', async () => {
  const f = await boot({ deferred: true }); await f.select('openai');
  const pending = f.t.http('/api/ai/models/complete', { token: f.token, body: { schemaVersion: 1, expectedRevision: 1, text: 'fixture' } });
  await f.waiting; await f.t.http('/api/logout', { token: f.token, body: {} }); f.release();
  const r = await pending; expect(r.status).toBe(401); expect(JSON.stringify(r.json)).not.toContain('Texto consultivo');
  const newToken = await f.t.login(OPERATOR_PIN); expect((await f.t.http('/api/ai/models', { token: newToken })).json.selection).toBeNull();
});

it('limpar seleção revoga apenas a sessão, exige revisão e não restaura consentimento no login seguinte', async () => {
  const f = await boot(), other = await f.t.login(OPERATOR_PIN);
  await f.select('openai'); await f.select('openai', models[1], 0, other);
  const clear = await f.t.http('/api/ai/models/selection', { method: 'DELETE', token: f.token, body: { schemaVersion: 1, expectedRevision: 1 } });
  expect(clear.status).toBe(200); expect(clear.json).toMatchObject({ selection: null, revision: 2, consent: { granted: false } });
  expect((await f.t.http('/api/ai/models', { token: other })).json.consent.granted).toBe(true);
  expect((await f.select('openai', models[0], 1)).json.code).toBe('STALE');
  const r = await f.t.http('/api/ai/models/complete', { token: f.token, body: { schemaVersion: 1, expectedRevision: 2, text: 'fixture' } });
  expect(r.json.code).toBe('NOT_CONFIGURED');
});
it.each(['constructor', 'toString'])('modelo %s não herda um preço do protótipo JavaScript', async model => {
  const f = await boot(); expect((await f.select('openai', model)).status).toBe(200);
  const result = await f.t.http('/api/ai/models/complete', { token: f.token, body: { schemaVersion: 1, expectedRevision: 1, text: 'fixture' } });
  expect(result.json.code).toBe('PRICE_UNKNOWN'); expect(f.calls.every(c => !c.body)).toBe(true);
});
it.each(['gemini', 'deepseek', 'anthropic', 'openai'] as const)('%s: revogar e reconfirmar o mesmo modelo não revive uma geração anterior (#93)', async provider => {
  const f = await boot({ deferred: true });
  const before = f.t.controller.state.snapshot(), write = vi.spyOn(f.t.mixer, 'write'), execute = vi.spyOn(f.t.server.core, 'execute');
  expect((await f.select(provider)).status).toBe(200);
  const pending = f.t.http('/api/ai/models/complete', { token: f.token, body: { schemaVersion: 1, expectedRevision: 1, text: 'Relato sintético pendente.' } });
  await f.waiting;
  const clear = await f.t.http('/api/ai/models/selection', { method: 'DELETE', token: f.token, body: { schemaVersion: 1, expectedRevision: 1 } });
  expect(clear.status).toBe(200); expect(clear.json.consent.granted).toBe(false);
  const confirmed = await f.select(provider, models[0], 2);
  expect(confirmed.status).toBe(200); expect(confirmed.json).toMatchObject({ revision: 3, consent: { granted: true } });
  f.release();
  const old = await pending;
  expect(old.status).toBe(409); expect(old.json.code).toBe('STALE'); expect(JSON.stringify(old.json)).not.toContain('Texto consultivo');
  expect(f.calls.filter(call => call.body)).toHaveLength(1); // No replay after reconsent.
  const view = await f.t.http('/api/ai/models', { token: f.token });
  expect(view.json).toMatchObject({ revision: 3, consent: { granted: true }, usage: { requests: 1, inputTokens: 8, outputTokens: 5, reservedUSD: 0 } });
  expect(write).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(f.t.controller.state.snapshot()).toEqual(before);
});
it('instâncias do consentimento #93 isolam dois operadores Gemini e preservam o fluxo legado', async () => {
  const f = await boot(), other = await f.t.login(OPERATOR_PIN);
  const legacyRevision = f.t.server.core.externalConsent.revision;
  await f.select('gemini'); await f.select('gemini', models[1], 0, other);
  expect((await f.t.http('/api/ai/models', { token: f.token })).json.consent.granted).toBe(true);
  expect((await f.t.http('/api/ai/models', { token: other })).json.consent.granted).toBe(true);
  await f.t.http('/api/ai/models/selection', { method: 'DELETE', token: f.token, body: { schemaVersion: 1, expectedRevision: 1 } });
  const result = await f.t.http('/api/ai/models/complete', { token: other, body: { schemaVersion: 1, expectedRevision: 1, text: 'Relato sintético da outra sessão.' } });
  expect(result.status).toBe(200); expect(result.json.selection).toMatchObject({ provider: 'gemini', model: models[1] });
  expect(f.t.server.core.externalConsent.revision).toBe(legacyRevision);
});
