import { devices, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { paramKey } from '../../src/core/revisions.js';
import { auxBus, MASTER } from '../../src/mixer/types.js';
import { bandChannels, enrollMusicianFixture, launch, MUSICIAN_PIN, OPERATOR_PIN, startLab, YOGA } from './harness.js';

/** Celular Android (Galaxy S24 no Chrome) em retrato e deitado. */
const PORTRAIT = devices['Galaxy S24']!;
const LANDSCAPE = devices['Galaxy S24 landscape']!;

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
async function lab(access?: 'pa_without_master') {
  const l = await startLab({ channels: bandChannels(), server: access ? { musicianAccess: access } : {} });
  labs.push(l);
  return l;
}
/** Abre a tela e registra TUDO o que ela envia de comando pelo WebSocket. */
async function open(l: Lab, pin: string, device: object) {
  // O registro dos frames é ligado ANTES de abrir a página (senão o WebSocket já existe e nada
  // é capturado, e "nenhum comando" passaria sem conferir nada).
  const ctx = await browser.newContext({ ...device, baseURL: l.base });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const r = { ctx, page };
  const sent: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  r.page.on('pageerror', (e) => errors.push(e.message));
  r.page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload)) as Record<string, unknown>;
        if (['command', 'fader', 'approve', 'reject', 'proposal_apply', 'assistant'].includes(String(m['type']))) sent.push(m);
      } catch {
        /* ignora */
      }
    }),
  );
  await page.goto('/');
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByTestId('link').filter({ hasText: 'Conectado' }).waitFor();
  if (pin === MUSICIAN_PIN) await enrollMusicianFixture(page);
  await page.evaluate(() => scrollTo(0, 0));
  expect(sent.length, 'o registro de frames precisa estar ativo').toBeGreaterThan(0); // list_names
  return { page, sent, errors };
}
/** Comandos que mudam a mesa (list_names/history são consultas). */
const writes = (sent: Array<Record<string, unknown>>) =>
  sent.filter((m) => m['type'] !== 'command' || !['list_names', 'history', 'mix_state', 'scene_list'].includes((m['command'] as { type: string }).type));
const v = (l: Lab, key: string) => (l.mixer.read(key as never) as { value?: unknown }).value;
/** Mede um elemento depois que ele existe e está visível (os canais chegam depois do login). */
const box = async (page: Page, selector: string) => {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible' });
  return (await loc.boundingBox())!;
};

/** Rotação sem recarregar: muda o tamanho da janela e avisa a página como o Android faz. */
async function rotate(page: Page, to: { viewport: { width: number; height: number } }) {
  await page.setViewportSize(to.viewport);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('orientationchange'));
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);
}

/** Faders utilizáveis: inteiros dentro da fileira de canais (nada cortado) e altos o bastante. */
async function expectFadersUsable(page: Page) {
  // espera os canais e os valores reais (não "desconhecido") antes de medir
  await expect.poll(() => page.locator('.strips .strip-value').first().textContent(), { timeout: 5000 }).toContain('dB');
  await page.waitForTimeout(150); // um quadro de layout depois da última mudança de tamanho
  const strips = await box(page, '.strips');
  const fader = await box(page, '.strips mx-fader');
  const mute = await box(page, '.strips .mx-strip .mute');
  expect(fader.height, 'altura do fader').toBeGreaterThanOrEqual(140);
  expect(fader.y, 'topo do fader dentro da fileira').toBeGreaterThanOrEqual(strips.y - 1);
  expect(fader.y + fader.height, 'fim do fader dentro da fileira').toBeLessThanOrEqual(strips.y + strips.height + 1);
  expect(mute.y + mute.height, 'MUTE do canal dentro da fileira').toBeLessThanOrEqual(strips.y + strips.height + 1);
  expect(mute.height).toBeGreaterThanOrEqual(44);
}

