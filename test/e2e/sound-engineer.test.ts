import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bandChannels, enter, launch, MUSICIAN_PIN, OPERATOR_PIN, startLab } from './harness.js';

let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
const contexts: Array<{ close(): Promise<void> }> = [];
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close();
  for (const lab of labs.splice(0)) await lab.server.close();
});

describe('Sound Engineer no chat — consulta offline', () => {
  it('queixa → escolher PA → uma pergunta progressiva e fontes; zero propostas e zero escritas', async () => {
    const lab = await startLab({ channels: bandChannels() }); labs.push(lab);
    const { ctx, page } = await enter(browser, lab.base, OPERATOR_PIN); contexts.push(ctx);
    const before = lab.controller.state.snapshot();
    const write = vi.spyOn(lab.mixer, 'write');
    const proposals = vi.spyOn(lab.server.core.assistant!.builder, 'build');
    await page.getByPlaceholder('O que você deseja ajustar?').fill('Meu cavaco está estridente. O que podemos fazer?');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('.diagnostic-options').getByRole('button', { name: 'PA', exact: true }).click();
    const answer = page.locator('.technical-text').last();
    await expect.poll(() => answer.textContent()).toContain('Destino: PA');
    expect(await answer.textContent()).toContain('Acontece só no PA ou também nos fones?');
    expect((await answer.textContent())!.split(/\s+/).length).toBeLessThanOrEqual(120);
    expect(await answer.textContent()).not.toContain('Hipóteses alternativas');
    expect(await answer.textContent()).toContain('Não ouvi o som');
    expect(await page.locator('.technical-references a').count()).toBeGreaterThan(0);
    expect(await page.locator('.proposal').count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Aplicar', exact: true }).count()).toBe(0);
    expect(await page.locator('mx-pending-cards .card').count()).toBe(0);
    expect(lab.controller.state.snapshot()).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(proposals).not.toHaveBeenCalled();
    // Comando existente segue oferecendo cartão, sem aplicar automaticamente.
    await page.getByPlaceholder('O que você deseja ajustar?').fill('sobe o cavaco nos fones');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('.proposal').waitFor();
    expect(lab.controller.state.snapshot()).toEqual(before);
  });

  it('músico recebe recusa da consulta, mantendo o chat de comandos', async () => {
    const lab = await startLab({ channels: bandChannels() }); labs.push(lab);
    const { ctx, page } = await enter(browser, lab.base, MUSICIAN_PIN); contexts.push(ctx);
    await page.getByPlaceholder('O que você deseja ajustar?').fill('Meu cavaco está estridente no PA');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('.tone-error').waitFor();
    expect(await page.locator('.tone-error').textContent()).toContain('exclusiva do operador');
    expect(await page.locator('.technical-references').count()).toBe(0);
    expect(await page.locator('.diagnostic-options').count()).toBe(0);
  });
});
