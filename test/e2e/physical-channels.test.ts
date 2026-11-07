import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enter, launch, OPERATOR_PIN, physicalBandChannels, startLab, YOGA } from './harness.js';

/**
 * Unlike historical E2E scenarios, this checks the CURRENT physical channel
 * labels end-to-end in the LAB browser. Never connects to the real Ui16.
 */
describe('Ui16 physical channel names in the LAB interface', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser.close(); });

  it('shows the operator-approved 1–11 mapping in physical input order', async () => {
    const l = await startLab({ channels: physicalBandChannels() });
    try {
      const { ctx, page } = await enter(browser, l.base, OPERATOR_PIN, YOGA);
      try {
        const strips = page.locator('.strips .mx-strip');
        const expected = [
          'Cavaco', 'Violão', 'Voz Fred', 'Voz Lucius', 'Voz Leandro',
          'Voz Fernando', 'Voz Laviquinho', 'Surdo', 'Pandeiro', 'Tantã', 'Reserva',
        ];
        await expect.poll(() => strips.count()).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          await expect.poll(() => strips.nth(i).textContent()).toContain(expected[i]);
        }
        // All interactions in this test are browser reads; no adjustment command.
      } finally {
        await ctx.close();
      }
    } finally {
      await l.server.close();
    }
  });
});
