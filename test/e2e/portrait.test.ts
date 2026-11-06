import { readFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { paramKey } from '../../src/core/revisions.js';
import { MASTER } from '../../src/mixer/types.js';
import { bandChannels, launch, OPERATOR_PIN, startLab, YOGA } from './harness.js';

/** Celulares em retrato nas larguras pedidas (altura típica de cada um). */
const WIDTHS: Array<[number, number]> = [
  [320, 640],
  [360, 780],
  [390, 844],
  [430, 932],
];
const phone = (w: number, h: number) => ({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

type Lab = Awaited<ReturnType<typeof startLab>>;
type Box = { x: number; y: number; width: number; height: number };
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
async function lab() {
  const l = await startLab({ channels: bandChannels() });
  labs.push(l);
  return l;
}
async function open(l: Lab, device: object, waitLegend = true) {
  const ctx = await browser.newContext({ ...device, baseURL: l.base });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  for (const d of OPERATOR_PIN) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.locator('.strips .strip-value').first().textContent()).toContain('dB');
  if (waitLegend) await page.locator('.sim-legend').waitFor(); // deitado, a legenda sai da barra (aprovado no PR #10)
  return { page, errors };
}
const rect = async (page: Page, selector: string): Promise<Box> => {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible' });
  return (await loc.boundingBox())!;
};
const ACTIONS = ['Assistente', 'Desfazer', 'Histórico', 'Cenas'];
const action = (page: Page, name: string) => page.locator('.toolbar-actions').getByRole('button', { name, exact: true });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** Todos os controles da barra: nenhum se sobrepõe a outro, nem à fileira de canais. */
async function expectNoOverlap(page: Page) {
  const boxes: Array<[string, Box]> = [
    ['PA', await rect(page, '.toolbar [role=tab] >> nth=0')],
    ['FONES', await rect(page, '.toolbar [role=tab] >> nth=1')],
    ['aviso', await rect(page, '.toolbar .sim-legend')],
    ['campo', await rect(page, '.toolbar .mx-assistant-input input')],
    ['Enviar', await rect(page, '.toolbar .mx-assistant-input button[type=submit]')],
  ];
  for (const n of ACTIONS) boxes.push([n, (await action(page, n).boundingBox())!]);
  const strips = await rect(page, '.strips');
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]![1], boxes[j]![1]), `${boxes[i]![0]} × ${boxes[j]![0]}`).toBe(false);
    expect(overlaps(boxes[i]![1], strips), `${boxes[i]![0]} × canais`).toBe(false);
  }
}

