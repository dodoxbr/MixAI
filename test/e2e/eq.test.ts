import { mkdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { ParamKey } from '../../src/core/revisions.js';
import type { Browser } from 'playwright';
import { eqFilters, magnitudeDB, peakCoefficients } from '../../src/core/eq-response.js';
import { enter, launch, OPERATOR_PIN, PHONE, YOGA, startLab, bandChannels } from './harness.js';

const value = (l: Awaited<ReturnType<typeof startLab>>, k: ParamKey) => {
  const r = l.mixer.read(k);
  if (!r.known) throw new Error('unknown');
  return r.value;
};
let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async () => {
  browser = await launch();
});
afterEach(async () => {
  for (const c of browser.contexts()) await c.close();
  for (const l of labs.splice(0)) await l.server.close();
});
afterAll(async () => {
  await browser.close();
});

it('RBJ matches Web Audio peaking and Butterworth cascades (getFrequencyResponse)', async () => {
  const page = await browser.newPage();
  const frequencies = [20, 80, 100, 500, 1000, 8000, 22050];
  for (const gain of [-20, 6, 20]) {
    const band = { freq: 1000, q: 1.7, gain };
    const actual = await page.evaluate(
      ({ band, frequencies }) => {
        const ctx = new OfflineAudioContext(1, 128, 48000);
        const node = ctx.createBiquadFilter();
        node.type = 'peaking';
        node.frequency.value = band.freq;
        node.Q.value = band.q;
        node.gain.value = band.gain;
        const mag = new Float32Array(frequencies.length),
          phase = new Float32Array(frequencies.length);
        node.getFrequencyResponse(new Float32Array(frequencies), mag, phase);
        return [...mag].map((m) => 20 * Math.log10(m));
      },
      { band, frequencies },
    );
    frequencies.forEach((f, i) => expect(actual[i]).toBeCloseTo(magnitudeDB([peakCoefficients(band)], f), 4));
  }
  for (const slope of [12, 24, 36]) {
    const filters = eqFilters({ bands: [], hpf: { freq: 100, slope }, bypass: false });
    const actual = await page.evaluate(
      ({ slope, frequencies }) => {
        const ctx = new OfflineAudioContext(1, 128, 48000),
          order = slope / 6;
        const db = frequencies.map(() => 0);
        for (let k = 1; k <= order / 2; k++) {
          const node = ctx.createBiquadFilter();
          node.type = 'highpass';
          node.frequency.value = 100;
          // Web Audio highpass Q is in dB, unlike peaking Q.
          node.Q.value = 20 * Math.log10(1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * order))));
          const mag = new Float32Array(frequencies.length),
            phase = new Float32Array(frequencies.length);
          node.getFrequencyResponse(new Float32Array(frequencies), mag, phase);
          mag.forEach((m, i) => (db[i]! += 20 * Math.log10(m)));
        }
        return db;
      },
      { slope, frequencies },
    );
    frequencies.forEach((f, i) => expect(actual[i]).toBeCloseTo(magnitudeDB(filters, f), 4));
  }
});

for (const [name, device] of [
  ['yoga', YOGA],
  ['android-portrait', PHONE],
  ['android-landscape', { ...PHONE, viewport: { width: 915, height: 412 } }],
] as const) {
  it(`EQ edit, bypass, drag, reset and undo; screenshot ${name}`, async () => {
    const l = await startLab({ channels: bandChannels() });
    labs.push(l);
    const { page } = await enter(browser, l.base, OPERATOR_PIN, device);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.getByRole('button', { name: 'EQ LAB', exact: true }).click();
    await page.getByText('SIMULADO — somente laboratório. Curva estimada, não medida na Ui16 real.').waitFor();
    const gain = page.getByRole('spinbutton', { name: 'Banda 1 ganho', exact: true });
    await gain.fill('6');
    await gain.press('Tab');
    await expect.poll(() => value(l, 'ch.1.eq.b1.gain')).toBe(6);
    const { page: second } = await enter(browser, l.base, OPERATOR_PIN, device);
    await second.getByRole('button', { name: 'EQ LAB', exact: true }).click();
    await expect.poll(() => second.getByRole('spinbutton', { name: 'Banda 1 ganho', exact: true }).inputValue()).toBe('6');
    await page.bringToFront();
    await page.getByRole('checkbox', { name: 'Bypass EQ/HPF' }).check();
    await expect.poll(() => value(l, 'ch.1.eq.bypass')).toBe(true);
    await page.getByRole('checkbox', { name: 'Bypass EQ/HPF' }).uncheck();
    await expect.poll(() => value(l, 'ch.1.eq.bypass')).toBe(false);
    // The adapter changes before the WS result; allow Angular to render the busy state first.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => page.getByRole('button', { name: 'Reset EQ do canal' }).isEnabled()).toBe(true);
    const dot = page.getByRole('button', { name: 'Arrastar banda 1;', exact: false });
    await expect.poll(() => dot.getAttribute('aria-disabled')).toBe('false');
    await dot.focus();
    await dot.press('ArrowUp');
    await expect.poll(() => value(l, 'ch.1.eq.b1.gain')).toBe(6.5);
    const box = await dot.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 25, box!.y + box!.height / 2 - 10, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => value(l, 'ch.1.eq.b1.freq')).not.toBe(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mkdirSync('docs/lab/screenshots/e7a', { recursive: true });
    await page.locator('mx-eq').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `docs/lab/screenshots/e7a/${name}.png`, fullPage: true });
    await page.locator('mx-eq').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: `docs/lab/screenshots/e7a/${name}-controls.png`, fullPage: true });
    await page.getByRole('button', { name: 'Reset EQ do canal' }).click();
    await expect.poll(() => gain.inputValue()).toBe('0');
    await page.getByRole('button', { name: 'Fechar EQ' }).click();
    await page.getByRole('button', { name: 'Desfazer', exact: true }).click();
    await page.getByRole('button', { name: 'EQ LAB', exact: true }).click();
    await expect.poll(() => gain.inputValue()).not.toBe('0');
    await page.reload();
    await page.getByRole('button', { name: 'EQ LAB', exact: true }).click();
    await expect.poll(() => gain.inputValue()).not.toBe('0');
    expect(errors).toEqual([]);
  });
}
