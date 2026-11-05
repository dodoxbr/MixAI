import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bandChannels, enter, launch, OPERATOR_PIN, startLab, YOGA } from './harness.js';

/**
 * Perfil OPERADOR (Yoga): todo pedido ao assistente termina em proposta, pergunta, resposta
 * ou erro VISÍVEL na tela — nunca em silêncio. Falha encontrada no teste do Yoga: com
 * aprovações/histórico abertos ou tela estreita, a resposta chegava mas ficava fora da tela.
 */
type Lab = Awaited<ReturnType<typeof startLab>>;
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
  for (const l of labs.splice(0)) await l.server.close().catch(() => undefined);
});

async function lab(opts: Parameters<typeof startLab>[0] = {}) {
  const l = await startLab({ channels: bandChannels(), ...opts });
  labs.push(l);
  return l;
}
/** Abre o operador e junta os erros de JavaScript da página (nenhum é tolerado). */
async function operator(l: Lab, device: object = YOGA) {
  const r = await enter(browser, l.base, OPERATOR_PIN, device);
  contexts.push(r.ctx);
  const errors: string[] = [];
  r.page.on('pageerror', (e) => errors.push(e.message));
  return { page: r.page, errors };
}
const field = (page: Page) => page.getByPlaceholder('O que você deseja ajustar?');
const sendButton = (page: Page) => page.locator('.mx-assistant-input button[type=submit]');

/** Fração do elemento realmente visível (considera rolagens e o tamanho da janela). */
async function visibleRatio(page: Page, selector: string): Promise<number> {
  return page.locator(selector).last().evaluate(
    (el) =>
      new Promise<number>((resolve) => {
        const io = new IntersectionObserver((entries) => {
          io.disconnect();
          resolve(entries[0]!.intersectionRatio);
        });
        io.observe(el);
      }),
  );
}
/** Espera o último item da conversa ficar visível (≥ 80%) na tela. */
async function expectNewestVisible(page: Page) {
  await expect.poll(() => visibleRatio(page, '.assist-log > .assist-item'), { timeout: 4000 }).toBeGreaterThanOrEqual(0.8);
}
/** Três pedidos de master → três cartões de aprovação ocupando a coluna lateral. */
async function fillApprovals(l: Lab) {
  const op = await l.login(OPERATOR_PIN);
  for (const db of [-8, -9, -12]) await l.command(op, { type: 'set_master', db });
}

describe('operador: o chat sempre responde na tela', () => {
  it('Yoga (125%): Enter e o botão Enviar produzem proposta visível; Aplicar funciona', async () => {
    const l = await lab();
    const { page, errors } = await operator(l);
    await field(page).fill('sobe o surdo no PA');
    await field(page).press('Enter');
    await page.locator('.proposal').last().waitFor();
    await expectNewestVisible(page);
    await field(page).fill('qual o volume do master?');
    await sendButton(page).click();
    await expect.poll(() => page.locator('.assist-log > .assist-item:not(.from-user)').count()).toBe(2);
    await expectNewestVisible(page);
    await page.locator('.proposal').first().getByRole('button', { name: 'Aplicar' }).click();
    await page.locator('.tone-ok').filter({ hasText: 'Aplicado' }).waitFor();
    await expectNewestVisible(page);
    expect(errors).toEqual([]);
  });

  it('com aprovações pendentes e histórico abertos (Yoga a 150%), a resposta não fica escondida', async () => {
    const l = await lab();
    const { page, errors } = await operator(l, { viewport: { width: 1280, height: 650 }, hasTouch: true, deviceScaleFactor: 1.5 });
    await fillApprovals(l);
    await expect.poll(() => page.locator('.card').count()).toBe(3);
    await page.getByRole('button', { name: 'Histórico' }).click();
    await field(page).fill('sobe o surdo no PA');
    await field(page).press('Enter');
    await page.locator('.proposal').last().waitFor();
    await expectNewestVisible(page);
    // as aprovações continuam acessíveis na mesma coluna
    expect(await visibleRatio(page, 'mx-pending-cards')).toBeGreaterThan(0.5);
    expect(errors).toEqual([]);
  });

  it('tela estreita (Yoga em retrato / escala 200%): o painel abaixo dos faders é trazido para a tela', async () => {
    const l = await lab();
    const { page, errors } = await operator(l, { viewport: { width: 600, height: 900 }, hasTouch: true, deviceScaleFactor: 2 });
    await field(page).fill('sobe o surdo no PA');
    await sendButton(page).click();
    await page.locator('.proposal').last().waitFor();
    await expectNewestVisible(page);
    expect(errors).toEqual([]);
  });

  it('campo vazio: tocar em Enviar explica o que fazer', async () => {
    const l = await lab();
    const { page } = await operator(l);
    await sendButton(page).click();
    await expect(page.getByTestId('assist-hint').textContent()).resolves.toContain('Escreva');
  });
});

