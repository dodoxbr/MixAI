import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { processingFrame } from '../../src/mixer/ui16-processing.js';
import { Ui16RealBridge } from '../../src/mixer/ui16-real-bridge.js';
import { MixController } from '../../src/core/controller.js';
import { ChannelMap } from '../../src/core/channels.js';
import { parseConfig, PROJECT_ROOT } from '../../src/core/config.js';
import { ActionLog } from '../../src/core/log.js';
import type { ParamKey } from '../../src/core/revisions.js';
import { Auth } from '../../src/server/auth.js';
import { hashPin } from '../../src/server/pin.js';
import { ServerCore } from '../../src/server/core.js';
import { buildHttp } from '../../src/server/http.js';
import { createFakeUi, stateMessages, waitFor } from '../support/fake-ui-socket.js';
import { OPERATOR_PIN, MUSICIAN_PIN } from '../server-support.js';
import { enter, launch, physicalBandChannels, startLab } from './harness.js';

/**
 * Redesign do console: navegação MIX / GAIN · EDIT · AUX SENDS · FX SENDS. O servidor REAL usa só um socket injetado
 * em memória (nunca hardware) e o teste exige zero SETD. Gera as capturas de tela de docs/ui16/console/.
 */
let browser: Browser;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
const DEVICES = [
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['tablet', { viewport: { width: 1024, height: 768 }, hasTouch: true, deviceScaleFactor: 1.5 }],
] as const;
const shots = join(PROJECT_ROOT, 'docs/ui16/console');

async function realServer() {
  const required: ParamKey[] = ['ch.3.main.level', 'ch.3.main.mute', 'master.level'];
  const frames: string[] = [];
  const eq = { 1: [80, -2.8, 0.7], 2: [450, -0.4, 1.2], 3: [2100, 3.8, 1], 4: [6640, -1, 1] } as const;
  for (const b of [1, 2, 3, 4] as const) {
    frames.push(processingFrame(`ch.3.eq.b${b}.freq`, eq[b][0]).slice(4), processingFrame(`ch.3.eq.b${b}.gain`, eq[b][1]).slice(4), processingFrame(`ch.3.eq.b${b}.q`, eq[b][2]).slice(4));
  }
  frames.push(processingFrame('ch.3.eq.hpf.freq', 98).slice(4), processingFrame('ch.3.eq.bypass', false).slice(4));
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', 'SETD^i.2.stereoIndex^-1', ...stateMessages({ channels: [1, 2, 3], aux: [1] }), ...frames] });
  const bridge = new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: required, watchedKeys: [...required, 'ch.2.main.level'], webSocketCtor: fake.Ctor, reconnectBaseMs: 5, reconnectMaxDelayMs: 10 });
  const log = new ActionLog(null);
  const controller = new MixController(bridge, parseConfig({}).safety, new ChannelMap(physicalBandChannels(), bridge.capabilities()), log);
  const auth = new Auth({ operatorPinHash: hashPin(OPERATOR_PIN), musicianPinHash: hashPin(MUSICIAN_PIN), agentToken: 'fixture-agent', sessionTtlMs: 600000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1 });
  await bridge.connect();
  await waitFor(() => bridge.link() === 'READY');
  const app = await buildHttp(core, { webRoot: join(PROJECT_ROOT, 'dist', 'web', 'browser') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, fake, bridge, close: async () => { await app.close(); await bridge.disconnect(); } };
}
const tab = (page: Page, id: string) => page.locator(`.console-nav [data-view=${id}]`);

