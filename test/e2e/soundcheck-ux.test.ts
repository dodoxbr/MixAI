import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { PROJECT_ROOT } from '../../src/core/config.js';
import { LocalKnowledge } from '../../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../../src/knowledge/local/store.js';
import { enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, YOGA, physicalBandChannels, startLab } from './harness.js';

/**
 * UX da passagem de som: tela própria, checklist uma etapa por vez, sem sobreposição com a Base de conhecimento
 * (ligada de verdade), em desktop, tablet e celular. Somente leitura de layout e registro humano: nenhuma escrita na mesa.
 */
let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async () => { browser = await launch(); });
afterEach(async () => { for (const ctx of browser.contexts()) await ctx.close(); for (const t of labs.splice(0)) await t.server.close(); vi.restoreAllMocks(); });
afterAll(async () => { await browser.close(); });

const TABLET = { viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 1 };
const LANDSCAPE = { ...PHONE, viewport: { width: 780, height: 360 } };
const DEVICES = [['Yoga', YOGA], ['tablet', TABLET], ['celular', PHONE], ['celular deitado', LANDSCAPE]] as const;

/** Servidor LAB com a base de conhecimento montada: o painel "Base de conhecimento" aparece abaixo da Mesa. */
async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-e2e-ux-'));
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json'));
  await store.init();
  const knowledge = new LocalKnowledge({ store, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  await knowledge.importSeed();
  const t = await startLab({ channels: physicalBandChannels(), knowledge, dir });
  labs.push(t);
  return t;
}

const intersects = (page: Page, a: string, b: string) => page.evaluate(([x, y]) => {
  const A = document.querySelector(x!)?.getBoundingClientRect(), B = document.querySelector(y!)?.getBoundingClientRect();
  if (!A || !B) return 'ausente';
  return !(A.bottom <= B.top + 1 || B.bottom <= A.top + 1 || A.right <= B.left + 1 || B.right <= A.left + 1);
}, [a, b]);
const pageScrollsSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const goPassagem = async (page: Page) => { await page.getByRole('button', { name: 'Passagem de som', exact: true }).click(); await page.locator('mx-soundcheck h2').waitFor(); };
async function startEvent(page: Page, name = 'Ensaio de sábado') {
  await page.getByLabel('Nome do evento da passagem', { exact: true }).fill(name);
  await page.getByLabel('Operador da passagem', { exact: true }).fill('Fernando');
  await page.getByRole('button', { name: 'Iniciar passagem LAB', exact: true }).click();
  await page.getByRole('button', { name: 'Pausar passagem', exact: true }).waitFor();
}

for (const [label, device] of DEVICES) {
  it(`nada se sobrepõe: MASTER, faders e passagem de som não cobrem a Base de conhecimento — ${label}`, async () => {
    const t = await lab();
    const { page } = await enter(browser, t.base, OPERATOR_PIN, device);
    await page.locator('mx-knowledge-admin').waitFor();
    expect(await intersects(page, '.master-area', 'mx-knowledge-admin'), 'MASTER × Base').toBe(false);
    expect(await intersects(page, '.strips', 'mx-knowledge-admin'), 'faders × Base').toBe(false);
    expect(await pageScrollsSideways(page)).toBe(false);
    if (label !== 'celular deitado') expect((await page.locator('.mesa-main').boundingBox())!.height, 'área dos faders nunca espremida').toBeGreaterThanOrEqual(440);

    await goPassagem(page);
    expect(await page.locator('.strips').count(), 'a passagem de som é outra tela: sem faders').toBe(0);
    expect(await intersects(page, 'mx-soundcheck', 'mx-knowledge-admin')).toBe(false);
    await startEvent(page);
    expect(await intersects(page, 'mx-soundcheck', 'mx-knowledge-admin')).toBe(false);
    expect(await pageScrollsSideways(page)).toBe(false);
  });
}

it('navegação principal: abas Mesa e Passagem de som, aba atual indicada, Mesa preservada ao voltar, músico sem a aba', async () => {
  const t = await lab();
  const writes = vi.spyOn(t.mixer, 'write');
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const nav = page.getByRole('navigation', { name: 'Seções do MixAI' });
  expect(await nav.getByRole('button').allTextContents()).toEqual(['Mesa', 'Passagem de som']);
  expect(await nav.locator('[aria-current="page"]').allTextContents()).toEqual(['Mesa']);
  expect(await page.locator('mx-soundcheck').count()).toBe(0);

  // pelo teclado: foco na aba e Enter
  const tab = nav.getByRole('button', { name: 'Passagem de som', exact: true });
  await tab.focus();
  await tab.press('Enter');
  await page.locator('mx-soundcheck h2').waitFor();
  expect(await nav.locator('[aria-current="page"]').allTextContents()).toEqual(['Passagem de som']);
  expect(await page.evaluate(() => document.activeElement?.id), 'foco vai ao título da tela').toBe('sc-screen-title');
  await startEvent(page, 'Evento que sobrevive à navegação');

  await nav.getByRole('button', { name: 'Mesa', exact: true }).click();
  await page.locator('.strips').first().waitFor();
  await expect.poll(() => page.locator('mx-soundcheck').count()).toBe(0);
  await goPassagem(page);
  const options = await page.getByLabel('Evento da passagem', { exact: true }).locator('option').allTextContents();
  expect(options.some((o) => o.includes('Evento que sobrevive à navegação')), 'eventos e históricos preservados').toBe(true);

  const mu = await enter(browser, t.base, MUSICIAN_PIN, PHONE, undefined, false);
  expect(await mu.page.getByRole('button', { name: 'Passagem de som', exact: true }).count()).toBe(0);
  expect(await mu.page.getByRole('navigation', { name: 'Seções do MixAI' }).count()).toBe(0);
  expect(writes).not.toHaveBeenCalled();
});

it('checklist progressivo: uma etapa por vez, lista com a situação de cada etapa, progresso e foco', async () => {
  const t = await lab();
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  await goPassagem(page);
  await startEvent(page);
  const wiz = page.locator('mx-soundcheck');
  expect(await wiz.locator('.steps .step').count(), 'as 13 etapas na lista').toBe(13);
  expect(await wiz.locator('fieldset').count(), 'um formulário por vez, não 13').toBe(1);
  expect(await wiz.locator('fieldset textarea').count()).toBe(4);
  expect(await wiz.locator('h3').count()).toBe(1);
  expect(await wiz.locator('h4').innerText()).toMatch(/^Etapa 1 de 13/);
  expect(await wiz.locator('.steps .step[aria-current="step"]').count()).toBe(1);
  expect(await wiz.getByRole('button', { name: 'Anterior', exact: true }).isDisabled()).toBe(true);
  expect(await wiz.getByRole('progressbar', { name: 'Progresso da passagem' }).getAttribute('aria-valuetext')).toBe('0 de 13 etapas concluídas');

  await wiz.getByRole('button', { name: 'Próxima', exact: true }).click();
  await expect.poll(() => wiz.locator('h4').innerText()).toMatch(/^Etapa 2 de 13/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id), { message: 'foco no título da etapa' }).toBe('sc-step-title');
  await wiz.getByRole('button', { name: 'Anterior', exact: true }).click();
  await expect.poll(() => wiz.locator('h4').innerText()).toMatch(/^Etapa 1 de 13/);

  // lista com teclado: Tab até uma etapa e Enter
  const third = wiz.locator('.steps .step').nth(2);
  await third.focus();
  await third.press('Enter');
  await expect.poll(() => wiz.locator('h4').innerText()).toMatch(/^Etapa 3 de 13/);
  await expect.poll(() => third.getAttribute('aria-current')).toBe('step');

  // seletor "Ir para a etapa" continua disponível e leva à mesma etapa
  const steps = await wiz.getByLabel('Etapa da passagem', { exact: true }).locator('option').evaluateAll((n) => n.map((o) => (o as HTMLOptionElement).value));
  expect(steps).toHaveLength(13);
  await wiz.getByLabel('Etapa da passagem', { exact: true }).selectOption(steps[5]!);
  await expect.poll(() => wiz.locator('h4').innerText()).toMatch(/^Etapa 6 de 13/);

  // "Problema" ganha destaque quando a situação é problema
  await wiz.getByLabel('Situação da etapa', { exact: true }).selectOption('problem');
  await expect.poll(() => wiz.locator('label.field.attention').count()).toBe(1);
  await wiz.getByLabel('Problema da etapa', { exact: true }).fill('Relato sem medição');
  await wiz.getByRole('checkbox', { name: 'Confirmo humanamente este registro' }).check();
  await wiz.getByRole('button', { name: 'Salvar etapa e avançar', exact: true }).click();
  await wiz.getByRole('status').filter({ hasText: 'salva' }).waitFor();
  expect(await wiz.locator('.steps .step').nth(5).locator('.pill').innerText()).toBe('Problema');
  expect(await wiz.locator('.progress-text').innerText()).toContain('0 de 13 etapas concluídas · 1 com problema');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('sc-step-title');

  // uma etapa verificada conta no progresso
  await wiz.locator('.steps .step').nth(0).click();
  await wiz.getByLabel('Situação da etapa', { exact: true }).selectOption('verified');
  await wiz.getByRole('checkbox', { name: 'Confirmo humanamente este registro' }).check();
  await wiz.getByRole('button', { name: 'Salvar etapa e avançar', exact: true }).click();
  await expect.poll(() => wiz.locator('.progress-text').innerText()).toContain('1 de 13 etapas concluídas · 1 com problema');
  expect(await wiz.locator('.steps .step').nth(0).locator('.pill').innerText()).toBe('Verificada');
});

