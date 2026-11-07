import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { PROJECT_ROOT } from '../../src/core/config.js';
import { GeminiClient } from '../../src/knowledge/local/gemini.js';
import { OllamaClient } from '../../src/knowledge/local/ollama.js';
import { LocalKnowledge } from '../../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../../src/knowledge/local/store.js';
import { enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, YOGA, physicalBandChannels, startLab } from './harness.js';

// Base de conhecimento na interface real: servidor LAB + build Angular + Chromium.
// Ollama é falso (determinístico, sem rede); a base é o arquivo local numa pasta temporária.
let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async () => { browser = await launch(); });
afterEach(async () => { for (const ctx of browser.contexts()) await ctx.close(); for (const t of labs.splice(0)) await t.server.close(); vi.restoreAllMocks(); });
afterAll(async () => { await browser.close(); });

const DOC = '# Microfonia\n\nA microfonia depende do ganho e do posicionamento do microfone no palco. Reduza o retorno do vocal para evitar a realimentação.\n\n# Voz abafada\n\nO efeito de proximidade aumenta os graves quando o vocal chega perto do microfone e deixa a voz abafada.';
const GOOD = 'Pode ser que o ganho esteja alto; o operador pode conferir o posicionamento do microfone.';

function fakeOllama(opts: { up?: boolean; chat?: string } = {}) {
  const { up = true, chat = GOOD } = opts;
  const fetchFn = async (input: URL | string, init?: RequestInit) => {
    if (!up) throw new TypeError('ECONNREFUSED');
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'bge-m3:latest' }, { name: 'llama3.2:3b' }] }));
    if (url.endsWith('/api/embed')) {
      const vec = (t: string) => { const v = new Array(8).fill(0.01); if (/microfonia|feedback|apit/i.test(t)) v[0] = 1; if (/abafad|graves|proximidade/i.test(t)) v[1] = 1; return v; };
      return new Response(JSON.stringify({ embeddings: (body.input as string[]).map(vec) }));
    }
    if (url.endsWith('/api/chat')) return new Response(JSON.stringify({ message: { content: chat } }));
    return new Response('{}', { status: 404 });
  };
  return new OllamaClient({ url: 'http://127.0.0.1:11434', embedModel: 'bge-m3', chatModel: 'llama3.2:3b', embedDimensions: 8, timeoutMs: 2000 }, fetchFn as unknown as typeof fetch);
}

