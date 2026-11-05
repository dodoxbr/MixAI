import { readFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { paramKey } from '../../src/core/revisions.js';
import { auxBus, MASTER } from '../../src/mixer/types.js';
import { enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, startLab, YOGA } from './harness.js';

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
  for (const l of labs.splice(0)) await l.server.close();
});

async function lab(opts: Parameters<typeof startLab>[0] = {}) {
  const l = await startLab(opts);
  labs.push(l);
  return l;
}
async function open(l: Lab, pin: string, device: object = YOGA) {
  const r = await enter(browser, l.base, pin, device);
  contexts.push(r.ctx);
  return r.page;
}
const value = (l: Lab, key: string) => (l.mixer.read(key as never) as { value?: number }).value;
const stripValue = (page: Page, i: number) => page.locator('.strips .strip-value').nth(i);
const VOZ1 = paramKey.level(1, MASTER);

/** Arraste por TOQUE de verdade (eventos de toque do Chromium → pointer events). */
async function touchDrag(page: Page, selector: string, dy: number) {
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const point = (py: number) => [{ x, y: py, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(y) });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(y + (dy * i) / 10) });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Posição do botão do fader (para arrastar a partir dele). */
async function thumbCenter(page: Page, strip: number) {
  const box = (await page.locator('.strips mx-strip').nth(strip).locator('.thumb rect').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe('interface E3 (LAB, navegador real)', () => {
  it('dois dispositivos sincronizados: Yoga (operador) e celular (músico)', async () => {
    const l = await lab();
    const yoga = await open(l, OPERATOR_PIN);
    const phone = await open(l, MUSICIAN_PIN, PHONE);
    await yoga.getByRole('tab', { name: 'FONES' }).click();
    const fonesCavaco = paramKey.level(1, auxBus(1));
    const before = value(l, fonesCavaco)!;

    // músico aperta + no celular → o Yoga mostra o novo valor
    await phone.getByRole('button', { name: 'Aumentar Voz 1 no fone' }).click();
    await expect.poll(() => value(l, fonesCavaco)).toBe(before + 2);
    await expect.poll(() => stripValue(yoga, 0).textContent()).toContain(`−${Math.abs(before + 2).toFixed(1)} dB`);

    // operador mexe pelo teclado no Yoga → o celular acompanha
    await yoga.locator('.strips mx-strip').nth(0).locator('mx-fader svg').focus();
    await yoga.keyboard.press('PageUp');
    await expect.poll(() => value(l, fonesCavaco)).toBe(before + 7);
    await expect.poll(() => phone.getByTestId('fones-value-1').textContent()).toContain(`−${Math.abs(before + 7).toFixed(1)} dB`);
  });

  it('fader por toque e por arraste do mouse; o gesto inteiro vira UM desfazer', async () => {
    const l = await lab({ safety: { maxActionsPerSecond: 5 } });
    const page = await open(l, OPERATOR_PIN);
    await touchDrag(page, '.strips mx-strip >> nth=0 >> mx-fader svg', -150); // toque, para cima
    await expect.poll(() => value(l, VOZ1)).toBeGreaterThan(-10);
    const afterTouch = value(l, VOZ1)!;
    await expect.poll(() => stripValue(page, 0).textContent()).toContain(afterTouch > 0 ? '+' : afterTouch === 0 ? '0.0' : '−');

    const t = await thumbCenter(page, 1);
    await page.mouse.move(t.x, t.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(t.x, t.y + i * 20, { steps: 2 });
    await page.mouse.up();
    await expect.poll(() => value(l, paramKey.level(2, MASTER))).toBeLessThan(-20); // passo grande, sem cartão
    expect(await page.locator('.card').count()).toBe(0);

    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect.poll(() => value(l, paramKey.level(2, MASTER))).toBe(-10); // o arraste inteiro de uma vez
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect.poll(() => value(l, VOZ1)).toBe(-10);
  });

  it('toque no trilho sem arrastar não muda o volume', async () => {
    const l = await lab();
    const page = await open(l, OPERATOR_PIN);
    const box = (await page.locator('.strips mx-strip').nth(0).locator('mx-fader svg').boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.6, box.y + 30); // bem no topo
    await page.waitForTimeout(300);
    expect(value(l, VOZ1)).toBe(-10);
  });

  it('alternar PA/FONES não altera nenhum valor', async () => {
    const l = await lab();
    const page = await open(l, OPERATOR_PIN);
    const before = JSON.stringify(l.controller.state.snapshot().params);
    for (let i = 0; i < 4; i++) {
      await page.getByRole('tab', { name: 'FONES' }).click();
      await page.getByRole('tab', { name: 'PA' }).click();
    }
    await page.waitForTimeout(200);
    expect(JSON.stringify(l.controller.state.snapshot().params)).toBe(before);
    await page.getByRole('tab', { name: 'FONES' }).click();
    await expect(page.locator('.shared-warning').textContent()).resolves.toContain('TODOS');
  });

  it('músico não controla o PA: a tela não oferece, e o servidor recusa mesmo se a tela for burlada', async () => {
    const l = await lab();
    const phone = await open(l, MUSICIAN_PIN, PHONE);
    expect(await phone.locator('mx-mesa').count()).toBe(0);
    expect(await phone.getByText('MASTER').count()).toBe(0);
    // Burlando a tela: o músico manda à mão um comando de PA pelo próprio WebSocket.
    const result = await phone.evaluate(async () => {
      const token = sessionStorage.getItem('mixai.token');
      const ws = new WebSocket(`ws://${location.host}/ws`);
      const msgs: Array<Record<string, unknown>> = [];
      await new Promise((r) => (ws.onopen = r));
      ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: 'auth', token }));
      await new Promise((r) => setTimeout(r, 200));
      ws.send(JSON.stringify({ type: 'command', requestId: 'hack-1', command: { type: 'set_master', db: 0 } }));
      ws.send(JSON.stringify({ type: 'fader', gestureId: 'hack', channel: 1, db: 0, final: true }));
      await new Promise((r) => setTimeout(r, 400));
      ws.close();
      return msgs.filter((m) => m.type === 'result' || m.type === 'fader_result').map((m) => (m.result as { code: string }).code);
    });
    expect(result).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    expect(value(l, VOZ1)).toBe(-10);
    expect(value(l, paramKey.master())).toBe(-6);
  });

  it('operação crítica: master vira cartão; operador aprova; pedido do assistente é recusado na tela', async () => {
    const l = await lab();
    const page = await open(l, OPERATOR_PIN);
    const master = page.locator('.master-area mx-fader svg');
    await master.focus();
    await page.keyboard.press('PageDown'); // -6 → -11: só propõe
    const card = page.locator('.card').first();
    await card.waitFor();
    await expect(card.textContent()).resolves.toContain('MASTER');
    expect(value(l, paramKey.master())).toBe(-6); // nada mudou ainda
    await card.getByRole('button', { name: 'Aprovar' }).click();
    await expect.poll(() => value(l, paramKey.master())).toBe(-11);
    await expect.poll(() => page.locator('.card').count()).toBe(0);

    // o assistente (MCP) pede um snapshot: aparece cartão; o operador recusa
    const token = readFileSync(`${l.dir}/agent-lab.token`, 'utf8');
    await l.http('/api/command', { token, body: { requestId: 'ag-1', targetMode: 'lab', command: { type: 'load_snapshot', show: 'Laboratório', snapshot: 'Bar' } } });
    const agentCard = page.locator('.card').filter({ hasText: 'assistente' });
    await agentCard.waitFor();
    await agentCard.getByRole('button', { name: 'Recusar' }).click();
    await expect.poll(() => page.locator('.card').count()).toBe(0);
    await page.locator('.toast').filter({ hasText: 'Recusado' }).waitFor();
  });

  it('pendência expirada some da tela com aviso', async () => {
    const l = await lab();
    const page = await open(l, OPERATOR_PIN);
    await page.locator('.master-area mx-fader svg').focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('.card').waitFor();
    l.clock.advance(61_000); // o relógio do servidor passa da validade
    await expect.poll(() => page.locator('.card').count(), { timeout: 5000 }).toBe(0);
    await page.locator('.toast-error').filter({ hasText: 'expirou' }).waitFor();
  });

  it('reconexão: a conexão cai, alguém muda a mesa, a tela volta sozinha com o estado novo', async () => {
    const l = await lab();
    const page = await open(l, OPERATOR_PIN);
    const ws = (l.server.https[0] as unknown as { websocketServer: { clients: Set<{ terminate(): void }> } }).websocketServer;
    for (const c of ws.clients) c.terminate();
    await page.locator('.offline-banner').waitFor();
    const op = await l.login(OPERATOR_PIN);
    await l.command(op, { type: 'set_level', channel: 1, deltaDB: 4 }); // mudou enquanto a tela estava fora
    await page.locator('.offline-banner').waitFor({ state: 'detached', timeout: 8000 });
    await expect.poll(() => stripValue(page, 0).textContent()).toContain('−6.0 dB');
  });

  it('servidor reiniciado: a tela volta ao PIN avisando que a sessão terminou', async () => {
    const l1 = await startLab();
    const page = await open(l1, OPERATOR_PIN);
    const port = l1.server.port;
    const t0 = Date.now();
    await l1.server.close();
    expect(Date.now() - t0).toBeLessThan(5000); // desliga na hora, mesmo com o navegador conectado
    await lab({ dir: l1.dir, port });
    await page.locator('.login-notice').waitFor({ timeout: 10_000 });
    await expect(page.locator('.login-notice').textContent()).resolves.toContain('sessão terminou');
  });

  it('responsivo: Yoga mostra os 11 canais sem rolar; celular sem rolagem horizontal da página e alvos ≥ 48 px', async () => {
    const { bandChannels } = await import('./harness.js');
    const l = await lab({ channels: bandChannels() });
    const yoga = await open(l, OPERATOR_PIN);
    await expect.poll(() => yoga.locator('.strips mx-strip').count()).toBe(11);
    const strips = yoga.locator('.strips');
    const [sw, cw] = await strips.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(sw).toBeLessThanOrEqual(cw + 1); // nada escondido
    expect(await yoga.locator('.master-area').isVisible()).toBe(true);

    const phoneOp = await open(l, OPERATOR_PIN, PHONE);
    const [pageW, viewW] = await phoneOp.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(pageW).toBeLessThanOrEqual(viewW); // a página não rola para o lado (só a fileira de canais)
    await phoneOp.getByRole('tab', { name: 'FONES' }).click();
    await phoneOp.locator('mx-fones-list').waitFor(); // celular: lista − / +, sem faders

    const phoneMus = await open(l, MUSICIAN_PIN, PHONE);
    const sizes = await phoneMus.locator('.step').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(sizes.length).toBe(22);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(48);
  });
});
