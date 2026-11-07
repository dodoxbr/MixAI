import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';
import { parse } from 'yaml';
import { parseChannels, PROJECT_ROOT } from '../../src/core/config.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer } from '../server-support.js';

export { MUSICIAN_PIN, OPERATOR_PIN };

/** Yoga 7 (14", 1920×1200 a 125%) no modo notebook com toque. */
export const YOGA = { viewport: { width: 1536, height: 960 }, hasTouch: true, deviceScaleFactor: 1.25 };
/** Celular típico em retrato. */
export const PHONE = devices['Pixel 7'];

/** Layout fixo de referência para testes e screenshots históricos, NÃO mapa físico atual. */
export const bandChannels = () => parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'test', 'fixtures', 'legacy-channels.yaml'), 'utf8')));

/** Cadastro físico da Ui16 do operador (assertado por test/config.test.ts). */
export const physicalBandChannels = () => parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8')));

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

export async function startLab(opts: Parameters<typeof startTestServer>[0] = {}) {
  return startTestServer(opts);
}

/** Abre a tela e entra com o PIN pelo teclado numérico (como uma pessoa faria). */
export async function enter(browser: Browser, base: string, pin: string, device: object = YOGA, prepare?: (ctx: BrowserContext) => Promise<void>): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...device, baseURL: base });
  await prepare?.(ctx);
  const page = await ctx.newPage();
  await page.goto('/');
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
  return { ctx, page };
}
