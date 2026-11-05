import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { paramKey } from '../../src/core/revisions.js';
import { auxBus, MASTER } from '../../src/mixer/types.js';
import { bandChannels, enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, startLab } from './harness.js';

type Lab = Awaited<ReturnType<typeof startLab>>;
let browser: Browser;
const labs: Lab[] = [];
const contexts: Array<{ close: () => Promise<void> }> = [];
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
  for (const l of labs.splice(0)) await l.server.close();
});
async function lab(access?: 'pa_without_master') {
  const l = await startLab({ channels: bandChannels(), server: access ? { musicianAccess: access } : {} });
  labs.push(l);
  return l;
}
async function open(l: Lab, pin: string, device: object = PHONE) {
  const r = await enter(browser, l.base, pin, device);
  contexts.push(r.ctx);
  const errors: string[] = [];
  r.page.on('pageerror', (e) => errors.push(e.message));
  return { page: r.page, errors };
}
const v = (l: Lab, key: string) => (l.mixer.read(key as never) as { value?: unknown }).value;

describe('celular do músico', () => {
  it('fones_only (padrão): só FONES, sem abas de PA e sem MASTER', async () => {
    const l = await lab();
    const { page } = await open(l, MUSICIAN_PIN);
    expect(await page.getByRole('tab', { name: 'PA' }).count()).toBe(0);
    expect(await page.getByText('MASTER', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Aumentar Surdo no fone' }).click();
    await expect.poll(() => v(l, paramKey.level(9, auxBus(1)))).toBe(-18);
  });

  it('pa_without_master: abas PA e FONES identificadas; PA em passos e mute; nada de MASTER', async () => {
    const l = await lab('pa_without_master');
    const { page, errors } = await open(l, MUSICIAN_PIN);
    // começa nos FONES
    await page.getByRole('tab', { name: 'FONES', selected: true }).waitFor();
    await page.locator('.shared-warning .dest-FONES').waitFor();
    await page.getByRole('tab', { name: 'PA' }).click();
    await page.locator('.shared-warning .dest-PA').waitFor();
    expect(await page.getByText('MASTER', { exact: true }).count()).toBe(0);
    expect(await page.locator('mx-fader').count()).toBe(0); // no PA do músico não há fader para arrastar
    // cabe na largura do celular: sem rolagem horizontal e o botão + inteiro na tela
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const plus = (await page.getByRole('button', { name: 'Aumentar Voz Fernando no PA' }).boundingBox())!;
    expect(plus.x + plus.width).toBeLessThanOrEqual(PHONE.viewport.width);
    await expect.poll(() => page.getByTestId('pa-value-9').textContent()).toContain('−10.0 dB');
    await page.getByRole('button', { name: 'Aumentar Surdo no PA' }).click();
    await expect.poll(() => v(l, paramKey.level(9, MASTER))).toBe(-8);
    await expect.poll(() => page.getByTestId('pa-value-9').textContent()).toContain('−8.0 dB');
    await page.getByRole('button', { name: 'Mutar Pandeiro no PA' }).click();
    await expect.poll(() => v(l, paramKey.mute(7, MASTER))).toBe(true);
    await page.getByRole('button', { name: 'Abrir Pandeiro no PA' }).waitFor();
    // os FONES continuam iguais
    await page.getByRole('tab', { name: 'FONES' }).click();
    await page.getByRole('button', { name: 'Aumentar Surdo no fone' }).click();
    await expect.poll(() => v(l, paramKey.level(9, auxBus(1)))).toBe(-18);
    expect(v(l, paramKey.master())).toBe(-6);
    expect(errors).toEqual([]);
  });

  it('pa_without_master: pedido grande pelo assistente fica esperando o operador; só aplica com "Aprovar"', async () => {
    const l = await lab('pa_without_master');
    const phone = await open(l, MUSICIAN_PIN);
    const yoga = await open(l, OPERATOR_PIN, { viewport: { width: 1536, height: 960 }, hasTouch: true });
    const field = phone.page.getByPlaceholder('O que você deseja ajustar?');
    await field.fill('sobe o surdo'); // sem destino: agora pergunta
    await phone.page.getByRole('button', { name: 'Enviar' }).click();
    await phone.page.locator('.assist-options').getByRole('button', { name: 'PA' }).waitFor();
    await field.fill('aumenta bastante o surdo no PA'); // 5 dB
    await phone.page.getByRole('button', { name: 'Enviar' }).click();
    const card = phone.page.locator('.proposal').last();
    await card.locator('.proposal-approval').waitFor(); // avisa que precisa do operador
    await card.getByRole('button', { name: 'Aplicar' }).click();
    await phone.page.locator('.proposal-state').filter({ hasText: 'Aguardando aprovação' }).waitFor();
    expect(v(l, paramKey.level(9, MASTER))).toBe(-10);
    const pending = yoga.page.locator('.card').filter({ hasText: 'músico · sessão' });
    await pending.waitFor();
    await pending.getByRole('button', { name: 'Aprovar' }).click();
    await expect.poll(() => v(l, paramKey.level(9, MASTER))).toBe(-5);
    await phone.page.locator('.toast').filter({ hasText: 'Aprovado' }).waitFor();
  });
});
