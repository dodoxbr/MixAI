import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { readonlyRealServer } from '../support/readonly-real-server.js';
import { enter, launch, OPERATOR_PIN, YOGA, PHONE } from './harness.js';
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => browser.close());
for (const [label, device] of [
  ['Yoga', YOGA],
  ['celular', PHONE],
] as const)
it('read-only physical transport events update every PA and AUX MUTE button without page reload, polling or SETD — ' + label, async () => {
  const s = await readonlyRealServer();
  const base = await s.app.listen({ port: 0, host: '127.0.0.1' });
  const { ctx, page } = await enter(browser, base, OPERATOR_PIN, device);
  try {
    // A navegação atual (PR #106) chama o destino de envios de 'AUX SENDS'; a aba antiga 'FONES' não existe mais.
    for (const bus of ['PA', 'AUX SENDS']) {
      await page.getByRole('tab', { name: bus === 'PA' ? 'MIX / GAIN' : bus, exact: true }).click();
      for (let ch = 1; ch <= 11; ch++) {
        const strip = page
          .locator('mx-strip')
          .filter({ has: page.getByText('CH ' + ch, { exact: true }) });
        const button = strip.getByRole('button', { name: 'MUTE', exact: true });
        for (const value of [1, 0]) {
          s.fake
            .last()
            .deliver(
              `SETD^i.${ch - 1}.${bus === 'PA' ? 'mute' : 'aux.0.mute'}^${value}`,
            );
          await expect
            .poll(() => button.getAttribute('aria-pressed'))
            .toBe(value ? 'true' : 'false');
        }
      }
    }
    expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
  } finally {
    await ctx.close();
    await s.close();
  }
});
for (const [label, device] of [
  ['Yoga', YOGA],
  ['celular', PHONE],
] as const)
  it(
    'edits local channel/AUX names and aliases in existing settings — ' + label,
    async () => {
      const s = await readonlyRealServer();
      const base = await s.app.listen({ port: 0, host: '127.0.0.1' });
      const { ctx, page } = await enter(browser, base, OPERATOR_PIN, device);
      try {
        await page
          .getByRole('button', { name: 'Configurações', exact: true })
          .click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Mesa', exact: true }).click();
        await dialog
          .getByLabel('Nome CH1', { exact: true })
          .fill('Cavaco principal');
        await dialog
          .getByLabel('Apelidos CH1', { exact: true })
          .fill('cordas agudas');
        await dialog
          .getByLabel('Nome AUX1', { exact: true })
          .fill('Retorno coletivo');
        await dialog
          .getByRole('button', { name: 'Salvar nomes locais' })
          .click();
        await dialog
          .getByText('Nomes locais salvos.', { exact: false })
          .waitFor();
        expect(s.controller.names.channel('cordas agudas').number).toBe(1);
        await dialog
          .getByRole('button', { name: 'Recarregar cadastro' })
          .click();
        await expect
          .poll(() =>
            dialog.getByLabel('Nome CH1', { exact: true }).inputValue(),
          )
          .toBe('Cavaco principal');
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        expect(await dialog.textContent()).toContain('Mesa CH1');
        expect(s.fake.last().commands()).toEqual([]);
        await page.keyboard.press('Escape');
        await expect
          .poll(() =>
            page
              .locator('mx-strip')
              .filter({ hasText: 'Cavaco principal' })
              .count(),
          )
          .toBe(1);
      } finally {
        await ctx.close();
        await s.close();
      }
    },
  );
