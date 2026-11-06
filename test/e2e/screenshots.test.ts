import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { devices } from 'playwright';
import { PROJECT_ROOT } from '../../src/core/config.js';
import { bandChannels, enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, startLab, YOGA } from './harness.js';

/** Gera as capturas da E3 em docs/lab/img (npm run screenshots, depois de npm run build:web). */
it('capturas da interface (Yoga e celular)', async () => {
  const out = join(PROJECT_ROOT, 'docs', 'lab', 'img');
  mkdirSync(out, { recursive: true });
  const l = await startLab({ channels: bandChannels(), safety: { maxStepDB: 40 } }); // só para montar a cena sem cartões
  const browser = await launch();
  try {
    // Uma mix plausível de roda de samba (laboratório).
    const op = await l.login(OPERATOR_PIN);
    const mix: Array<[number, number]> = [[1, -6], [2, -9], [3, -4], [4, -5], [5, -7], [6, -3], [7, -12], [8, -14], [9, -8], [10, -16]];
    for (const [ch, db] of mix) await l.command(op, { type: 'set_level', channel: ch, db });
    await l.command(op, { type: 'set_mute', channels: [11], muted: true });
    for (const [ch, db] of [[3, -12], [4, -10], [5, -14], [6, -11], [1, -18], [9, -22]] as const) {
      await l.command(op, { type: 'set_level', channel: ch, aux: 1, db });
    }

    const yoga = await enter(browser, l.base, OPERATOR_PIN, YOGA);
    await yoga.page.waitForTimeout(700);
    await yoga.page.screenshot({ path: join(out, 'e3-yoga-mesa-pa.png') });

    const token = readFileSync(`${l.dir}/agent-lab.token`, 'utf8');
    await l.http('/api/command', { token, body: { requestId: 'shot-1', targetMode: 'lab', command: { type: 'set_master', deltaDB: -3 } } });
    await yoga.page.locator('.card').waitFor();
    await yoga.page.waitForTimeout(300);
    await yoga.page.screenshot({ path: join(out, 'e3-yoga-cartao-aprovacao.png') });

    await yoga.page.getByRole('tab', { name: 'FONES' }).click();
    await yoga.page.waitForTimeout(300);
    await yoga.page.screenshot({ path: join(out, 'e3-yoga-fones.png') });

    const login = await browser.newContext({ ...PHONE, baseURL: l.base });
    const lp = await login.newPage();
    await lp.goto('/');
    await lp.getByRole('button', { name: 'Entrar' }).waitFor();
    await lp.screenshot({ path: join(out, 'e3-celular-pin.png') });

    const mus = await enter(browser, l.base, MUSICIAN_PIN, PHONE);
    await mus.page.waitForTimeout(400);
    await mus.page.screenshot({ path: join(out, 'e3-celular-fones-musico.png') });

    const opPhone = await enter(browser, l.base, OPERATOR_PIN, PHONE);
    await opPhone.page.waitForTimeout(600);
    await opPhone.page.screenshot({ path: join(out, 'e3-celular-mesa-operador.png') });
  } finally {
    await browser.close();
    await l.server.close();
  }
}, 90_000);