describe('operador: conexão e sessão', () => {
  it('servidor caiu: botão desabilitado COM motivo, texto preservado; volta sozinho e envia', async () => {
    const l = await lab();
    const { page } = await operator(l);
    const ws = (l.server.https[0] as unknown as { websocketServer: { clients: Set<{ terminate(): void }> } }).websocketServer;
    for (const c of ws.clients) c.terminate();
    await page.getByTestId('assist-hint').filter({ hasText: 'Sem conexão' }).waitFor();
    expect(await sendButton(page).isDisabled()).toBe(true);
    await field(page).fill('sobe o surdo no PA');
    await field(page).press('Enter'); // nada é enviado; o texto fica
    expect(await field(page).inputValue()).toBe('sobe o surdo no PA');
    // reconectou (mesma sessão, mesmo servidor): o motivo some e o pedido sai
    await page.getByTestId('assist-hint').waitFor({ state: 'detached', timeout: 8000 });
    await sendButton(page).click();
    await page.locator('.proposal').last().waitFor();
  });

  it('pedido em andamento quando a conexão cai: erro visível, e NÃO é repetido ao reconectar', async () => {
    const pending: Array<(r: Response) => void> = [];
    let calls = 0;
    const l = await lab({
      ai: { enabled: true },
      aiKey: 'k',
      aiFetch: () => {
        calls++;
        return new Promise((r) => pending.push(r));
      },
    });
    const { page } = await operator(l);
    await field(page).fill('tá embolado o som');
    await sendButton(page).click();
    await page.locator('.assist-thinking').waitFor();
    await expect(page.getByTestId('assist-hint').textContent()).resolves.toContain('Esperando a resposta');
    expect(await sendButton(page).isDisabled()).toBe(true);
    const ws = (l.server.https[0] as unknown as { websocketServer: { clients: Set<{ terminate(): void }> } }).websocketServer;
    for (const c of ws.clients) c.terminate();
    await page.locator('.tone-error').filter({ hasText: 'não será repetido' }).waitFor();
    await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    expect(calls).toBe(1); // a IA só foi chamada uma vez: nada reenviado
  });

  it('servidor reiniciado com a sessão antiga: volta ao PIN explicando; o pedido digitado não é enviado', async () => {
    const l1 = await startLab({ channels: bandChannels() });
    const { page, errors } = await operator(l1);
    const port = l1.server.port;
    await l1.server.close();
    await field(page).fill('sobe o surdo no PA');
    await field(page).press('Enter');
    const l2 = await lab({ dir: l1.dir, port });
    await page.locator('.login-notice').waitFor({ timeout: 10_000 });
    const notice = await page.locator('.login-notice').textContent();
    expect(notice).toContain('servidor do MixAI foi reiniciado');
    expect(notice).toContain('não foram repetidos');
    // e entrar de novo funciona normalmente
    for (const d of OPERATOR_PIN) await page.getByRole('button', { name: d, exact: true }).click();
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
    expect(await page.locator('.proposal').count()).toBe(0); // conversa antiga não volta
    expect(l2.mixer.read('ch.9.main.level' as never)).toMatchObject({ value: -10 }); // nada aplicado
    expect(errors).toEqual([]);
  });

  it('sessão vencida (12 h): volta ao PIN dizendo que venceu', async () => {
    const l = await lab();
    const { page } = await operator(l);
    l.clock.advance(13 * 3_600_000);
    await page.locator('.login-notice').waitFor({ timeout: 5000 });
    await expect(page.locator('.login-notice').textContent()).resolves.toContain('venceu');
  });

  it('Sair em outra aba com a mesma sessão: esta tela volta ao PIN dizendo que foi encerrada', async () => {
    const l = await lab();
    const { page } = await operator(l);
    const token = await page.evaluate(() => sessionStorage.getItem('mixai.token'));
    await l.http('/api/logout', { token: token!, body: {} });
    await page.locator('.login-notice').waitFor({ timeout: 5000 });
    await expect(page.locator('.login-notice').textContent()).resolves.toContain('encerrada');
  });
});
