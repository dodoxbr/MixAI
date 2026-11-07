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
export async function enter(browser: Browser, base: string, pin: string, device: object = YOGA, prepare?: (ctx: BrowserContext) => Promise<void>, enrollFixture = true): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...device, baseURL: base });
  await prepare?.(ctx);
  const page = await ctx.newPage();
  await page.goto('/');
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
  if (pin === MUSICIAN_PIN && enrollFixture) await enrollMusicianFixture(page);
  return { ctx, page };
}

/** Explicit operator enrollment for historical full-channel UI fixtures only. */
export async function enrollMusicianFixture(page: Page) {
    // Historical UI scenarios explicitly enroll a test musician through the operator API.
    const token = await page.evaluate(() => sessionStorage.getItem('mixai.token'));
    const op = await page.request.post('/api/login', { data: { pin: OPERATOR_PIN } });
    const operator = (await op.json()).token;
    const command = async (token: string, command: object) => (await (await page.request.post('/api/command', { headers: { authorization: `Bearer ${token}` }, data: { requestId: crypto.randomUUID(), command } })).json()).result;
    const identity = await command(token!, { type: 'musician_identity' });
    const names = await command(operator, { type: 'list_names' });
    const result = await command(operator, { type: 'musician_bind', sessionId: identity.data.sessionId, musicianId: 'fixture-musician', name: 'Músico de teste', channels: names.data.channels.map((c: {number:number}) => c.number), mute: true });
    if (!result.ok) throw new Error('Operator fixture enrollment failed');
    await page.getByRole('heading', { name: 'Meus canais — Músico de teste', exact: true }).waitFor();
    await page.locator('.fones-row').first().waitFor();
}