/** Capturas da E4 (assistente). A IA é SIMULADA: nenhuma chamada real à API. */
it('capturas do assistente (Yoga e celular)', async () => {
  const out = join(PROJECT_ROOT, 'docs', 'lab', 'img');
  const fake = (input: unknown) =>
    new Response(JSON.stringify({ model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't', name: 'propor_ajuste', input }], usage: { input_tokens: 850, output_tokens: 70 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const l = await startLab({
    channels: bandChannels(),
    safety: { maxStepDB: 40 },
    ai: { enabled: true },
    aiKey: 'sk-ant-simulada',
    aiFetch: async () => fake({ acao: 'propor', propostas: [{ tipo: 'volume', canal: 1, destino: 'PA', delta_db: 2, motivo: 'O cavaco está sumindo atrás do surdo; subo 2 dB no PA.' }] }),
  });
  const browser = await launch();
  try {
    const op = await l.login(OPERATOR_PIN);
    for (const [ch, db] of [[1, -6], [2, -9], [3, -4], [4, -5], [5, -7], [6, -3], [7, -12], [8, -14], [9, -8], [10, -16]] as const) {
      await l.command(op, { type: 'set_level', channel: ch, db });
    }
    const yoga = await enter(browser, l.base, OPERATOR_PIN, YOGA);
    const ask = async (page: import('playwright').Page, text: string) => {
      await page.getByPlaceholder('O que você deseja ajustar?').fill(text);
      await page.getByRole('button', { name: 'Enviar' }).click();
    };
    await ask(yoga.page, 'diminui 3 dB da voz Fernando no PA');
    await yoga.page.locator('.proposal').waitFor();
    await yoga.page.locator('.proposal').last().getByRole('button', { name: 'Aplicar' }).click();
    await yoga.page.locator('.assist-feedback').waitFor();
    await ask(yoga.page, 'preciso organizar melhor o cavaco na mix');
    await yoga.page.locator('.proposal .assist-src').waitFor();
    await yoga.page.waitForTimeout(500);
    await yoga.page.screenshot({ path: join(out, 'e4-yoga-assistente.png') });

    const mus = await enter(browser, l.base, MUSICIAN_PIN, PHONE);
    await ask(mus.page, 'aumenta um pouco o surdo');
    await mus.page.locator('.proposal').waitFor();
    await mus.page.waitForTimeout(300);
    await mus.page.screenshot({ path: join(out, 'e4-celular-assistente.png') });

    await ask(mus.page, 'sobe a voz');
    await mus.page.locator('.assist-options').waitFor();
    await mus.page.waitForTimeout(300);
    await mus.page.screenshot({ path: join(out, 'e4-celular-pergunta.png') });
  } finally {
    await browser.close();
    await l.server.close();
  }
}, 90_000);

it('capturas das cenas (E5, Yoga)', async () => {
  const out = join(PROJECT_ROOT, 'docs', 'lab', 'img');
  const l = await startLab({ channels: bandChannels() });
  const browser = await launch();
  try {
    const op = await l.login(OPERATOR_PIN);
    const set = (command: Record<string, unknown>) => l.command(op, command);
    await set({ type: 'set_level', channel: 'surdo', db: -12 });
    await set({ type: 'set_level', channel: 'cavaco', db: -12 });
    await set({ type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -17 });
    await set({ type: 'set_mute', channels: ['pandeiro'], muted: true });
    await set({ type: 'scene_save', name: 'Roda de sábado', description: 'Surdo e voz do Fernando mais à frente; pandeiro fora do PA.' });
    await set({ type: 'scene_save', name: 'Ensaio acústico', description: 'Base para ensaio em casa.' });
    await set({ type: 'set_level', channel: 'surdo', db: -15 });
    await set({ type: 'set_level', channel: 'cavaco', db: -10 });
    await set({ type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -20 });
    await set({ type: 'set_mute', channels: ['pandeiro'], muted: false });

    const yoga = await enter(browser, l.base, OPERATOR_PIN, YOGA);
    const page = yoga.page;
    await page.getByRole('button', { name: 'Cenas' }).click();
    await page.locator('.scene-item', { hasText: 'Roda de sábado' }).click();
    await page.locator('.scene-view tbody tr').first().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, 'e5-yoga-cenas-lista.png') });
    await page.getByRole('button', { name: 'Comparar' }).click();
    await page.getByTestId('scene-compare').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, 'e5-yoga-cenas-comparacao.png') });
    await page.getByRole('button', { name: 'Carregar…' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, 'e5-yoga-cenas-confirmar.png') });
    await page.getByRole('button', { name: 'Pedir carregamento' }).click();
    await page.getByTestId('scene-load-card').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, 'e5-yoga-cenas-aprovacao.png') });
  } finally {
    await browser.close();
    await l.server.close();
  }
}, 60_000);

it('capturas do celular em retrato e deitado (operador e músico)', async () => {
  const out = join(PROJECT_ROOT, 'docs', 'lab', 'img');
  const l = await startLab({ channels: bandChannels(), server: { musicianAccess: 'pa_without_master' } });
  const browser = await launch();
  try {
    const op = await l.login(OPERATOR_PIN);
    const mix: Array<[number, number]> = [[1, -6], [2, -9], [3, -4], [4, -5], [5, -7], [6, -3], [7, -12], [8, -14], [9, -8], [10, -16]];
    for (const [ch, db] of mix) await l.command(op, { type: 'set_level', channel: ch, db });
    await l.command(op, { type: 'set_mute', channels: [7], aux: 1, muted: true });
    await l.command(op, { type: 'set_mute', channels: [8], muted: true });
    const shot = async (pin: string, device: object, file: string, prepare?: (p: import('playwright').Page) => Promise<void>) => {
      const s = await enter(browser, l.base, pin, device);
      await s.page.evaluate(() => scrollTo(0, 0));
      if (prepare) await prepare(s.page);
      await s.page.waitForTimeout(500);
      await s.page.screenshot({ path: join(out, file) });
      await s.ctx.close();
    };
    const portrait = devices['Galaxy S24']!;
    const landscape = devices['Galaxy S24 landscape']!;
    await shot(OPERATOR_PIN, portrait, 'mobile-operador-retrato.png');
    await shot(OPERATOR_PIN, landscape, 'mobile-operador-deitado.png');
    await shot(OPERATOR_PIN, landscape, 'mobile-operador-deitado-rolado.png', async (p) => {
      await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    });
    await shot(MUSICIAN_PIN, portrait, 'mobile-musico-fones-retrato.png');
    await shot(MUSICIAN_PIN, landscape, 'mobile-musico-fones-deitado.png');
    await shot(MUSICIAN_PIN, landscape, 'mobile-musico-pa-deitado.png', async (p) => {
      await p.getByRole('tab', { name: 'PA' }).click();
    });
  } finally {
    await browser.close();
    await l.server.close();
  }
}, 90_000);

it('capturas da barra compacta em retrato (320, 360, 390, 430 px)', async () => {
  const out = join(PROJECT_ROOT, 'docs', 'lab', 'img');
  const l = await startLab({ channels: bandChannels() });
  const browser = await launch();
  try {
    for (const [w, h] of [[320, 640], [360, 780], [390, 844], [430, 932]] as const) {
      const s = await enter(browser, l.base, OPERATOR_PIN, { viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
      await s.page.evaluate(() => scrollTo(0, 0));
      await s.page.locator('.sim-legend').waitFor();
      await s.page.waitForTimeout(400);
      await s.page.screenshot({ path: join(out, `mobile-retrato-${w}.png`) });
      await s.ctx.close();
    }
  } finally {
    await browser.close();
    await l.server.close();
  }
}, 90_000);