describe('Mesa do operador no celular Android', () => {
  it('retrato: faders inteiros, troca PA/FONES e MASTER acessível', async () => {
    const l = await lab();
    const { page, errors } = await open(l, OPERATOR_PIN, PORTRAIT);
    await expectFadersUsable(page);
    await page.locator('.master-area mx-fader').scrollIntoViewIfNeeded();
    expect((await box(page, '.master-area mx-fader')).height).toBeGreaterThanOrEqual(140);
    await page.getByRole('tab', { name: 'FONES' }).click();
    await page.locator('mx-fones-list').waitFor(); // em retrato, os FONES viram a lista
    await page.getByRole('tab', { name: 'PA' }).click();
    await page.locator('.strips').waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('deitado: canais lado a lado com rolagem horizontal, faders inteiros, MASTER separado e a barra numa linha', async () => {
    const l = await lab();
    const { page, errors } = await open(l, OPERATOR_PIN, LANDSCAPE);
    await expectFadersUsable(page);
    const strips = page.locator('.strips');
    expect(await strips.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true); // rolagem horizontal dos canais
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); // a página não rola de lado
    // MASTER à direita, separado e inteiro, sem esconder os canais
    const s = await box(page, '.strips');
    const m = await box(page, '.master-area');
    expect(m.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
    expect(s.width).toBeGreaterThan(400);
    expect((await box(page, '.master-area mx-fader')).height).toBeGreaterThanOrEqual(140);
    expect(await page.locator('.master-area').textContent()).toContain('MASTER');
    // barra superior compacta: uma linha, com todos os controles na tela
    const bar = await box(page, '.toolbar');
    expect(bar.height).toBeLessThanOrEqual(64);
    for (const name of ['PA', 'FONES']) await page.getByRole('tab', { name }).waitFor();
    for (const name of ['Assistente', 'Desfazer', 'Histórico', 'Cenas']) {
      const b = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b.x + b.width, name).toBeLessThanOrEqual(LANDSCAPE.viewport!.width);
      expect(b.height, name).toBeGreaterThanOrEqual(40);
    }
    // a página rola na vertical para mostrar a fileira inteira
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const afterScroll = await box(page, '.strips');
    expect(afterScroll.y + afterScroll.height).toBeLessThanOrEqual(LANDSCAPE.viewport!.height + 1);
    // o fader funciona deitado (toque de verdade)
    await page.getByRole('slider').first().focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => v(l, paramKey.level(1, MASTER))).toBe(-9);
    // troca PA/FONES deitado mantém os faders
    await page.getByRole('tab', { name: 'FONES' }).click();
    await expect.poll(() => page.locator('.strips .strip-value').first().textContent()).toContain('−20.0 dB');
    await expectFadersUsable(page);
    // Assistente, Histórico e Cenas abrem
    await page.getByRole('button', { name: 'Histórico', exact: true }).click();
    await page.locator('.history').waitFor();
    await page.getByRole('button', { name: 'Cenas', exact: true }).click();
    await page.locator('mx-scenes').waitFor();
    expect(errors).toEqual([]);
  });

  it('girar retrato → deitado → retrato sem recarregar: valores e posição mantidos, nenhum comando enviado', async () => {
    const l = await lab();
    const tok = await l.login(OPERATOR_PIN);
    await l.command(tok, { type: 'set_level', channel: 'surdo', db: -13 });
    const { page, sent, errors } = await open(l, OPERATOR_PIN, PORTRAIT);
    const before = writes(sent).length;
    const surdo = page.locator('.mx-strip', { hasText: 'Surdo' }).locator('.strip-value');
    await expect.poll(() => surdo.textContent()).toContain('−13.0 dB');
    const reloads: string[] = [];
    page.on('framenavigated', (f) => reloads.push(f.url()));

    await rotate(page, LANDSCAPE);
    await expectFadersUsable(page);
    // rola os canais até o Surdo e gira de novo: o Surdo continua à vista
    await page.locator('.mx-strip', { hasText: 'Surdo' }).scrollIntoViewIfNeeded();
    await page.locator('.strips').evaluate((el) => el.dispatchEvent(new Event('scroll')));
    await rotate(page, PORTRAIT);
    await rotate(page, LANDSCAPE);
    const s = await box(page, '.strips');
    const st = (await page.locator('.mx-strip', { hasText: 'Surdo' }).boundingBox())!;
    expect(st.x).toBeGreaterThanOrEqual(s.x - 1);
    expect(st.x).toBeLessThan(s.x + s.width);
    await rotate(page, PORTRAIT);
    await expectFadersUsable(page);

    expect(reloads).toEqual([]); // não recarregou
    expect(writes(sent).length).toBe(before); // NENHUM comando durante as rotações
    expect(v(l, paramKey.level(9, MASTER))).toBe(-13);
    await expect.poll(() => surdo.textContent()).toContain('−13.0 dB');
    expect(errors).toEqual([]);
  });

  it('toque cancelado pela rotação (pointercancel) não envia valor nenhum', async () => {
    const l = await lab();
    const { page, sent } = await open(l, OPERATOR_PIN, LANDSCAPE);
    const before = writes(sent).length;
    // toque REAL do Chromium no fader: encosta, arrasta e o sistema cancela (como ao girar)
    // As barras de ferramentas podem deslocar o SVG além da janela; toque exige alvo visível.
    await page.locator('.strips mx-fader svg').first().scrollIntoViewIfNeeded();
    const f = await box(page, '.strips mx-fader svg');
    const x = f.x + f.width / 2;
    const y = f.y + f.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(50);
    expect(await page.locator('.strips mx-fader').first().evaluate((el) => el.classList.contains('is-dragging'))).toBe(true); // o gesto começou
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await rotate(page, PORTRAIT);
    await page.waitForTimeout(300);
    expect(writes(sent).length).toBe(before);
    expect(v(l, paramKey.level(1, MASTER))).toBe(-10);
  });
});

