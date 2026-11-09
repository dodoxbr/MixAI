import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { enter, launch, startLab, physicalBandChannels, OPERATOR_PIN, PHONE, YOGA } from './harness.js';
let browser: Browser;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
async function api(page: Page, path: string, body: object) {
  return page.evaluate(async ({ path, body }) => {
    const res = await fetch(path, { method: 'POST', headers: { authorization: `Bearer ${sessionStorage.getItem('mixai.token')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  }, { path, body });
}
it.each([{ label: 'Yoga', device: YOGA }, { label: 'celular', device: PHONE }])('$label: diagnóstico existente alimenta sugestão D sem repetir respostas nem criar alteração numérica', async ({ device }) => {
  const t = await startLab({ channels: physicalBandChannels() });
  try {
    const { ctx, page } = await enter(browser, t.base, OPERATOR_PIN, device);
    const before = t.controller.state.snapshot(), write = vi.spyOn(t.mixer, 'write'), execute = vi.spyOn(t.server.core, 'execute');
    await page.getByPlaceholder('O que você deseja ajustar?').fill('Fred está abafado só no retorno, também sozinho.');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('.technical-text').last().filter({ hasText: 'Fred' }).waitFor();
    const response = await api(page, '/api/autoconfig/suggestions', { serverId: t.server.core.serverId, scope: 'AUX1' });
    expect(response.status).toBe(200); expect(response.json.advice.kind).toBe('proposal');
    expect(response.json.advice.proposal.channel).toBe(3); expect(response.json.advice.proposal.destination).toBe('fones');
    expect(response.json.proposal.items[0].deltaDB).toBeUndefined(); expect(response.json.createsDraft).toBe(false);
    expect(response.json.advice.question).toBeUndefined();
    expect(await page.locator('.proposal').count()).toBe(0);
    expect(write).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(t.controller.state.snapshot()).toEqual(before);
    await ctx.close();
  } finally { await t.server.close(); }
});
