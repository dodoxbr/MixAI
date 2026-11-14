import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Locator, Page, WebSocketRoute } from 'playwright';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { PROJECT_ROOT } from '../../src/core/config.js';
import { LocalKnowledge } from '../../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../../src/knowledge/local/store.js';
import { GeminiClient } from '../../src/knowledge/local/gemini.js';
import { OllamaClient } from '../../src/knowledge/local/ollama.js';
import { enter, launch, startLab, physicalBandChannels, MUSICIAN_PIN, OPERATOR_PIN, PHONE, YOGA } from './harness.js';

/**
 * AutoConfig de ponta a ponta pela TELA: relato (M1) → pergunta do planejador (C) → inspeção →
 * decisão humana → passo virtual digitado → autorização individual (D) → simulação → revisão →
 * referência salva. Somente LAB, provedores de IA falsos, nenhuma escrita no mixer.
 */
let browser: Browser;
const labs: Array<Awaited<ReturnType<typeof startLab>>> = [];
beforeAll(async () => { browser = await launch(); });
afterEach(async () => {
  for (const ctx of browser.contexts()) await ctx.close();
  for (const lab of labs.splice(0)) await lab.server.close();
  vi.restoreAllMocks();
});
afterAll(async () => { await browser.close(); });

async function lab(extra: Parameters<typeof startLab>[0] = {}) {
  const t = await startLab({ channels: physicalBandChannels(), ...extra }); labs.push(t); return t;
}
async function tell(page: Page, text: string) {
  await page.getByPlaceholder('O que você deseja ajustar?').fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await page.locator('.technical-text').last().filter({ hasText: 'Fred' }).waitFor({ state: 'attached' });
}
async function openEvent(page: Page, name = 'Jornada AutoConfig') {
  await page.getByRole('button', { name: 'Passagem de som', exact: true }).click();
  await page.getByLabel('Nome do evento da passagem', { exact: true }).fill(name);
  await page.getByLabel('Data da passagem', { exact: true }).fill('2026-11-09');
  await page.getByLabel('Operador da passagem', { exact: true }).fill('Operador LAB');
  await page.getByRole('button', { name: 'Iniciar passagem LAB', exact: true }).click();
  const auto = page.locator('mx-autoconfig');
  await auto.getByRole('button', { name: 'Consultar planejador técnico', exact: true }).waitFor();
  return auto;
}
function trace(page: Page) {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/autoconfig') || path === '/api/command')
      requests.push({ method: request.method(), path, body: request.method() === 'POST' ? request.postDataJSON() : undefined });
  });
  return requests;
}
const button = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem('mixai.token'));
async function post(page: Page, path: string, body: object) {
  return page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: 'POST', headers: { authorization: `Bearer ${sessionStorage.getItem('mixai.token')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { path, body });
}

it.each([{ label: 'Yoga', device: YOGA }, { label: 'celular', device: PHONE }])('$label: jornada completa relato → pergunta → inspeção → decisão → autorização → simulação → revisão → referência', async ({ device }) => {
  const t = await lab();
  const { page } = await enter(browser, t.base, OPERATOR_PIN, device);
  const before = t.controller.state.snapshot(), write = vi.spyOn(t.mixer, 'write'), execute = vi.spyOn(t.server.core, 'execute');
  const requests = trace(page);
  await tell(page, 'Fred está abafado no retorno');
  const auto = await openEvent(page);

  await button(auto, 'Consultar planejador técnico').click();
  await auto.getByText('O problema ocorre só nos fones ou também no PA?', { exact: true }).waitFor();
  const known = await auto.getByText(/Já informado no diagnóstico/).textContent();
  expect(known).toMatch(/canal/); expect(known).toMatch(/destino/); expect(known).toMatch(/sintoma/);
  expect(await auto.getByText('Qual fonte/canal será investigado?').count()).toBe(0); // M1 is reused, not asked again
  await button(auto, 'Só neste destino').click();
  await auto.getByText('Ocorre com a fonte sozinha ou só com o conjunto?', { exact: true }).waitFor();
  await button(auto, 'Só com a banda').click();

  const inspection = auto.getByRole('article', { name: 'Inspeção sugerida' });
  await inspection.waitFor();
  expect(await inspection.textContent()).toContain('Recomendação da IA — inspeção sugerida, não ajuste');
  expect(await inspection.textContent()).toContain('Justificativa:');
  expect(await inspection.textContent()).toContain('Relato do operador: abafado — não é medição');
  expect(await auto.getByRole('status').filter({ hasText: 'Modelo:' }).textContent()).toContain('Motor determinístico do MixAI');
  await inspection.locator('summary').click();
  expect(await inspection.locator('a[href^="https://"]').count()).toBeGreaterThan(0);
  expect(await inspection.textContent()).toContain('Não ouvi o som');
  expect(requests.some(r => r.method === 'POST' && r.path === '/api/autoconfig')).toBe(false);

  await button(auto, 'Só fazer a inspeção').click();
  await auto.getByText(/Combinado: só a inspeção/).waitFor();
  expect(requests.some(r => r.method === 'POST' && r.path === '/api/autoconfig')).toBe(false);
  await button(auto, 'Quero simular um passo de nível').click();
  const step = auto.getByLabel('Passo virtual do operador em dB', { exact: true });
  expect(await step.inputValue()).toBe('');
  const create = button(auto, 'Criar rascunho de simulação no servidor');
  expect(await create.isDisabled()).toBe(true);
  await step.fill('0.5');
  await create.click();
  await auto.getByRole('heading', { name: 'Revise cada teste', exact: true }).waitFor();
  expect(await auto.textContent()).toContain('Origem: inspeção sugerida pela IA');

  await button(auto, 'Preparar contexto no servidor (descarta aprovações)').click();
  const approve = button(auto, 'Solicitar autorização deste teste LAB');
  await approve.waitFor();
  expect(await button(auto, 'Executar este teste simulado').count()).toBe(0);
  await approve.click();
  await button(auto, 'Executar este teste simulado').click();
  await auto.getByText('Resultado SIMULADO — acústica não validada', { exact: true }).waitFor();
  expect(await auto.textContent()).toContain('Não comprova melhoria no som.');
  await button(auto, 'Confirmar resultado simulado').click();
  await auto.getByRole('status').filter({ hasText: 'Confirmado como cenário simulado' }).waitFor();
  await button(auto, 'Salvar referência virtual no servidor').click();
  await auto.getByText(/Referência v1/).waitFor();
  expect(await auto.textContent()).toContain('UNVERIFIED · não aplicada');

  const advice = requests.filter(r => r.path === '/api/autoconfig/suggestions').map(r => r.body);
  expect(advice).toHaveLength(3);
  expect(advice[0]).toEqual({ serverId: t.server.core.serverId, eventId: expect.any(String) });
  for (const b of advice.slice(1)) expect(Object.keys(b).sort()).toEqual(['answer', 'eventId', 'serverId']);
  expect(advice.map(b => b.answer?.value)).toEqual([undefined, 'target_only', 'ensemble']);
  expect(JSON.stringify(advice)).not.toMatch(/deltaDB|approv|scope|report/);
  const draft = requests.find(r => r.method === 'POST' && r.path === '/api/autoconfig')!.body;
  expect(draft).toMatchObject({ scope: 'AUX1', items: [{ operation: 'level_delta', channel: 3, deltaDB: 0.5 }] });
  expect(draft.items[0].evidence[0].text).toContain('Relato classificado: abafado');
  expect(draft.items[0].rationale).toContain('A IA não sugeriu valor');
  expect(requests.filter(r => r.body?.action).map(r => r.body.action)).toEqual(['prepare', 'approve', 'simulate', 'review', 'save']);
  expect(requests.find(r => r.body?.action === 'approve')!.body).toMatchObject({ confirmed: true, scope: 'simulation_only', digest: expect.any(String) });
  expect(requests.some(r => r.path === '/api/command')).toBe(false);
  expect(write).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  expect(t.controller.state.snapshot()).toEqual(before);

  expect(await auto.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Mesa', exact: true }).click();
  await page.locator('.mesa-main').waitFor();
});

const selection = JSON.stringify({ kind: 'proposal', candidate: 's1', evidence: ['e1'] });
async function modeledLab() {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-e2e-advisor-'));
  const calls: Array<{ url: string; body: string }> = [];
  const gemini = { mode: 'ok' as 'ok' | 'refuse' | 'defer', release: () => {}, started: () => {} };
  const fetchFn: typeof fetch = async (url, init) => {
    const address = String(url); calls.push({ url: address, body: init?.body ? String(init.body) : '' });
    if (address.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    if (address.endsWith('/api/chat')) return new Response(JSON.stringify({ message: { content: selection }, done_reason: 'stop' }));
    if (address.includes(':generateContent')) {
      if (gemini.mode === 'refuse') return new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }));
      if (gemini.mode === 'defer') { gemini.started(); await new Promise<void>(r => { gemini.release = r; }); }
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: selection }] } }] }));
    }
    return new Response('{}');
  };
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json')); await store.init();
  const knowledge = new LocalKnowledge({ store, seedDir: join(PROJECT_ROOT, 'knowledge/seed/banda-v1_2'), inboxDir: join(dir, 'inbox'), narrative: false, maxPassages: 3, maxDocumentBytes: 100000,
    chatProviders: [new OllamaClient({ url: 'http://127.0.0.1:11434', chatModel: 'qwen3:8b', embedModel: 'unused', embedDimensions: 8, timeoutMs: 1000 }, fetchFn),
      new GeminiClient({ chatModel: 'gemini-fixture', embedModel: 'embed-fixture', embedDimensions: 8, timeoutMs: 1000 }, 'FAKE-gemini-key-for-tests-0123456789abcdef', fetchFn)] });
  await knowledge.importSeed();
  const t = await lab({ dir, knowledge, knowledgeConfig: { enabled: true, ollama: { narrative: true, chatModel: 'qwen3:8b' }, gemini: { enabled: true, chatModel: 'gemini-fixture' } },
    geminiApiKey: 'FAKE-gemini-key-for-tests-0123456789abcdef', autoConfigPlannerFetch: fetchFn, autoConfigPlannerGeminiFetch: fetchFn });
  return { t, calls, gemini };
}

it('Ollama e Gemini simulados: modelo identificado, consentimento por sessão, recusa sem troca de provedor e resposta tardia descartada', async () => {
  const { t, calls, gemini } = await modeledLab();
  const a = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const write = vi.spyOn(t.mixer, 'write');
  await tell(a.page, 'Fred está abafado só no retorno, também sozinho.');
  const auto = await openEvent(a.page, 'Provedores simulados');
  const model = () => auto.getByRole('status').filter({ hasText: 'Modelo:' }).textContent();

  await button(auto, 'Consultar planejador técnico').click();
  await auto.getByRole('article', { name: 'Inspeção sugerida' }).waitFor();
  expect(await model()).toContain('Ollama local · qwen3:8b — no próprio computador');
  expect(calls.some(c => c.url.includes(':generateContent'))).toBe(false);

  // Same existing provider-selection endpoint; the configured (fake) key is reused, no new key.
  expect((await post(a.page, '/api/knowledge/providers', { chat: 'gemini', confirmExternal: true })).status).toBe(200);
  await button(auto, 'Consultar planejador novamente').click();
  await expect.poll(model).toContain('Gemini · gemini-fixture — serviço externo');
  const sent = calls.filter(c => c.url.includes(':generateContent')).map(c => c.body).join(' ');
  expect(sent).not.toMatch(/Fred|Fernando|Lucius|FAKE-gemini|Bearer|mixai\.token|abafado só/);

  // Another operator: global selection is Gemini, but no consent in THAT session → nothing sent.
  const b = await enter(browser, t.base, OPERATOR_PIN, PHONE);
  await tell(b.page, 'Fred está abafado só no retorno, também sozinho.');
  await b.page.getByRole('button', { name: 'Passagem de som', exact: true }).click();
  const events = b.page.getByLabel('Evento da passagem', { exact: true });
  await expect.poll(() => events.locator('option').count()).toBe(2);
  await events.selectOption({ index: 1 });
  const other = b.page.locator('mx-autoconfig');
  const geminiCalls = calls.filter(c => c.url.includes(':generateContent')).length;
  await button(other, 'Consultar planejador técnico').click();
  await other.getByRole('article', { name: 'Inspeção sugerida' }).waitFor();
  expect(await other.getByRole('status').filter({ hasText: 'Modelo:' }).textContent()).toContain('Ollama local');
  expect(await other.textContent()).toContain('Gemini: não confirmado nesta sessão — nada foi enviado');
  expect(calls.filter(c => c.url.includes(':generateContent')).length).toBe(geminiCalls);

  // Safety refusal: shown as-is, Ollama is NOT tried, no skeleton or plan.
  gemini.mode = 'refuse';
  const chats = calls.filter(c => c.url.endsWith('/api/chat')).length;
  await button(auto, 'Consultar planejador novamente').click();
  await auto.getByText('O modelo recusou — nenhum outro modelo foi tentado', { exact: true }).waitFor();
  expect(calls.filter(c => c.url.endsWith('/api/chat')).length).toBe(chats);
  expect(await auto.getByRole('article', { name: 'Inspeção sugerida' }).count()).toBe(0);

  // Late answer after the selection changed: the server discards it and the UI says so.
  gemini.mode = 'defer';
  const started = new Promise<void>(r => { gemini.started = r; });
  await button(auto, 'Consultar planejador novamente').click();
  await started;
  expect((await post(b.page, '/api/knowledge/providers', { chat: 'ollama' })).status).toBe(200);
  gemini.release();
  await auto.getByText(/O contexto mudou/).waitFor();
  expect(await auto.getByRole('article', { name: 'Inspeção sugerida' }).count()).toBe(0);
  expect((await t.http('/api/autoconfig', { token: (await token(a.page))! })).json.plans).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});

it('músico não vê AutoConfig e o servidor nega planejador e núcleo; agente MCP também', async () => {
  const t = await lab();
  const { page } = await enter(browser, t.base, MUSICIAN_PIN, PHONE, undefined, false);
  expect(await page.locator('mx-autoconfig').count()).toBe(0);
  expect((await post(page, '/api/autoconfig/suggestions', { serverId: t.server.core.serverId })).status).toBe(403);
  expect((await post(page, '/api/autoconfig', { serverId: t.server.core.serverId })).status).toBe(403);
  const anonymous = await fetch(`${t.base}/api/autoconfig/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: t.server.core.serverId }) });
  expect(anonymous.status).toBe(401);
});

