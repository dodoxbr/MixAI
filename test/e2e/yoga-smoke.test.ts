import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import { enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, startLab } from './harness.js';
import { wsClient } from '../server-support.js';
import { compareLabReal, exportLabRealComparison } from '../../src/core/lab-real-diff.js';
import { labRealFixture } from '../support/lab-real-fixtures.js';
import type { ParamKey } from '../../src/core/revisions.js';

vi.mock('../../src/mixer/real.js', () => { throw new Error('Smoke Yoga tentou carregar RealMixer.'); });

it('Yoga LAB: HTTP/WS, PA/FONES, EQ, cenas, aprovação, consulta, fixture, logout e persistência', async () => {
  const dir = mkdtempSync(join(process.env.MIXAI_SMOKE_DIR ?? tmpdir(), 'yoga-lab-'));
  const nativeFetch = globalThis.fetch;
  const NativeSocket = globalThis.WebSocket;
  const local = (url: string) => new URL(url).hostname === '127.0.0.1';
  vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!local(url)) throw new Error('Smoke bloqueou HTTP fora do loopback.');
    return nativeFetch(input, { ...init, redirect: 'error' });
  }) as typeof fetch);
  vi.stubGlobal('WebSocket', class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (!local(String(url))) throw new Error('Smoke bloqueou WS fora do loopback.');
      super(url, protocols);
    }
  });
  let lab: Awaited<ReturnType<typeof startLab>> | undefined;
  let browser: Awaited<ReturnType<typeof launch>> | undefined;
  const sockets: Awaited<ReturnType<typeof wsClient>>[] = [];
  const external: string[] = [];
  const prepare = async (ctx: BrowserContext) => {
    await ctx.route('**/*', (route) => {
      if (local(route.request().url())) return route.continue();
      external.push('HTTP externo bloqueado'); return route.abort();
    });
    await ctx.routeWebSocket('**', (route) => {
      if (local(route.url())) route.connectToServer();
      else { external.push('WS externo bloqueado'); route.close(); }
    });
    await ctx.addInitScript(() => {
      const w = window as unknown as { yogaMicCalls: number }; w.yogaMicCalls = 0;
      if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        w.yogaMicCalls++; throw new Error('Microfone proibido no smoke.');
      } });
    });
  };
  const read = (key: ParamKey) => {
    const r = lab!.mixer.read(key); if (!r.known) throw new Error('Valor LAB desconhecido.'); return r.value;
  };
  const closeServer = async () => {
    if (!lab) return;
    const base = lab.base;
    await lab.server.close();
    expect(lab.mixer.link()).toBe('DISCONNECTED');
    expect(existsSync(join(dir, 'lab-state.json.lock'))).toBe(false);
    expect(existsSync(join(dir, 'agent-lab.token'))).toBe(false);
    await expect(nativeFetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    lab = undefined;
  };
  try {
    lab = await startLab({ dir, mode: 'lab' });
    expect(lab.loaded.config.mixer.mode).toBe('lab');
    expect(lab.server.urls).toHaveLength(1);
    expect(local(lab.base)).toBe(true);
    expect(lab.server.port).toBeGreaterThan(0);
    expect(lab.loaded.config.ai.enabled).toBe(false);
    expect(lab.loaded.config.server.httpsLab.enabled).toBe(false);
    expect((await lab.http('/api/state')).status).toBe(401);
    browser = await launch();
    const op = await lab.login(OPERATOR_PIN), mus = await lab.login(MUSICIAN_PIN, lab.controller.names.inputs.configured());
    const ws = await wsClient(lab.base, op); sockets.push(ws);
    expect((await ws.next((m) => m.type === 'hello')).mode).toBe('lab');
    await ws.next((m) => m.type === 'snapshot');
    const musicianWs = await wsClient(lab.base, mus); sockets.push(musicianWs);
    await musicianWs.next((m) => m.type === 'snapshot');
    const { page } = await enter(browser, lab.base, OPERATOR_PIN, undefined, prepare);
    const { page: phone } = await enter(browser, lab.base, MUSICIAN_PIN, PHONE, prepare);
    expect(await page.getByTestId('mode').textContent()).toBe('LABORATÓRIO');
    expect(await phone.locator('mx-mesa').count()).toBe(0);

    // PA no Yoga e FONES no celular usam o servidor único e chegam via WS.
    await page.locator('.strips mx-fader svg').first().focus(); await page.keyboard.press('ArrowDown');
    await expect.poll(() => read('ch.1.main.level')).toBe(-11);
    const mute = page.locator('.strips mx-strip').first().getByRole('button', { name: 'MUTE', exact: true });
    await mute.click(); await expect.poll(() => read('ch.1.main.mute')).toBe(true);
    await mute.click(); await expect.poll(() => read('ch.1.main.mute')).toBe(false);
    await page.getByRole('tab', { name: 'FONES', exact: true }).click();
    await phone.getByRole('button', { name: 'Aumentar Voz 1 no fone' }).click();
    await expect.poll(() => read('ch.1.aux.1.level')).toBe(-18);
    await expect.poll(() => page.locator('.strips .strip-value').first().textContent()).toContain('−18.0 dB');
    await expect.poll(() => ws.sync.state?.params['ch.1.aux.1.level']?.value).toEqual({ status: 'known', value: -18 });
    await mute.click(); await expect.poll(() => read('ch.1.aux.1.mute')).toBe(true);
    await mute.click(); await expect.poll(() => read('ch.1.aux.1.mute')).toBe(false);
    await page.getByRole('tab', { name: 'PA', exact: true }).click();

    await page.getByRole('button', { name: 'EQ LAB', exact: true }).click();
    await page.getByText('SIMULADO — somente laboratório. Curva estimada, não medida na Ui16 real.').waitFor();
    const gain = page.getByRole('spinbutton', { name: 'Banda 1 ganho', exact: true });
    await gain.fill('3'); await gain.press('Tab');
    await expect.poll(() => read('ch.1.eq.b1.gain')).toBe(3);
    expect(await page.locator('mx-eq svg').count()).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Fechar EQ' }).click();

    // Consulta B3A é leitura e não cria proposta, pendência ou write.
    const before = lab.controller.state.snapshot(); const writes = vi.spyOn(lab.mixer, 'write');
    await page.getByPlaceholder('O que você deseja ajustar?').fill('Meu cavaco está estridente no PA');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect.poll(() => page.locator('.technical-text').last().textContent()).toContain('A fonte soa assim também sozinha ou só com a banda?');
    expect(await page.locator('.technical-references a').count()).toBeGreaterThan(0);
    expect(await page.locator('.proposal').count()).toBe(0);
    expect(lab.controller.state.snapshot()).toEqual(before); expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();

    const fixture = labRealFixture();
    expect(compareLabReal(fixture).totals.different).toBe(3);
    expect(JSON.parse(exportLabRealComparison(fixture)).applicable).toBe(false);
    expect(exportLabRealComparison(fixture, 'markdown')).toContain('−∞');

    // Cenas E5: somente LAB; o pedido fica parado até a aprovação humana na tela.
    const saved = (await lab.command(op, { type: 'scene_save', name: 'Ensaio Yoga descartável' })).json.result.data.scene;
    await lab.command(op, { type: 'set_level', channel: 1, db: -14 });
    await page.getByRole('button', { name: 'Cenas', exact: true }).click();
    await page.locator('.scene-item', { hasText: 'Ensaio Yoga descartável' }).waitFor();
    await page.getByRole('button', { name: 'Comparar', exact: true }).click();
    await expect.poll(() => page.getByTestId('compare-total').textContent()).toContain('1 alteração(ões) a aplicar');
    await page.getByRole('button', { name: 'Carregar…' }).click();
    await page.getByRole('button', { name: 'Pedir carregamento' }).click();
    const card = page.getByTestId('scene-load-card'); await card.waitFor();
    expect(read('ch.1.main.level')).toBe(-14);
    const pending = (await lab.http('/api/pending', { token: op })).json.items[0].pendingId as string;
    expect((await lab.http(`/api/pending/${pending}/approve`, { token: mus, body: { requestId: 'mus-approve' } })).json.result.code).toBe('FORBIDDEN');
    const agent = readFileSync(join(dir, 'agent-lab.token'), 'utf8'); // só token efêmero deste teste
    expect((await lab.http(`/api/pending/${pending}/approve`, { token: agent, body: { requestId: 'agent-approve' } })).json.result.code).toBe('FORBIDDEN');
    await card.getByRole('button', { name: 'Aprovar' }).click();
    await expect.poll(() => read('ch.1.main.level')).toBe(-11);
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.getByRole('button', { name: 'Desfazer', exact: true }).click();
    await expect.poll(() => read('ch.1.main.level')).toBe(-14);

    const unchanged = lab.controller.state.snapshot();
    expect((await lab.command(mus, { type: 'set_master', db: 0 })).json.result.code).toBe('FORBIDDEN');
    expect((await musicianWs.request({ type: 'command', command: { type: 'set_level', channel: 1, db: 0 } })).result.code).toBe('FORBIDDEN');
    expect((await lab.command(mus, { type: 'set_lab_eq', channel: 1, values: { 'ch.1.eq.b1.gain': 9 } })).json.result.code).toBe('FORBIDDEN');
    expect((await lab.http('/api/assistant/diagnose', { token: mus, body: { text: 'Meu cavaco está estridente no PA' } })).status).toBe(403);
    expect((await lab.command(op, { type: 'status' }, { targetMode: 'real' })).json.result.code).toBe('MODE_MISMATCH'); // só recusa de envelope, sem ação REAL
    expect(lab.controller.state.snapshot()).toEqual(unchanged);

    for (const p of [page, phone]) {
      expect(await p.getByRole('complementary', { name: 'Experimento de voz LAB' }).count()).toBe(0);
      expect(await p.evaluate(() => (window as unknown as {yogaMicCalls: number}).yogaMicCalls)).toBe(0);
    }
    const uiToken = await page.evaluate(() => sessionStorage.getItem('mixai.token'));
    const logout = page.waitForResponse((r) => r.url() === `${lab!.base}/api/logout` && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await logout;
    expect((await lab.http('/api/state', { token: uiToken! })).status).toBe(401);
    await lab.http('/api/logout', { token: mus, body: {} });
    expect((await musicianWs.closed).code).toBe(4401);
    expect((await lab.command(mus, { type: 'set_level', channel: 1, aux: 1, db: -1 })).status).toBe(401);
    expect(external).toEqual([]);

    for (const ctx of browser.contexts()) await ctx.close();
    for (const s of sockets.splice(0)) s.close();
    await closeServer();
    lab = await startLab({ dir, mode: 'lab' }); // mesmo arquivo descartável, processo servidor novo
    expect(read('ch.1.main.level')).toBe(-14);
    expect(read('ch.1.aux.1.level')).toBe(-18);
    expect(read('ch.1.eq.b1.gain')).toBe(3);
    expect((await lab.http('/api/state', { token: op })).status).toBe(401);
    const newToken = await lab.login(OPERATOR_PIN);
    const scenes = (await lab.command(newToken, { type: 'scene_list' })).json.result;
    expect(JSON.stringify(scenes)).toContain('Ensaio Yoga descartável');
    await closeServer();
  } finally {
    for (const s of sockets) s.close();
    try { await browser?.close(); }
    finally {
      try { await lab?.server.close(); }
      finally {
        vi.restoreAllMocks(); vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }
  expect(existsSync(dir)).toBe(false);
});
