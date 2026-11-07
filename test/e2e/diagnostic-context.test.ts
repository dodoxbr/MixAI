import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONTEXT_TTL_MS } from '../../src/assistant/diagnostic-context.js';
import { bandChannels, enter, launch, OPERATOR_PIN, PHONE, startLab, YOGA } from './harness.js';
let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
const contexts: Array<{ close(): Promise<void> }> = [];
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close();
  for (const lab of labs.splice(0)) await lab.server.close();
});
async function start(device = YOGA) {
  const lab = await startLab({ channels: bandChannels() }); labs.push(lab);
  const screen = await enter(browser, lab.base, OPERATOR_PIN, device); contexts.push(screen.ctx);
  return { lab, ...screen };
}
async function say(page: Page, text: string) {
  await page.getByPlaceholder('O que você deseja ajustar?').fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
}

async function finishChecks(page: Page) {
  await page.locator('.diagnostic-options').last().getByRole('button', { name: 'Só no PA', exact: true }).click();
  await page.locator('.diagnostic-options').last().getByRole('button', { name: 'Só com a banda', exact: true }).click();
  await page.locator('.diagnostic-options').last().getByRole('button', { name: 'Melhorou', exact: true }).click();
}

describe('B3B conversa contextual na interface', () => {
  it.each([{ name: 'Yoga', device: YOGA }, { name: 'celular', device: PHONE }])('$name: queixa → PA, sem repetir relato nem alterar a mesa', async ({ device }) => {
    const { lab, page } = await start(device);
    const before = lab.controller.state.snapshot();
    const write = vi.spyOn(lab.mixer, 'write');
    const build = vi.spyOn(lab.server.core.assistant!.builder, 'build');
    await say(page, 'Meu cavaco está estridente.');
    const pending = page.getByRole('status', { name: 'Diagnóstico pendente' });
    await pending.waitFor();
    expect(await pending.textContent()).toContain('Cavaco');
    expect(await page.locator('.chat-question').textContent()).toContain('PA');
    expect(await page.locator('.chat-question').count()).toBe(1);
    const box = await pending.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await say(page, 'PA.');
    await finishChecks(page);
    await pending.waitFor({ state: 'detached' });
    expect(await page.locator('.technical-text').last().textContent()).toContain('Cavaco (canal 1). Destino: PA');
    expect(await page.locator('.technical-references a').count()).toBeGreaterThan(0);
    expect(await page.locator('.proposal').count()).toBe(0);
    expect(write).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled();
    expect(lab.controller.state.snapshot()).toEqual(before);
  });

  it('celular: responde fonte, muda assunto, cancela e comandos diretos continuam disponíveis', async () => {
    const { page, lab } = await start(PHONE);
    await say(page, 'Minha voz está abafada');
    const pending = page.getByRole('status', { name: 'Diagnóstico pendente' });
    await pending.waitFor();
    await say(page, 'Fred');
    await expect.poll(() => pending.textContent()).toContain('Voz Fred');
    await say(page, 'Meu surdo está magro');
    await expect.poll(() => pending.textContent()).toContain('Surdo');
    await pending.getByRole('button', { name: 'Cancelar diagnóstico' }).click();
    await pending.waitFor({ state: 'detached' });
    await say(page, 'PA');
    await page.locator('.assist-text').filter({ hasText: 'Não há esclarecimento pendente' }).waitFor();
    await say(page, 'Meu cavaco está estridente');
    await pending.waitFor();
    await say(page, 'muta o cavaco no PA');
    await page.locator('.proposal').waitFor();
    expect(await pending.count()).toBe(0);
    expect(lab.controller.state.snapshot().revision).toBe(0);
  });

  it('prazo e novo login não recuperam investigação anterior', async () => {
    const { page, lab } = await start();
    await say(page, 'Meu cavaco está estridente');
    const pending = page.getByRole('status', { name: 'Diagnóstico pendente' });
    await pending.waitFor();
    lab.clock.advance(CONTEXT_TTL_MS); lab.server.core.sweep();
    await say(page, 'PA');
    await page.locator('.assist-text').filter({ hasText: 'expirou ou mudou' }).waitFor();
    expect(await pending.count()).toBe(0);
    await say(page, 'Meu cavaco está estridente'); await pending.waitFor();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor();
    for (const digit of OPERATOR_PIN) await page.getByRole('button', { name: digit, exact: true }).click();
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
    await say(page, 'PA');
    await page.locator('.assist-text').filter({ hasText: 'Não há esclarecimento pendente' }).waitFor();
    expect(await page.locator('.technical-text').count()).toBe(0);
    expect(lab.server.core.assistant!.diagnosticContexts.size).toBe(0);
  });

  it('duas abas na mesma sessão recusam revisão antiga sem reutilizar o cavaco para o surdo', async () => {
    const { page, ctx, lab } = await start();
    await say(page, 'Meu cavaco está estridente');
    await page.locator('.diagnostic-context').waitFor();
    const storage = await page.evaluate(() => ({ token: sessionStorage.getItem('mixai.token')!, role: sessionStorage.getItem('mixai.role')!, serverId: sessionStorage.getItem('mixai.serverId')! }));
    const second = await ctx.newPage();
    await second.addInitScript(data => {
      sessionStorage.setItem('mixai.token', data.token); sessionStorage.setItem('mixai.role', data.role); sessionStorage.setItem('mixai.serverId', data.serverId);
    }, storage);
    await second.goto(lab.base);
    await second.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
    await say(second, 'Meu surdo está magro'); await second.locator('.diagnostic-context').waitFor();
    await say(page, 'PA');
    await page.locator('.assist-text').filter({ hasText: 'expirou ou mudou' }).waitFor();
    expect(await page.locator('.diagnostic-context').textContent()).toContain('Surdo');
    expect(await page.locator('.proposal').count()).toBe(0);
    await say(page, 'PA');
    await finishChecks(page);
    await page.locator('.diagnostic-context').waitFor({ state: 'detached' });
    expect(await page.locator('.technical-text').last().textContent()).toContain('Surdo (canal 9). Destino: PA');
    expect(lab.controller.state.snapshot().revision).toBe(0);
  });
});
