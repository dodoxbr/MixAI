import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import type { ParamKey } from '../../src/core/revisions.js';
import { eqGuides, eqValues } from '../../src/knowledge/sound-engineer/eq-guides.js';
import { enter, launch, OPERATOR_PIN, MUSICIAN_PIN, PHONE, YOGA, startLab } from './harness.js';

let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async () => { browser = await launch(); });
afterEach(async () => {
  for (const c of browser.contexts()) await c.close();
  for (const l of labs.splice(0)) await l.server.close();
});
afterAll(async () => { await browser.close(); });
const read = (l: Awaited<ReturnType<typeof startLab>>) => Object.fromEntries(
  Object.keys(eqValues(eqGuides[0]!.model)).map(key => [key, l.mixer.read(`ch.1.eq.${key}` as ParamKey)]),
);

for (const [name, device] of [
  ['Yoga touch', YOGA], ['celular retrato', PHONE], ['celular paisagem', { ...PHONE, viewport: { width: 780, height: 360 } }],
] as const) {
  it(`guide preview/cancel, explicit apply, undo and reload on ${name}`, async () => {
    const l = await startLab();
    labs.push(l);
    const { page } = await enter(browser, l.base, OPERATOR_PIN, device);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const writes = vi.spyOn(l.mixer, 'write');
    await page.getByRole('button', { name: 'EQ LAB', exact: true }).click();
    const select = page.getByRole('combobox', { name: 'Preset orientativo', exact: true });
    const initial = read(l);
    await select.selectOption('cavaco');
    await page.getByRole('button', { name: 'Aplicar no LAB', exact: true }).waitFor();
    expect(await page.locator('.eq-diff tbody tr').count()).toBe(15);
    expect(await page.getByTestId('eq-guide-curve').getAttribute('d')).toMatch(/^M/);
    expect(await page.getByRole('link', { name: 'Yamaha — Equalization', exact: true }).getAttribute('href')).toMatch(/^https:/);
    await page.getByText('Contraindicações:', { exact: true }).waitFor();
    expect(read(l)).toEqual(initial);
    expect(writes).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Cancelar preset', exact: true }).click();
    await page.getByTestId('eq-guide-curve').waitFor({ state: 'detached' });
    expect(await page.getByTestId('eq-guide-curve').count()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    await select.selectOption('cavaco');
    const apply = page.getByRole('button', { name: 'Aplicar no LAB', exact: true });
    await apply.scrollIntoViewIfNeeded();
    const box = (await apply.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(device.viewport!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await apply.click();
    await page.getByRole('status').filter({ hasText: 'Preset aplicado somente no LAB' }).waitFor();
    for (const [key, value] of Object.entries(eqValues(eqGuides[0]!.model))) expect(read(l)[key]).toEqual({ known: true, value });
    await page.getByRole('button', { name: 'Desfazer última ação LAB', exact: true }).click();
    await expect.poll(() => read(l)).toEqual(initial);
    await expect.poll(() => page.getByRole('spinbutton', { name: 'HPF frequência', exact: true }).inputValue()).toBe('20');
    await expect.poll(() => select.isEnabled()).toBe(true);
    await select.selectOption('cavaco');
    await page.getByRole('button', { name: 'Aplicar no LAB', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Preset aplicado somente no LAB' }).waitFor();
    const applied = read(l);
    await page.reload();
    await page.getByRole('button', { name: 'EQ LAB', exact: true }).click();
    await expect.poll(() => page.getByRole('spinbutton', { name: 'HPF frequência', exact: true }).inputValue()).toBe('80');
    expect(read(l)).toEqual(applied);
    expect(await select.inputValue()).toBe('');
    expect(errors).toEqual([]);
  });
}

it('another operator invalidates the displayed comparison; a musician has no guide application UI', async () => {
  const l = await startLab();
  labs.push(l);
  const { page } = await enter(browser, l.base, OPERATOR_PIN);
  await page.getByRole('button', { name: 'EQ LAB', exact: true }).click();
  await page.getByRole('combobox', { name: 'Preset orientativo', exact: true }).selectOption('vozes');
  await page.getByRole('button', { name: 'Aplicar no LAB', exact: true }).waitFor();
  const op2 = await l.login(OPERATOR_PIN);
  expect((await l.command(op2, { type: 'set_lab_eq', channel: 1, values: { 'ch.1.eq.b1.gain': 3 } })).json.result.ok).toBe(true);
  await page.getByRole('status').filter({ hasText: 'Prévia descartada' }).waitFor();
  expect(await page.getByRole('button', { name: 'Aplicar no LAB', exact: true }).count()).toBe(0);
  expect(l.mixer.read('ch.1.eq.b1.gain')).toEqual({ known: true, value: 3 });
  const { page: musician } = await enter(browser, l.base, MUSICIAN_PIN);
  expect(await musician.getByRole('button', { name: 'EQ LAB', exact: true }).count()).toBe(0);
  expect(await musician.getByRole('button', { name: 'Aplicar no LAB', exact: true }).count()).toBe(0);
});