async function lab(opts: { ollama?: OllamaClient; narrative?: boolean; ingested?: boolean; seeded?: boolean; gemini?: GeminiClient; chat?: 'ollama' | 'gemini' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-e2e-k-'));
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json'));
  await store.init();
  const knowledge = new LocalKnowledge({ store, ollama: opts.ollama, chatProviders: opts.ollama ? [opts.ollama, ...(opts.gemini ? [opts.gemini] : [])] : undefined, chat: opts.chat, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: opts.narrative ?? false });
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  writeFileSync(join(dir, 'inbox', 'shure-live.md'), DOC);
  if (opts.seeded !== false) await knowledge.importSeed();
  if (opts.ingested) await knowledge.ingest();
  const t = await startLab({ channels: physicalBandChannels(), knowledge, dir });
  labs.push(t);
  return { t, knowledge, store, dir };
}

const open = async (page: Page) => {
  await page.getByRole('region', { name: 'Base de conhecimento' }).getByRole('button', { name: 'Abrir' }).click();
  return page.getByRole('region', { name: 'Base de conhecimento' });
};
const ask = async (page: Page, text: string) => {
  await page.getByPlaceholder('O que você deseja ajustar?').fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
};

for (const [label, device] of [['Yoga', YOGA], ['celular', PHONE]] as const) {
  it(`painel de administração: importa o pacote, ingere a pasta, pesquisa e cadastra o microfone — ${label}`, async () => {
    const { t } = await lab({ ollama: fakeOllama(), seeded: false });
    const { page } = await enter(browser, t.base, OPERATOR_PIN, device);
    const writes = vi.spyOn(t.mixer, 'write');
    const panel = await open(page);
    await panel.getByRole('status').first().waitFor();
    expect(await panel.textContent()).toContain('Base: arquivo local');
    expect(await panel.textContent()).toContain('Ollama: ligado');
    expect(await panel.textContent()).toContain('Busca: motor determinístico'); // ainda sem documentos

    await panel.getByRole('button', { name: 'Importar pacote base' }).click();
    await expect.poll(() => panel.textContent()).toContain('Pacote base importado.');
    expect(await panel.locator('.knowledge-sources li').count()).toBeGreaterThanOrEqual(10);
    expect(await panel.getByRole('table', { name: 'Microfones por canal' }).textContent()).toContain('Fred');

    await panel.getByRole('button', { name: 'Ingerir pasta de documentos' }).click();
    await expect.poll(() => panel.textContent()).toContain('ingested · shure-live.md');
    expect(await panel.textContent()).toContain('Busca: semântica');

    await panel.getByLabel('Pesquisar na base de conhecimento').fill('microfonia no palco');
    await panel.getByRole('button', { name: 'Pesquisar' }).click();
    await expect.poll(() => panel.locator('.knowledge-passages li').count()).toBeGreaterThan(0);
    expect(await panel.locator('.knowledge-passages').textContent()).toMatch(/microfonia/i);
    expect(await panel.locator('.knowledge-passages a[href^="https://"]').count()).toBeGreaterThan(0);

    // Cadastro do microfone do CH5 (Leandro): só o operador confirma, e nada vai para a mesa.
    const select = panel.getByLabel('Modelo do microfone no CH5');
    await select.selectOption({ label: 'AKG Perception P3 S' });
    await expect.poll(() => panel.textContent()).toContain('CH5: microfone confirmado.');
    await expect.poll(() => panel.getByRole('row').filter({ hasText: 'Leandro' }).textContent()).toContain('confirmado na tela');
    expect(writes).not.toHaveBeenCalled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

it('músico nunca vê a administração da base', async () => {
  const { t } = await lab({ ollama: fakeOllama(), ingested: true });
  const { page } = await enter(browser, t.base, MUSICIAN_PIN, YOGA, undefined, false);
  await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
  expect(await page.getByRole('region', { name: 'Base de conhecimento' }).count()).toBe(0);
});

it('chat: diagnóstico mostra trechos com links, ficha do P3 S, resumo não verificado e nenhuma proposta', async () => {
  const { t } = await lab({ ollama: fakeOllama(), narrative: true, ingested: true });
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const writes = vi.spyOn(t.mixer, 'write');
  await ask(page, 'O Fred está microfonando no PA');
  const block = page.locator('.knowledge-block').last();
  await block.waitFor({ state: 'attached' });
  await page.locator('.technical-details').last().locator('summary').click();
  expect(await block.textContent()).toContain('busca semântica');
  expect(await block.textContent()).toContain('CH3 Fred');
  expect(await block.textContent()).toContain('AKG Perception P3 S');
  expect(await block.textContent()).toContain('Resumo do modelo local · não verificado, teoria a conferir');
  expect(await block.textContent()).toContain(GOOD);
  expect(await block.locator('.technical-references li').count()).toBeGreaterThan(0);
  expect(await page.locator('.proposal').count()).toBe(0);
  expect(await page.locator('.card-actions button').count()).toBe(0);
  expect(writes).not.toHaveBeenCalled();
});

it('chat: resumo do modelo com phantom é descartado e a tela explica por quê (sem mostrar o texto)', async () => {
  const { t } = await lab({ ollama: fakeOllama({ chat: 'Pode ser o phantom desligado; o operador pode conferir o cabo e o microfone.' }), narrative: true, ingested: true });
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  await ask(page, 'O Fred está microfonando no PA');
  const block = page.locator('.knowledge-block').last();
  await block.waitFor({ state: 'attached' });
  await page.locator('.technical-details').last().locator('summary').click();
  expect(await block.textContent()).toContain('Resumo do modelo local descartado por segurança');
  expect(await block.textContent()).not.toMatch(/phantom desligado/);
  expect(await block.textContent()).not.toContain('não verificado, teoria a conferir');
  expect(await page.locator('.proposal').count()).toBe(0);
});

it('continuidade: escolher o vocalista mantém o diagnóstico e leva a ficha do microfone do canal', async () => {
  const { t } = await lab({ ollama: fakeOllama(), ingested: true });
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const writes = vi.spyOn(t.mixer, 'write');
  await ask(page, 'Minha voz está abafada no retorno');
  await page.locator('.chat-question').waitFor();
  await page.locator('.diagnostic-options').getByRole('button', { name: 'Fred', exact: true }).click();
  await expect.poll(() => page.locator('.chat-context').last().textContent()).toContain('Voz Fred (canal 3)');
  const details = page.locator('.technical-details').last();
  await details.locator('summary').click();
  const block = details.locator('.knowledge-block');
  await expect.poll(() => block.textContent()).toContain('CH3 Fred');
  expect(await block.textContent()).toContain('Roteiro teórico relacionado: Voz abafada no retorno (sem execução).');
  expect(await block.locator('.technical-references li').count()).toBeGreaterThan(0);
  expect(await page.locator('.proposal').count()).toBe(0);
  expect(writes).not.toHaveBeenCalled();
});

it('Ollama indisponível: busca por palavras, painel avisa e o diagnóstico continua', async () => {
  // sem Ollama a ingestão grava só texto (sem embeddings) e a busca cai para palavras
  const { t } = await lab({ ollama: fakeOllama({ up: false }), ingested: true });
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const panel = await open(page);
  await panel.getByRole('status').first().waitFor();
  expect(await panel.textContent()).toContain('Ollama: desligado');
  expect(await panel.textContent()).toContain('Busca: por palavras');
  await ask(page, 'O Fred está microfonando no PA');
  const block = page.locator('.knowledge-block').last();
  await block.waitFor({ state: 'attached' });
  await page.locator('.technical-details').last().locator('summary').click();
  expect(await block.textContent()).toContain('busca por palavras');
  expect(await block.textContent()).toContain('Ollama indisponível');
  expect(await page.locator('.technical-text').last().textContent()).toContain('Não ouvi o som');
  expect(await page.locator('.proposal').count()).toBe(0);
});

it('base indisponível: painel mostra aviso, ações falham com mensagem curta e o diagnóstico segue pelo motor determinístico', async () => {
  const { t, store } = await lab({ ollama: fakeOllama(), ingested: true });
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const panel = await open(page);
  await panel.getByRole('status').first().waitFor();
  const boom = new Error('connect ECONNREFUSED 127.0.0.1:5433 senha=segredo');
  vi.spyOn(store, 'search').mockRejectedValue(boom);
  vi.spyOn(store, 'getMicrophones').mockRejectedValue(boom);
  vi.spyOn(store, 'importPack').mockRejectedValue(boom);

  await panel.getByRole('button', { name: 'Importar pacote base' }).click();
  const alert = panel.getByRole('alert');
  await alert.waitFor();
  expect(await alert.textContent()).toMatch(/Base indisponível no momento|Sem resposta da base/);
  expect(await page.content()).not.toMatch(/segredo|ECONNREFUSED|5433/);

  await ask(page, 'O Fred está microfonando no PA');
  const block = page.locator('.knowledge-block').last();
  await block.waitFor({ state: 'attached' });
  await page.locator('.technical-details').last().locator('summary').click();
  expect(await block.textContent()).toContain('só o motor determinístico');
  expect(await block.textContent()).toContain('CH3 Fred'); // ficha do pacote versionado
  expect(await page.locator('.technical-text').last().textContent()).toContain('Não ouvi o som');
  expect(await page.locator('.proposal').count()).toBe(0);
  expect(await page.content()).not.toMatch(/segredo|ECONNREFUSED|5433/);
});

// ---- Provedor do resumo (Ollama local × Gemini externo) ---------------------------------------
const KEY = 'FAKE-gemini-key-for-tests-0123456789abcdef';
const GEMINI_TEXT = 'Pode ser que o retorno esteja alto demais; o operador pode conferir a posição do microfone.';
function fakeGemini(opts: { chat?: { status: number } } = {}) {
  const sent: string[] = [];
  const fetchFn = async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    sent.push(`${url}\n${String(init?.body ?? '')}\n${JSON.stringify(init?.headers ?? {})}`);
    if (url.includes(':generateContent')) {
      return opts.chat ? new Response('detalhe-interno', { status: opts.chat.status }) : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: GEMINI_TEXT }] }, finishReason: 'STOP' }] }));
    }
    return new Response('{}');
  };
  return { sent, client: new GeminiClient({ chatModel: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001', embedDimensions: 8, timeoutMs: 2000 }, KEY, fetchFn as unknown as typeof fetch) };
}

it('provedor: sem Gemini habilitado a escolha não existe; com ele o operador lê o aviso, consente e passa a usá-lo', async () => {
  const none = await lab({ ollama: fakeOllama(), narrative: true, ingested: true });
  const a = await enter(browser, none.t.base, OPERATOR_PIN, YOGA);
  const panelA = await open(a.page);
  await panelA.getByRole('status').first().waitFor();
  expect(await panelA.locator('input[name=chat-provider]').count()).toBe(0);
  await a.ctx.close();

  const g = fakeGemini();
  const { t } = await lab({ ollama: fakeOllama(), narrative: true, ingested: true, gemini: g.client });
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const writes = vi.spyOn(t.mixer, 'write');
  const panel = await open(page);
  await panel.getByRole('radiogroup', { name: 'Provedor do resumo' }).waitFor();
  expect(await panel.textContent()).toContain('Em uso: Ollama (local)');
  expect(g.sent).toHaveLength(0); // abrir o painel não chama o serviço externo

  await panel.getByLabel('Gemini (serviço externo do Google)').check();
  expect(await panel.getByRole('note').textContent()).toContain('saem deste computador para o Google');
  const apply = panel.getByRole('button', { name: 'Aplicar provedor' });
  expect(await apply.isDisabled()).toBe(true);
  await panel.getByLabel('Entendo e aceito enviar esses dados ao serviço externo.').check();
  await expect.poll(() => apply.isDisabled()).toBe(false);
  await apply.click();
  await expect.poll(() => panel.textContent()).toContain('Em uso: Gemini (externo)');

  await ask(page, 'O Fred está microfonando no PA, senha 987654');
  const block = page.locator('.knowledge-block').last();
  await block.waitFor({ state: 'attached' });
  await page.locator('.technical-details').last().locator('summary').click();
  expect(await block.textContent()).toContain('Resumo do Gemini (serviço externo) · não verificado, teoria a conferir');
  expect(await block.textContent()).toContain(GEMINI_TEXT);
  expect(await page.locator('.proposal').count()).toBe(0);
  expect(writes).not.toHaveBeenCalled();

  const outgoing = g.sent.filter((x) => x.includes(':generateContent')).join('\n');
  expect(outgoing).toContain('microfonia');
  expect(outgoing).not.toMatch(/Fred|987654/);
  expect(outgoing).toContain('o músico');
  expect(await page.content()).not.toContain(KEY);
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain(KEY);
});

it('provedor: Gemini com cota esgotada → o modelo local assume, a tela explica e não vaza detalhes', async () => {
  const g = fakeGemini({ chat: { status: 429 } });
  const { t } = await lab({ ollama: fakeOllama({ chat: 'Pode ser o cabo; o operador pode conferir a ligação do microfone no palco.' }), narrative: true, ingested: true, gemini: g.client, chat: 'gemini' });
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const panel = await open(page);
  await expect.poll(() => panel.textContent()).toContain('Em uso: Gemini (externo)');
  await ask(page, 'O Fred está microfonando no PA');
  const block = page.locator('.knowledge-block').last();
  await block.waitFor({ state: 'attached' });
  await page.locator('.technical-details').last().locator('summary').click();
  expect(await block.textContent()).toContain('Resumo do modelo local · não verificado, teoria a conferir');
  expect(await block.textContent()).toContain('Resumo gerado pelo modelo local porque o Gemini atingiu o limite de uso.');
  expect(await page.content()).not.toMatch(/detalhe-interno|AIza/);
  expect(await page.locator('.proposal').count()).toBe(0);
});