describe('Mesa do operador em retrato: barra compacta', () => {
  for (const [w, h] of WIDTHS) {
    it(`${w}×${h}: PA/FONES → campo + Enviar → 4 ações numa linha → faders; sem sobreposição nem rolagem lateral`, async () => {
      const l = await lab();
      const { page, errors } = await open(l, phone(w, h));
      const seg = await rect(page, '.toolbar .segmented');
      const legend = await rect(page, '.toolbar .sim-legend');
      const input = await rect(page, '.toolbar .mx-assistant-input input');
      const send = await rect(page, '.toolbar .mx-assistant-input button[type=submit]');
      const strips = await rect(page, '.strips');
      const acts = await Promise.all(ACTIONS.map(async (n) => (await action(page, n).boundingBox())!));

      // 1ª linha: PA/FONES, com o aviso de medidores simulados (compacto) ao lado
      expect(legend.y).toBeLessThan(seg.y + seg.height);
      expect(await page.locator('.toolbar .sim-legend').textContent()).toContain('SIMULADOS');
      // 2ª linha: campo e Enviar lado a lado, abaixo do seletor
      expect(input.y).toBeGreaterThanOrEqual(seg.y + seg.height - 1);
      expect(Math.abs(input.y + input.height / 2 - (send.y + send.height / 2))).toBeLessThan(4);
      expect(send.x).toBeGreaterThan(input.x + input.width - 1);
      // 3ª linha: as 4 ações na MESMA linha, abaixo do campo, alvos ≥ 48 × 48
      for (const [i, b] of acts.entries()) {
        expect(Math.abs(b.y - acts[0]!.y), ACTIONS[i]).toBeLessThan(2);
        expect(b.y).toBeGreaterThanOrEqual(input.y + input.height - 1);
        expect(b.width, ACTIONS[i]).toBeGreaterThanOrEqual(48);
        expect(b.height, ACTIONS[i]).toBeGreaterThanOrEqual(48);
        expect(b.x + b.width, ACTIONS[i]).toBeLessThanOrEqual(w + 0.5);
      }
      // ícone + rótulo curto visíveis; o nome acessível é o completo
      expect(await action(page, 'Assistente').locator('.tb-icon').isVisible()).toBe(true);
      expect((await action(page, 'Assistente').innerText()).trim()).toBe('Chat');
      // depois: os canais, com os faders visíveis na primeira tela
      expect(strips.y).toBeGreaterThanOrEqual(acts[0]!.y + acts[0]!.height - 1);
      const fader = await rect(page, '.strips mx-fader');
      expect(fader.y).toBeLessThan(h - 120); // o fader começa bem dentro da tela
      expect(fader.height).toBeGreaterThanOrEqual(140);
      // a barra ocupa pouco: no máximo ~190 px
      expect((await rect(page, '.toolbar')).height).toBeLessThanOrEqual(190);
      // sem rolagem lateral da página nem da barra
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('.toolbar').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await expectNoOverlap(page);
      await page.screenshot({ path: `/tmp/claude-0/-home-claude/d8ea7a8d-dd83-571a-8de8-489dd3e3dc93/scratchpad/portrait-${w}.png` });
      expect(errors).toEqual([]);
    });
  }

  it('os quatro botões funcionam: Chat abre o assistente, Desfazer desfaz, Histórico e Cenas abrem', async () => {
    const l = await lab();
    const { page, errors } = await open(l, phone(360, 780));
    await action(page, 'Assistente').click();
    await page.locator('mx-assistant-panel').waitFor();
    expect(await action(page, 'Assistente').getAttribute('aria-expanded')).toBe('true');
    const tok = await l.login(OPERATOR_PIN);
    await l.command(tok, { type: 'set_level', channel: 'surdo', deltaDB: 3 });
    expect((l.mixer.read(paramKey.level(9, MASTER) as never) as { value: number }).value).toBe(-7);
    await action(page, 'Desfazer').click();
    await expect.poll(() => (l.mixer.read(paramKey.level(9, MASTER) as never) as { value: number }).value).toBe(-10);
    await action(page, 'Histórico').click();
    await page.locator('.history').waitFor();
    await action(page, 'Cenas').click();
    await page.locator('mx-scenes').waitFor();
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.locator('mx-scenes').waitFor({ state: 'detached' });
    expect(errors).toEqual([]);
  });

  it('motivo do envio bloqueado continua visível (sem sobrepor as ações) e o texto fica', async () => {
    const l = await lab();
    const { page } = await open(l, phone(320, 640));
    const field = page.getByPlaceholder('O que você deseja ajustar?');
    await field.fill('sobe o surdo no PA');
    const ws = (l.server.https[0] as unknown as { websocketServer: { clients: Set<{ terminate(): void }> } }).websocketServer;
    for (const c of ws.clients) c.terminate();
    const hint = page.getByTestId('assist-hint');
    await hint.waitFor({ state: 'visible' });
    expect(await hint.textContent()).toContain('Sem conexão');
    const hb = (await hint.boundingBox())!;
    expect(hb.width).toBeGreaterThan(200);
    for (const n of ACTIONS) expect(overlaps(hb, (await action(page, n).boundingBox())!), n).toBe(false);
    expect(hb.y).toBeLessThan((await action(page, 'Assistente').boundingBox())!.y); // entre o campo e as ações
    await field.press('Enter');
    expect(await field.inputValue()).toBe('sobe o surdo no PA');
  });

  it('aprovações continuam iguais: o cartão aparece e o operador aprova', async () => {
    const l = await lab();
    const { page } = await open(l, phone(390, 844));
    const token = readFileSync(`${l.dir}/agent-lab.token`, 'utf8');
    await l.http('/api/command', { token, body: { requestId: 'p-1', targetMode: 'lab', command: { type: 'set_master', deltaDB: -3 } } });
    const card = page.locator('.card').first();
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: 'Aprovar' }).click();
    await expect.poll(() => (l.mixer.read(paramKey.master() as never) as { value: number }).value).toBe(-9);
  });

  it('tela estreita demais (230 px): ações em 2 × 2, sem sobreposição e sem rolagem lateral', async () => {
    const l = await lab();
    // a tela de PIN não é feita para 230 px: entra com 320 e estreita a janela
    const { page } = await open(l, phone(320, 640));
    await page.setViewportSize({ width: 230, height: 640 });
    await page.waitForTimeout(200);
    const acts = await Promise.all(ACTIONS.map(async (n) => (await action(page, n).boundingBox())!));
    expect(Math.abs(acts[0]!.y - acts[1]!.y)).toBeLessThan(2);
    expect(acts[2]!.y).toBeGreaterThan(acts[0]!.y + acts[0]!.height - 1);
    for (const b of acts) expect(b.width).toBeGreaterThanOrEqual(48);
    for (let i = 0; i < acts.length; i++) for (let j = i + 1; j < acts.length; j++) expect(overlaps(acts[i]!, acts[j]!)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectNoOverlap(page);
  });

  it('Yoga e celular deitado não mudam: rótulos completos, sem ícones, barra numa linha', async () => {
    const l = await lab();
    const yoga = await open(l, YOGA);
    expect(await action(yoga.page, 'Assistente').locator('.tb-icon').isVisible()).toBe(false);
    expect((await action(yoga.page, 'Assistente').innerText()).trim()).toBe('Assistente');
    expect(await yoga.page.locator('.sim-legend').innerText()).toBe('Medidores SIMULADOS (laboratório) — não é o som real');
    // mesma barra de antes desta branch (130 px no Yoga a 125%; medida na main)
    const bar = await rect(yoga.page, '.toolbar');
    expect(bar.height).toBeLessThanOrEqual(130);
    expect((await action(yoga.page, 'Desfazer').boundingBox())!.y).toBeLessThan(bar.y + 64); // ações na 1ª linha, como antes
    expect(await yoga.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    const land = await open(l, { viewport: { width: 780, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 }, false);
    expect(await action(land.page, 'Cenas').locator('.tb-icon').isVisible()).toBe(false);
    expect((await rect(land.page, '.toolbar')).height).toBeLessThanOrEqual(64);
  });
});
