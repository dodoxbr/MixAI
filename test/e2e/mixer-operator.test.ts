import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseChannels } from '../../src/core/config.js';
import { enter, launch, OPERATOR_PIN, startLab } from './harness.js';
let browser: Browser;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
it('interface existente: pergunta de destino, AUX5 explícito, aplicar, leitura e desfazer pelo mesmo executor LAB', async () => {
  const lab = await startLab({ channels: parseChannels({ channels: [{ number: 3, name: 'Violão', aliases: ['violao'] }], aux: [{ number: 1, name: 'Fones', aliases: ['fones'] }, { number: 5, name: 'Retorno Lucius', aliases: ['retorno do lucius'] }] }) });
  const { ctx, page } = await enter(browser, lab.base, OPERATOR_PIN);
  try {
    const say = async (text: string) => { await page.getByPlaceholder('O que você deseja ajustar?').fill(text); await page.getByRole('button', { name: 'Enviar' }).click(); };
    const card = () => page.locator('.proposal').last();
    const value = () => lab.mixer.read('ch.3.aux.5.level');
    await say('Sobe 2 dB do meu violão');
    await page.locator('.assist-options').getByRole('button', { name: 'AUX 5', exact: true }).waitFor();
    expect(value()).toMatchObject({ known: true, value: -20 });
    await page.locator('.assist-options').getByRole('button', { name: 'AUX 5', exact: true }).click();
    await card().getByRole('button', { name: 'Aplicar' }).waitFor();
    expect(await card().textContent()).toContain('AUX 5: Violão');
    expect(await card().textContent()).toContain('−18.0 dB');
    expect(value()).toMatchObject({ known: true, value: -20 });
    await card().getByRole('button', { name: 'Aplicar' }).click();
    await expect.poll(() => value()).toMatchObject({ known: true, value: -18 });
    await say('Desfaz o último ajuste');
    await expect.poll(() => card().textContent()).toContain('Desfazer o último ajuste');
    await card().getByRole('button', { name: 'Aplicar' }).click();
    await expect.poll(() => value()).toMatchObject({ known: true, value: -20 });
  } finally { await ctx.close(); await lab.server.close(); }
});