for (const [label, device] of DEVICES) {
  it(`${label}: navegação, MIX / GAIN, AUX SENDS, FX SENDS indisponível, ferramentas e assistente sem sair da mesa (LAB)`, async () => {
    const lab = await startLab();
    const { ctx, page } = await enter(browser, lab.base, OPERATOR_PIN, device);
    try {
      expect(await page.locator('.console-nav [role=tab]').allTextContents()).toEqual(['MIX / GAIN', 'EDIT', 'AUX SENDS', 'FX SENDS']);
      expect(await tab(page, 'mix').getAttribute('aria-selected')).toBe('true');
      // MIX / GAIN: dB acima do fader, MUTE + SOLO desabilitado, CH n acima do nome, master separado
      const strip = page.locator('.strips mx-strip').first();
      const value = await strip.locator('.strip-value').boundingBox(), fader = await strip.locator('mx-fader').boundingBox();
      const name = await strip.locator('.strip-name').boundingBox(), num = await strip.locator('.strip-number').boundingBox();
      expect(value!.y).toBeLessThan(fader!.y); expect(num!.y).toBeLessThan(name!.y); expect(fader!.y).toBeLessThan(num!.y);
      expect(await strip.locator('.solo').isDisabled()).toBe(true);
      const mute = (await strip.locator('.mute').boundingBox())!;
      expect(mute.height).toBeGreaterThanOrEqual(44); expect(mute.width).toBeLessThan(80);
      const master = (await page.locator('.master-area').boundingBox())!, strips = (await page.locator('.strips').boundingBox())!;
      expect(master.x).toBeGreaterThanOrEqual(strips.x + strips.width - 1);
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: join(shots, `${label}-mix.png`) });
      // ferramentas e assistente: abre no painel lateral, a mesa continua visível
      await page.getByTestId('tools-trigger').click();
      await page.getByTestId('tools-menu').waitFor();
      expect(await page.locator('[data-testid=tools-menu] [role=menuitem]').count()).toBe(6);
      await page.locator('[data-testid=tools-menu]').getByRole('menuitem', { name: 'Assistente de IA' }).click();
      await page.locator('mx-assistant-panel').waitFor();
      expect(await page.locator('.strips mx-strip').first().isVisible()).toBe(true);
      expect(await tab(page, 'mix').getAttribute('aria-selected')).toBe('true');
      await page.screenshot({ path: join(shots, `${label}-assistente.png`) });
      await page.getByRole('button', { name: 'Recolher o assistente' }).click();
      // AUX SENDS: barramentos AUX, mesmo padrão visual
      await tab(page, 'aux').click();
      await page.locator('.aux-selector').waitFor();
      expect(await page.locator('.strips mx-strip .solo').count()).toBeGreaterThan(0);
      await page.screenshot({ path: join(shots, `${label}-aux.png`) });
      // FX SENDS: só estrutura, tudo desabilitado e sem valores
      await tab(page, 'fx').click();
      await page.getByTestId('fx-unavailable').waitFor();
      expect(await page.locator('.fx-main [role=tab]:not([disabled])').count()).toBe(0);
      expect(await page.locator('.fx-main .strip-value, .fx-main mx-fader').count()).toBe(0);
      await page.screenshot({ path: join(shots, `${label}-fx.png`) });
      // EDIT em LAB: aba EQ selecionada; sem EQ físico a tela explica
      await tab(page, 'edit').click();
      expect(await page.getByTestId('edit-tab-eq').getAttribute('aria-selected')).toBe('true');
      await page.getByTestId('edit-unavailable').waitFor();
    } finally { await ctx.close(); await lab.server.close(); }
  });

  it(`${label}: EDIT → EQ REAL embutido, calculado e somente leitura, sem SETD`, async () => {
    const s = await realServer();
    const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, device);
    try {
      await page.getByRole('button', { name: 'Selecionar CH3 — Voz Fred', exact: true }).click();
      await tab(page, 'edit').click();
      const panel = page.locator('mx-live-eq');
      await panel.getByText('6.640 Hz', { exact: true }).first().waitFor();
      expect(await panel.getAttribute('role')).toBe('region'); // inline, não é diálogo modal
      expect(await page.locator('[role=dialog]').count()).toBe(0);
      expect(await panel.locator('svg path').count()).toBe(1); // curva calculada
      expect(await panel.locator('.band-dot').count()).toBe(4); // quatro bandas identificadas
      expect(await panel.locator('input').count()).toBe(0);
      expect(await panel.locator('[data-testid=eq-readout]').textContent()).toContain('Banda 1');
      await panel.locator('.band-dot[data-dot="4"]').waitFor();
      await panel.locator('.band-dot[data-dot="4"] circle').click();
      await expect.poll(() => panel.locator('[data-testid=eq-readout]').textContent()).toContain('Banda 4');
      const readout = await panel.locator('[data-testid=eq-readout]').textContent();
      expect(readout).toContain('Banda 4'); expect(readout).toContain('6.640 Hz'); expect(readout).toContain('-1,0 dB');
      expect(await panel.getByTestId('eq-bypass-lamp').textContent()).toContain('desligado');
      expect(await panel.locator('.channel-tabs .on').textContent()).toContain('CH 3');
      await page.screenshot({ path: join(shots, `${label}-edit-eq.png`) });
      // canal sem leitura: nada de curva nem marcadores inventados
      await panel.locator('.channel-tabs button', { hasText: 'CH 2' }).click();
      await expect.poll(() => panel.locator('.band-dot').count(), { timeout: 6000 }).toBe(0);
      expect(await panel.locator('svg').count()).toBe(0);
      expect(s.fake.sockets.flatMap((socket) => socket.commands())).toEqual([]);
    } finally { await ctx.close(); await s.close(); }
  });
}

for (const [label, device] of [
  ['celular em retrato', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
  ['celular deitado', { viewport: { width: 780, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
] as const) {
  it(`${label}: ferramentas acessíveis (Configurações e Base de conhecimento) sem quebrar a barra compacta`, async () => {
    const lab = await startLab();
    const { ctx, page } = await enter(browser, lab.base, OPERATOR_PIN, device);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.evaluate(() => scrollTo(0, 0));
      const trigger = page.getByTestId('tools-trigger');
      await trigger.waitFor({ state: 'visible' });
      const box = (await trigger.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      await trigger.click();
      await page.getByTestId('tools-menu').waitFor();
      const items = await page.locator('[data-testid=tools-menu] [role=menuitem]').allTextContents();
      expect(items.map((t) => t.split('(')[0]!.trim())).toEqual(['Assistente de IA', 'Diagnóstico', 'Cenas', 'Histórico', 'Base de conhecimento', 'Configurações e administração']);
      for (const item of await page.locator('[data-testid=tools-menu] [role=menuitem]').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // Base de conhecimento: se a seção existir neste servidor, é aberta; nunca gera erro de página
      await page.getByRole('menuitem', { name: /Base de conhecimento/ }).click();
      if (await page.locator('mx-knowledge-admin .knowledge-admin').count()) expect(await page.locator('mx-knowledge-admin [aria-expanded]').first().getAttribute('aria-expanded')).toBe('true');
      // Configurações e administração: abre o diálogo existente
      await trigger.click();
      await page.getByRole('menuitem', { name: /Configurações e administração/ }).click();
      await page.getByRole('dialog').first().waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); await lab.server.close(); }
  });
}
