import { mkdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, YOGA, startLab } from './harness.js';

let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async () => { browser = await launch(); });
afterEach(async () => { for (const ctx of browser.contexts()) await ctx.close(); for (const t of labs.splice(0)) await t.server.close(); vi.restoreAllMocks(); });
afterAll(async () => { await browser.close(); });

const fixture = () => ({ chat: { selected: 'ollama', options: [
  { id: 'ollama', configured: true, external: false },
  { id: 'gemini', configured: true, external: true },
  { id: 'deepseek', configured: false, external: true, model: 'ds-small', models: ['ds-small', 'ds-large'] },
  { id: 'anthropic', configured: true, external: true, model: 'claude-a', models: ['claude-a', 'claude-b'] },
] }, narrative: true, embed: { id: 'ollama', external: false }, externalFallback: 'ollama' });

async function providerFixture(ctx: BrowserContext) {
  let response = fixture(); const bodies: Record<string, unknown>[] = [];
  await ctx.route('**/api/knowledge/providers', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); bodies.push(body);
      response.chat.selected = body.chat;
      if (body.model) response.chat.options.find(o => o.id === body.chat)!.model = body.model;
    }
    await route.fulfill({ json: response });
  });
  return bodies;
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Inteligência Artificial' });
  await expect.poll(() => panel.getByLabel('Seleção ativa no servidor').textContent()).toContain('Ollama');
  return panel;
}

for (const [name, device] of [['desktop', { viewport: { width: 1440, height: 960 } }], ['yoga', YOGA], ['celular', PHONE]] as const) {
  it(`${name}: configuração acessível, consentimento, erro e modelo; nunca comando da mesa`, async () => {
    const t = await startLab(); labs.push(t); const writes = vi.spyOn(t.mixer, 'write'); let bodies: Record<string, unknown>[] = [];
    const { page } = await enter(browser, t.base, OPERATOR_PIN, device, async ctx => { bodies = await providerFixture(ctx); });
    const panel = await open(page);
    expect(await panel.getByRole('radio').count()).toBe(5);
    expect(await panel.locator('.state').allTextContents()).toEqual(['Configurado', 'Configurado', 'Não configurado', 'Configurado', 'Indisponível']);
    expect(bodies).toHaveLength(0);
    await panel.getByRole('radio', { name: /OpenAI/ }).check();
    await expect.poll(() => panel.getByRole('button', { name: 'Aplicar seleção' }).isDisabled()).toBe(true);
    await panel.getByRole('radio', { name: /DeepSeek/ }).check();
    await expect.poll(() => panel.textContent()).toContain('Falta configurar a chave');
    await panel.getByRole('radio', { name: /Anthropic/ }).check();
    await panel.getByLabel('Modelo do provedor').waitFor();
    const save = panel.getByRole('button', { name: 'Aplicar seleção' });
    await expect.poll(() => save.isDisabled()).toBe(true);
    await panel.getByRole('checkbox').check(); await expect.poll(() => save.isEnabled()).toBe(true);
    await panel.getByLabel('Modelo do provedor').selectOption('claude-b');
    await expect.poll(() => panel.getByRole('checkbox').isChecked()).toBe(false);
    await panel.getByRole('checkbox').check();
    expect(await panel.textContent()).toContain('Custo desconhecido');
    expect(await panel.textContent()).toContain('Limite de gasto: não disponível');
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (process.env['MIXAI_CAPTURE_PROVIDER_UI'] === '1') {
      mkdirSync('docs/ai-providers/screenshots', { recursive: true });
      if (name === 'celular') await panel.screenshot({ path: 'docs/ai-providers/screenshots/celular-consentimento.png' });
      await panel.evaluate(el => { el.scrollTop = 0; });
      await panel.screenshot({ path: `docs/ai-providers/screenshots/${name}.png` });
    }
    await save.click();
    await expect.poll(() => panel.getByLabel('Seleção ativa no servidor').textContent()).toContain('Anthropic');
    expect(bodies).toEqual([{ chat: 'anthropic', model: 'claude-b', confirmExternal: true }]);
    await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
    expect(await page.getByRole('button', { name: 'Configurações', exact: true }).evaluate(el => document.activeElement === el)).toBe(true);
    // Reopening never restores the checkbox, even when the backend keeps an active selection.
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    const reopened = page.getByRole('dialog'); await reopened.getByRole('checkbox').waitFor();
    expect(await reopened.getByRole('checkbox').isChecked()).toBe(false);
    await reopened.getByRole('button', { name: 'Fechar configurações de IA' }).focus();
    await page.keyboard.press('Shift+Tab');
    expect(await reopened.evaluate(el => el.contains(document.activeElement))).toBe(true);
    expect(writes).not.toHaveBeenCalled();
  });
}

it('erro de API/401 e troca de sessão não expõem informações antigas nem detalhes internos', async () => {
  const t = await startLab(); labs.push(t);
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA, async ctx => { await providerFixture(ctx); });
  const panel = await open(page);
  await page.route('**/api/knowledge/providers', route => route.fulfill({ status: 401, json: { code: 'UNAUTHORIZED', message: 'PRIVATE-KEY-DETAIL' } }));
  await panel.getByRole('button', { name: 'Atualizar estado' }).click();
  await expect.poll(() => panel.textContent()).toContain('Sessão encerrada');
  expect(await panel.textContent()).not.toContain('PRIVATE-KEY-DETAIL');
  expect(await panel.getByLabel('Seleção ativa no servidor').textContent()).toContain('não disponível');
  expect(await panel.getByRole('button', { name: 'Aplicar seleção' }).isDisabled()).toBe(true);
});

it('músico não recebe o painel e a API mantém a autorização server-side', async () => {
  const t = await startLab(); labs.push(t);
  const { page } = await enter(browser, t.base, MUSICIAN_PIN, PHONE, undefined, false);
  expect(await page.getByRole('button', { name: 'Configurações', exact: true }).count()).toBe(0);
  const token = await page.evaluate(() => sessionStorage.getItem('mixai.token'));
  const response = await page.request.get('/api/knowledge/providers', { headers: { authorization: `Bearer ${token}` } });
  // Knowledge is disabled in this isolated fixture; no operator capability leaks.
  expect([403, 404]).toContain(response.status());
});