describe('envio bloqueado com o celular deitado (correção da E4 preservada)', () => {
  it('conexão cai: o MOTIVO aparece na tela, o texto digitado fica e nenhum pedido sai; ao voltar, a barra é uma linha', async () => {
    const l = await lab();
    const { page, sent, errors } = await open(l, OPERATOR_PIN, LANDSCAPE);
    const bar = await box(page, '.toolbar');
    expect(bar.height, 'barra compacta numa linha').toBeLessThanOrEqual(64);
    expect(await page.getByTestId('assist-hint').count()).toBe(0);

    const field = page.getByPlaceholder('O que você deseja ajustar?');
    await field.fill('sobe o surdo no PA');
    const assistantBefore = sent.filter((m) => m['type'] === 'assistant').length;
    const ws = (l.server.https[0] as unknown as { websocketServer: { clients: Set<{ terminate(): void }> } }).websocketServer;
    for (const c of ws.clients) c.terminate();

    // o motivo aparece de verdade (não só em title/aria): visível, dentro da tela, com tamanho legível
    const hint = page.getByTestId('assist-hint');
    await hint.waitFor({ state: 'visible' });
    expect(await hint.textContent()).toContain('Sem conexão');
    const h = (await hint.boundingBox())!;
    expect(h.width).toBeGreaterThan(200);
    expect(h.height).toBeGreaterThan(10);
    expect(h.x).toBeGreaterThanOrEqual(0);
    expect(h.x + h.width).toBeLessThanOrEqual(LANDSCAPE.viewport!.width + 1);
    expect(h.y).toBeGreaterThanOrEqual(0);
    expect(h.y + h.height).toBeLessThanOrEqual(LANDSCAPE.viewport!.height);
    expect(await hint.evaluate((el) => getComputedStyle(el).visibility === 'visible' && Number(getComputedStyle(el).opacity) > 0.5)).toBe(true);
    // fica logo abaixo do campo e do botão (que continuam na tela)
    const send = page.locator('.mx-assistant-input button[type=submit]');
    expect(await send.isDisabled()).toBe(true);
    expect(h.y).toBeGreaterThan((await send.boundingBox())!.y);
    // faders continuam inteiros com o motivo à vista
    await expectFadersUsable(page);

    // tentar enviar: nada sai, o texto fica
    await field.press('Enter');
    await send.click({ force: true });
    await page.waitForTimeout(300);
    expect(await field.inputValue()).toBe('sobe o surdo no PA');

    // reconecta sozinho (mesma sessão): o motivo some, a barra volta a uma linha e o pedido sai UMA vez
    await hint.waitFor({ state: 'detached', timeout: 8000 });
    expect(sent.filter((m) => m['type'] === 'assistant').length).toBe(assistantBefore); // nada foi enviado offline
    expect((await box(page, '.toolbar')).height).toBeLessThanOrEqual(64);
    await send.click();
    await page.locator('.proposal').last().waitFor();
    expect(sent.filter((m) => m['type'] === 'assistant').length).toBe(assistantBefore + 1);
    expect(v(l, paramKey.level(9, MASTER))).toBe(-10); // só proposta; nada aplicado
    expect(errors).toEqual([]);
  });

  it('esperando a resposta anterior: o motivo também aparece deitado', async () => {
    const pending: Array<(r: Response) => void> = [];
    const l = await startLab({ channels: bandChannels(), ai: { enabled: true }, aiKey: 'k', aiFetch: () => new Promise((r) => pending.push(r)) });
    labs.push(l);
    const { page } = await open(l, OPERATOR_PIN, LANDSCAPE);
    await page.getByPlaceholder('O que você deseja ajustar?').fill('preciso organizar melhor a mix');
    await page.locator('.mx-assistant-input button[type=submit]').click();
    const hint = page.getByTestId('assist-hint');
    await hint.waitFor({ state: 'visible' });
    expect(await hint.textContent()).toContain('Esperando a resposta');
    expect((await hint.boundingBox())!.width).toBeGreaterThan(200);
  });
});