it('perda de conexão bloqueia respostas; mudança do diagnóstico invalida a pergunta; sessão expirada volta ao login sem plano', async () => {
  const t = await lab();
  let outage = false;
  let blockedReconnects = 0;
  const liveSockets = new Set<WebSocketRoute>();
  const { page, ctx } = await enter(browser, t.base, OPERATOR_PIN, PHONE, async context => {
    // Only the app's loopback WS. Healthy traffic still reaches the actual LAB server.
    await context.routeWebSocket(url => url.pathname === '/ws', async socket => {
      if (outage) {
        blockedReconnects++;
        await socket.close({ code: 1013, reason: 'LAB test outage' });
        return;
      }
      liveSockets.add(socket);
      socket.connectToServer();
    });
  });
  const write = vi.spyOn(t.mixer, 'write');
  await tell(page, 'Fred está abafado no retorno');
  const auto = await openEvent(page, 'Falhas');
  await button(auto, 'Consultar planejador técnico').click();
  await auto.getByText('O problema ocorre só nos fones ou também no PA?', { exact: true }).waitFor();

  try {
    outage = true;
    // setOffline can black-hole the browser's native WS close notification. Close the
    // page side explicitly and keep reconnects blocked until every offline assertion.
    await Promise.all([...liveSockets].map(socket => socket.close({ code: 1001, reason: 'LAB test outage' })));
    for (const socket of t.server.https[0]!.websocketServer.clients) socket.terminate();
    await auto.getByText('Sem conexão — ações bloqueadas', { exact: true }).waitFor({ timeout: 15000 });
    // Prove this is a sustained WS outage, even while HTTP is still available.
    await expect.poll(() => blockedReconnects, { timeout: 15000 }).toBeGreaterThan(0);
    await ctx.setOffline(true);
    await auto.getByText('Sem conexão — ações bloqueadas', { exact: true }).waitFor({ timeout: 15000 });
    // No stale question survives; re-consulting remains blocked with HTTP offline too.
    expect(await button(auto, 'Só neste destino').count()).toBe(0);
    expect(await button(auto, 'Consultar planejador novamente').isDisabled()).toBe(true);
  } finally {
    outage = false;
    await ctx.setOffline(false);
  }
  await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
  // Reconnection may remount the soundcheck; re-select the event only if it was dropped.
  const restored = page.getByLabel('Evento da passagem', { exact: true });
  await expect.poll(() => restored.locator('option').count()).toBe(2);
  if (!(await restored.inputValue())) await restored.selectOption({ index: 1 });
  const reconsult = auto.getByRole('button', { name: /^Consultar planejador (novamente|técnico)$/ });
  await expect.poll(() => reconsult.isDisabled()).toBe(false);
  await reconsult.click();
  // The server still holds the M1 context: same pending question, nothing re-asked from scratch.
  await auto.getByText('O problema ocorre só nos fones ou também no PA?', { exact: true }).waitFor();
  await button(auto, 'Só neste destino').click();
  await auto.getByText('Ocorre com a fonte sozinha ou só com o conjunto?', { exact: true }).waitFor();

  // The diagnosis changes elsewhere: the pending question is stale and nothing advances.
  expect((await post(page, '/api/assistant/conversation', { text: 'Meu surdo está sem grave no PA' })).status).toBe(200);
  await button(auto, 'Só com a banda').click();
  await auto.getByText(/O contexto mudou/).waitFor();
  expect(await auto.getByText('Ocorre com a fonte sozinha ou só com o conjunto?', { exact: true }).count()).toBe(0);
  await button(auto, 'Consultar planejador novamente').click();
  await expect.poll(async () => (await auto.textContent())?.includes('Ocorre com a fonte sozinha')).toBe(false);

  await t.http('/api/logout', { token: (await token(page))!, body: {} });
  await page.locator('mx-login').waitFor();
  expect(await page.locator('mx-autoconfig').count()).toBe(0);
  const operator = await t.login(OPERATOR_PIN);
  expect((await t.http('/api/autoconfig', { token: operator })).json.plans).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});