for (const [label, device] of DEVICES) {
  it(`responsivo: sem rolagem lateral, alvos de toque ≥ 44 px e campos legíveis — ${label}`, async () => {
    const t = await lab();
    const { page } = await enter(browser, t.base, OPERATOR_PIN, device);
    await goPassagem(page);
    await startEvent(page);
    const wiz = page.locator('mx-soundcheck');
    expect(await pageScrollsSideways(page)).toBe(false);
    const small = await page.evaluate(() => [...document.querySelectorAll('mx-soundcheck button, mx-soundcheck select, mx-soundcheck textarea, mx-soundcheck input:not([type=checkbox])')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5; })
      .map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40)));
    expect(small, 'alvos pequenos').toEqual([]);
    const outside = await page.evaluate(() => [...document.querySelectorAll('mx-soundcheck .step-card *, mx-soundcheck .card *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.steps')).length);
    expect(outside, 'nada do formulário fora da tela').toBe(0);
    const card = (await wiz.locator('.step-card').boundingBox())!;
    for (const name of ['Relato da etapa', 'Problema da etapa', 'Observações da etapa']) {
      const box = (await wiz.getByLabel(name, { exact: true }).boundingBox())!;
      expect(box.width, name).toBeGreaterThanOrEqual(Math.min(260, card.width * 0.7));
    }
    if (device.viewport.width < 900) expect(await wiz.locator('.workspace').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 'uma coluna').toBe(1);
  });
}

