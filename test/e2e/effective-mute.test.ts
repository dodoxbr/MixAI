import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Ui16RealBridge } from '../../src/mixer/ui16-real-bridge.js';
import { MixController } from '../../src/core/controller.js';
import { ChannelMap } from '../../src/core/channels.js';
import { parseChannels, parseConfig, PROJECT_ROOT } from '../../src/core/config.js';
import { ActionLog } from '../../src/core/log.js';
import type { ParamKey } from '../../src/core/revisions.js';
import { Auth } from '../../src/server/auth.js';
import { hashPin } from '../../src/server/pin.js';
import { ServerCore } from '../../src/server/core.js';
import { buildHttp } from '../../src/server/http.js';
import { createFakeUi, stateMessages, waitFor } from '../support/fake-ui-socket.js';
import { OPERATOR_PIN, MUSICIAN_PIN } from '../server-support.js';
import { enter, launch, YOGA } from './harness.js';

/**
 * MUTE efetivo no navegador. Mesa SIMULADA por socket injetado (nunca hardware): reproduz a combinação lida na Ui16 física
 * (Mute All ativo; Force Unmute em CH2/CH3) e exige zero SETD. Gera as capturas de docs/ui16/effective-mute/.
 */
let browser: Browser;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
const shots = join(PROJECT_ROOT, 'docs/ui16/effective-mute');
const DEVICES = [['desktop', { viewport: { width: 1440, height: 900 } }], ['tablet', { viewport: { width: 1024, height: 768 }, hasTouch: true, deviceScaleFactor: 1.5 }]] as const;

async function server() {
  let seed = ['SETD^mgmask^8388608', 'SETD^i.0.mute^1', 'SETD^i.1.mute^1', 'SETD^i.2.mute^0', 'SETD^i.3.mute^0', 'SETD^i.0.forceunmute^0', 'SETD^i.1.forceunmute^1', 'SETD^i.2.forceunmute^1', 'SETD^i.3.forceunmute^0'];
  const required: ParamKey[] = ['master.level', ...[1, 2, 3, 4].flatMap((n) => [`ch.${n}.main.level`, `ch.${n}.main.mute`] as ParamKey[])];
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', ...stateMessages({ channels: [1, 2, 3, 4], aux: [1] }), ...seed] });
  const bridge = new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: required, watchedKeys: required, webSocketCtor: fake.Ctor, reconnectBaseMs: 5, reconnectMaxDelayMs: 10 });
  const log = new ActionLog(null);
  const map = new ChannelMap(parseChannels({ channels: [{ number: 1, name: 'Cavaco', aliases: [] }, { number: 2, name: 'Violão', aliases: [] }, { number: 3, name: 'Fred Voz', aliases: [] }, { number: 4, name: 'Lucius Voz', aliases: [] }], aux: [{ number: 1, name: 'Fones', aliases: ['fones'] }] }), bridge.capabilities());
  const controller = new MixController(bridge, parseConfig({}).safety, map, log);
  const auth = new Auth({ operatorPinHash: hashPin(OPERATOR_PIN), musicianPinHash: hashPin(MUSICIAN_PIN), agentToken: 'fixture-agent', sessionTtlMs: 600000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1 });
  await bridge.connect(); await waitFor(() => bridge.link() === 'READY'); await new Promise((r) => setTimeout(r, 40));
  const app = await buildHttp(core, { webRoot: join(PROJECT_ROOT, 'dist', 'web', 'browser') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, fake, bridge, setSeed: (s: string[]) => { seed = s; }, close: async () => { await app.close(); await bridge.disconnect(); } };
}
const badge = (page: Page, n: number) => page.locator('.strips mx-strip').nth(n - 1).getByTestId('eff-mute');
const cause = (page: Page, n: number) => badge(page, n).getAttribute('data-cause');

for (const [label, device] of DEVICES) {
  it(`${label}: Mute All, Force Unmute e MUTE individual aparecem separados; precedência pendente não é afirmada; zero SETD`, async () => {
    const s = await server();
    const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, device);
    try {
      await badge(page, 1).waitFor();
      const banner = page.getByTestId('mute-all-banner');
      expect(await banner.getAttribute('data-kind')).toBe('active');
      expect(await banner.textContent()).toContain('MUTE ALL ATIVO');
      expect([await cause(page, 1), await cause(page, 2), await cause(page, 3), await cause(page, 4)]).toEqual(['individual_and_mute_all', 'force_unmute_precedence_pending', 'force_unmute_precedence_pending', 'mute_all']);
      expect(await badge(page, 4).textContent()).toContain('Mute All'); // silenciado pelo grupo, MUTE individual aberto
      expect(await badge(page, 2).getAttribute('data-tone')).toBe('unknown'); // não afirma aberto nem mudo
      // o botão MUTE continua sendo o individual (CH1 mudo, CH4 aberto)
      const mute = (n: number) => page.locator('.strips mx-strip').nth(n - 1).locator('.mute').getAttribute('aria-pressed');
      expect([await mute(1), await mute(3), await mute(4)]).toEqual(['true', 'false', 'false']);
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: join(shots, `${label}-mute-all.png`) });
      // Mute All desligado na mesa: o CH4 passa a aberto com evidência; CH1 segue mudo individual; CH2 continua sem regra validada
      s.fake.last().deliver('SETD^mgmask^0');
      await expect.poll(() => cause(page, 4), { timeout: 6000 }).toBe('none');
      expect(await badge(page, 4).textContent()).toContain('ABERTO');
      expect(await cause(page, 1)).toBe('individual');
      expect(await cause(page, 2)).toBe('force_unmute_precedence_pending');
      expect(await page.getByTestId('mute-all-banner').count()).toBe(0);
      await page.screenshot({ path: join(shots, `${label}-sem-mute-all.png`) });
      expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
    } finally { await ctx.close(); await s.close(); }
  });
}

it('perda de conexão: o selo e o aviso somem (nada de "aberto" por padrão); a reconexão sem republicar o grupo mantém desconhecido', async () => {
  const s = await server();
  const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, YOGA);
  try {
    await badge(page, 4).waitFor();
    s.setSeed([]); // a mesa volta sem republicar mgmask nem Force Unmute
    await s.bridge.disconnect();
    await expect.poll(() => page.locator('.strips [data-testid=eff-mute]:not([data-tone="unknown"])').count(), { timeout: 8000 }).toBe(0);
    await s.bridge.connect(); await waitFor(() => s.bridge.link() === 'READY'); await new Promise((r) => setTimeout(r, 2600));
    const texts = await page.locator('.strips [data-testid=eff-mute]').allTextContents();
    for (const t of texts) expect(t).not.toContain('ABERTO');
    const kind = await page.getByTestId('mute-all-banner').getAttribute('data-kind').catch(() => null);
    expect(kind === null || kind === 'unknown').toBe(true);
    expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
  } finally { await ctx.close(); await s.close(); }
});
