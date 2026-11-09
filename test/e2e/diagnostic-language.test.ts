import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { enter, launch, OPERATOR_PIN, PHONE, YOGA, physicalBandChannels, startLab } from './harness.js';

/** A2 na interface real: relatos naturais, relato vago com esclarecimento e a mensagem de exemplos. Nenhuma escrita na mesa. */
let browser: Browser; const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async () => { browser = await launch(); });
afterEach(async () => { for (const ctx of browser.contexts()) await ctx.close(); for (const t of labs.splice(0)) await t.server.close(); vi.restoreAllMocks(); });
afterAll(async () => { await browser.close(); });

const send = async (page: Page, text: string) => {
  await page.getByPlaceholder('O que você deseja ajustar?').fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
};
const lastQuestion = (page: Page) => page.locator('.chat-question').last();
const cancel = async (page: Page) => {
  const c = page.getByRole('button', { name: /Cancelar diagnóstico/ });
  if (await c.count()) { await c.first().click(); await page.waitForTimeout(300); }
};

for (const [label, device] of [['Yoga', YOGA], ['celular', PHONE]] as const) {
  it(`frases naturais da banda e relato vago — ${label}`, async () => {
    const t = await startLab({ channels: physicalBandChannels() }); labs.push(t);
    const { page } = await enter(browser, t.base, OPERATOR_PIN, device);
    const writes = vi.spyOn(t.mixer, 'write');

    // relato vago: UMA pergunta objetiva (o sintoma) e só opções de descrição do som; nada de proposta
    await send(page, 'O som do violão está horrível');
    await expect.poll(() => lastQuestion(page).innerText()).toContain('Qual sintoma');
    const options = await page.locator('.diagnostic-options').last().locator('button').allInnerTexts();
    expect(options.length).toBeLessThanOrEqual(6);
    expect(options.map((o) => o.trim())).toEqual(expect.arrayContaining(['abafado', 'estridente', 'magro']));
    expect(await page.locator('.proposal').count()).toBe(0);
    await page.locator('.diagnostic-options').last().getByRole('button', { name: 'estridente', exact: true }).click();
    await expect.poll(() => lastQuestion(page).innerText()).not.toContain('Qual sintoma');
    await cancel(page);

    // relatos naturais entendidos pelo motor existente: mostram a fonte e perguntam o destino (uma pergunta por vez)
    for (const phrase of ['Falta grave no surdo', 'O Fred não aparece quando o coro entra', 'Coro cobrindo a voz do Fred', 'Tá microfonando quando o Fred canta']) {
      await send(page, phrase);
      await expect.poll(() => lastQuestion(page).innerText(), { message: phrase }).toMatch(/PA|FONES|retorno/i);
      expect(await page.locator('.proposal').count(), phrase).toBe(0);
      await cancel(page);
    }

    // frase que o sistema não entende: os exemplos incluem relatos de problema, e nada foi ajustado
    await send(page, 'blá blá blá qualquer coisa');
    await expect.poll(() => page.locator('.assist-log').innerText()).toContain('A voz está abafada no retorno');
    expect(await page.locator('.assist-log').innerText()).toContain('Nada foi ajustado');
    expect(writes).not.toHaveBeenCalled();
  });
}