it('assistente: a conversa não é cortada e não cobre a Base de conhecimento — desktop, tablet e celular', async () => {
  for (const [label, device] of [['Yoga', YOGA], ['tablet', TABLET], ['celular', PHONE]] as const) {
    const t = await lab();
    const { page } = await enter(browser, t.base, OPERATOR_PIN, device);
    await goPassagem(page);
    await startEvent(page, 'Antes do chat ' + label); // o painel da passagem já foi aberto uma vez: a Mesa não pode ficar espremida depois
    await page.getByRole('button', { name: 'Mesa', exact: true }).click();
    await page.getByPlaceholder('O que você deseja ajustar?').fill('surdo sem grave');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('.chat-question').first().waitFor();
    const log = await page.evaluate(() => {
      const el = document.querySelector('.assist-log') as HTMLElement | null;
      const last = [...(el?.children ?? [])].pop() as HTMLElement | undefined;
      if (!el || !last) return null;
      const L = el.getBoundingClientRect(), E = last.getBoundingClientRect();
      return { height: L.height, fits: E.bottom <= L.bottom + 2, scrolls: el.scrollHeight > el.clientHeight + 1, text: last.innerText.length };
    });
    expect(log, label).not.toBeNull();
    expect(log!.height, `${label}: área da conversa com altura útil`).toBeGreaterThanOrEqual(220);
    expect(log!.fits || log!.scrolls, `${label}: a última mensagem cabe ou a área rola`).toBe(true);
    expect(await intersects(page, '.master-area', 'mx-knowledge-admin'), label).toBe(false);
    expect(await intersects(page, '.side', 'mx-knowledge-admin'), label).toBe(false);
    for (const x of labs.splice(0)) await x.server.close();
    for (const c of browser.contexts()) await c.close();
  }
});

it('aprovações pendentes continuam visíveis na tela da passagem de som, com atalho para a Mesa', async () => {
  const t = await lab();
  const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
  const token = (await page.evaluate(() => sessionStorage.getItem('mixai.token')))!;
  const asked = await t.command(token, { type: 'set_master', db: -3 });
  expect(asked.json.result.needsConfirmation).toBe(true);
  await goPassagem(page);
  const banner = page.locator('.pending-banner');
  await banner.waitFor();
  expect(await banner.innerText()).toContain('1 aprovação pendente');
  await banner.getByRole('button', { name: 'Ir para a Mesa', exact: true }).click();
  await page.locator('.strips').first().waitFor();
  await expect.poll(() => page.locator('mx-pending-cards').innerText()).not.toBe('');
});

it('celular em retrato: abas numa barra fixa embaixo e, no fim da página, nada fica coberto por ela', async () => {
  const t = await lab();
  const { page } = await enter(browser, t.base, OPERATOR_PIN, PHONE);
  await page.locator('mx-knowledge-admin').waitFor();
  const vh = await page.evaluate(() => innerHeight);
  const bar = (await page.locator('.main-nav').boundingBox())!;
  expect(Math.round(bar.y + bar.height), 'barra encostada no fim da tela').toBeGreaterThanOrEqual(vh - 1);
  expect(bar.y, 'o topo não gasta uma linha com as abas').toBeGreaterThan(vh / 2);
  // os faders continuam na primeira tela (garantia de portrait.test.ts)
  expect((await page.locator('.strips mx-fader').first().boundingBox())!.y).toBeLessThan(vh - 120);
  for (const screen of ['mesa', 'passagem']) {
    if (screen === 'passagem') await goPassagem(page);
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250);
    const covered = await page.evaluate(() => {
      const navTop = document.querySelector('.main-nav')!.getBoundingClientRect().top;
      const admin = document.querySelector('mx-knowledge-admin')!.getBoundingClientRect();
      return admin.bottom > navTop + 1;
    });
    expect(covered, 'Base de conhecimento coberta pela barra no fim da ' + screen).toBe(false);
  }
});