describe('MUTE rápido do músico', () => {
  it('fones_only: MUTE e ABRIR nos FONES (só o AUX autorizado); sem PA; PA e MASTER recusados no servidor', async () => {
    const l = await lab();
    const { page, errors } = await open(l, MUSICIAN_PIN, PORTRAIT);
    expect(await page.getByRole('tab', { name: 'PA' }).count()).toBe(0);
    await page.getByText('o som do público (PA) não muda').waitFor();
    const mute = page.getByTestId('mute-fones-7');
    expect(await mute.textContent()).toContain('FONES');
    const mb = (await mute.boundingBox())!;
    expect(mb.height).toBeGreaterThanOrEqual(44);
    expect(mb.width).toBeGreaterThanOrEqual(44);
    await mute.click();
    await expect.poll(() => v(l, paramKey.mute(7, auxBus(1)))).toBe(true);
    expect(v(l, paramKey.mute(7, MASTER))).toBe(false); // o PA não mudou
    await expect.poll(() => mute.getAttribute('aria-pressed')).toBe('true'); // atualizado pela resposta do servidor
    expect(await mute.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(229, 72, 77)'); // vermelho
    await page.getByRole('button', { name: 'Abrir Pandeiro no fone' }).click();
    await expect.poll(() => v(l, paramKey.mute(7, auxBus(1)))).toBe(false);

    const codes = await page.evaluate(async () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      const msgs: Array<Record<string, unknown>> = [];
      await new Promise((r) => (ws.onopen = r));
      ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: 'auth', token: sessionStorage.getItem('mixai.token') }));
      await new Promise((r) => setTimeout(r, 200));
      ws.send(JSON.stringify({ type: 'command', requestId: 'f1', command: { type: 'set_mute', channels: [7], muted: true } }));
      ws.send(JSON.stringify({ type: 'command', requestId: 'f2', command: { type: 'set_master', db: -20 } }));
      await new Promise((r) => setTimeout(r, 400));
      ws.close();
      return msgs.filter((m) => m.type === 'result').map((m) => (m.result as { code: string }).code);
    });
    expect(codes).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    expect(v(l, paramKey.mute(7, MASTER))).toBe(false);
    expect(v(l, paramKey.master())).toBe(-6);
    expect(errors).toEqual([]);
  });

  it('pa_without_master: MUTE e ABRIR no PA com um toque, e nos FONES; sem MASTER; mute em grupo no PA recusado', async () => {
    const l = await lab('pa_without_master');
    const { page, errors } = await open(l, MUSICIAN_PIN, PORTRAIT);
    await page.getByRole('tab', { name: 'PA' }).click();
    const paMute = page.getByTestId('mute-pa-9');
    expect(await paMute.textContent()).toContain('PA');
    await paMute.click();
    await expect.poll(() => v(l, paramKey.mute(9, MASTER))).toBe(true);
    expect(v(l, paramKey.mute(9, auxBus(1)))).toBe(false); // os fones não mudaram
    await page.getByRole('button', { name: 'Abrir Surdo no PA' }).click();
    await expect.poll(() => v(l, paramKey.mute(9, MASTER))).toBe(false);
    await page.getByRole('tab', { name: 'FONES' }).click();
    await page.getByTestId('mute-fones-9').click();
    await expect.poll(() => v(l, paramKey.mute(9, auxBus(1)))).toBe(true);
    expect(v(l, paramKey.mute(9, MASTER))).toBe(false);
    expect(await page.getByText('MASTER', { exact: true }).count()).toBe(0);
    const code = await page.evaluate(async () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      const msgs: Array<Record<string, unknown>> = [];
      await new Promise((r) => (ws.onopen = r));
      ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: 'auth', token: sessionStorage.getItem('mixai.token') }));
      await new Promise((r) => setTimeout(r, 200));
      ws.send(JSON.stringify({ type: 'command', requestId: 'g1', command: { type: 'set_mute', channels: [1, 2, 3], muted: true } }));
      await new Promise((r) => setTimeout(r, 300));
      ws.close();
      return (msgs.find((m) => m.type === 'result')!.result as { code: string }).code;
    });
    expect(code).toBe('FORBIDDEN');
    expect(errors).toEqual([]);
  });

  it('toques repetidos durante o pedido pendente viram UM comando; sem conexão o botão fica desabilitado', async () => {
    const l = await lab();
    const { page, sent } = await open(l, MUSICIAN_PIN, PORTRAIT);
    // segura a escrita na mesa: o pedido fica pendente
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = l.mixer.write.bind(l.mixer);
    l.mixer.write = async (k, val) => {
      await gate;
      return orig(k, val);
    };
    const mute = page.getByTestId('mute-fones-3');
    await mute.click();
    await expect.poll(() => mute.isDisabled()).toBe(true);
    await mute.click({ force: true });
    await mute.click({ force: true });
    release();
    l.mixer.write = orig;
    await expect.poll(() => v(l, paramKey.mute(3, auxBus(1)))).toBe(true);
    const mutes = sent.filter((m) => m['type'] === 'command' && (m['command'] as { type: string }).type === 'set_mute');
    expect(mutes).toHaveLength(1);
    expect(mutes[0]!['command']).toEqual({ type: 'set_mute', channels: [3], muted: true, aux: 1 });
    // sem conexão: desabilitado
    const ws = (l.server.https[0] as unknown as { websocketServer: { clients: Set<{ terminate(): void }> } }).websocketServer;
    for (const c of ws.clients) c.terminate();
    await expect.poll(() => mute.isDisabled()).toBe(true);
  });

  it('músico deitado: −, + e MUTE visíveis, sem rolagem horizontal, aproveitando a largura', async () => {
    const l = await lab('pa_without_master');
    const { page } = await open(l, MUSICIAN_PIN, LANDSCAPE);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const tab of ['FONES', 'PA']) {
      await page.getByRole('tab', { name: tab }).click();
      const row = page.locator('.fones-row').first();
      await row.scrollIntoViewIfNeeded();
      const r = (await row.boundingBox())!;
      for (const sel of ['.mute-toggle', '.step-down', '.step-up']) {
        const b = (await row.locator(sel).boundingBox())!;
        expect(b.x + b.width, `${tab} ${sel}`).toBeLessThanOrEqual(r.x + r.width + 1);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
      // duas colunas de canais (aproveita a largura)
      const second = (await page.locator('.fones-row').nth(1).boundingBox())!;
      expect(second.x).toBeGreaterThan(r.x + r.width / 2);
    }
  });
});

describe('sem regressão no Yoga', () => {
  it('Yoga: Mesa presa à altura da tela (sem rolagem da página), faders altos e barra como antes', async () => {
    const l = await lab();
    const { page, errors } = await open(l, OPERATOR_PIN, YOGA);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    expect((await box(page, '.strips mx-fader')).height).toBeGreaterThan(300);
    await expectFadersUsable(page);
    await page.locator('.sim-legend').waitFor(); // legenda continua no Yoga
    expect(await page.locator('.strips .mx-strip').count()).toBe(11);
    expect(errors).toEqual([]);
  });
});
