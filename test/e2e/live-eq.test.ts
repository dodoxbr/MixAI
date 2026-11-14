import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { processingFrame } from '../../src/mixer/ui16-processing.js';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
import { enter, launch, physicalBandChannels, YOGA } from './harness.js';

/** REAL server mode with an injected in-memory socket only. Never connects to hardware. */
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});
async function server() {
  let samples = true;
  const required: ParamKey[] = ['ch.3.main.level', 'ch.3.main.mute', 'master.level'];
  const frames: string[] = [];
  for (const b of [1, 2, 3, 4] as const)
    for (const f of ['freq', 'gain', 'q'] as const) {
      const v = f === 'freq' ? (b === 4 ? 6640 : 1000) : f === 'gain' ? (b === 4 ? -1 : 0) : 1;
      frames.push(processingFrame(`ch.3.eq.b${b}.${f}`, v).slice(4));
    }
  frames.push(
    processingFrame('ch.3.eq.hpf.freq', 98).slice(4),
    processingFrame('ch.3.eq.bypass', false).slice(4),
  );
  const fake = createFakeUi({
    initialState: () => [
      'SETS^model^ui16',
      ...stateMessages({ channels: [1, 2, 3], aux: [1] }),
      ...(samples ? frames : []),
    ],
  });
  const bridge = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: required,
    watchedKeys: [...required, 'ch.2.main.level'],
    webSocketCtor: fake.Ctor,
    reconnectBaseMs: 5,
    reconnectMaxDelayMs: 10,
  });
  const log = new ActionLog(null);
  const controller = new MixController(
    bridge,
    parseConfig({}).safety,
    new ChannelMap(physicalBandChannels(), bridge.capabilities()),
    log,
  );
  const auth = new Auth({
    operatorPinHash: hashPin(OPERATOR_PIN),
    musicianPinHash: hashPin(MUSICIAN_PIN),
    agentToken: 'fixture-agent',
    sessionTtlMs: 600000,
  });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1 });
  await bridge.connect();
  await waitFor(() => bridge.link() === 'READY');
  const app = await buildHttp(core, { webRoot: join(PROJECT_ROOT, 'dist', 'web', 'browser') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
    fake,
    bridge,
    withoutSamples: () => {
      samples = false;
    },
    close: async () => {
      await app.close();
      await bridge.disconnect();
    },
  };
}
for (const [label, device] of [
  ['desktop', { viewport: { width: 1440, height: 1000 } }],
  ['tablet', YOGA],
] as const) {
  it(`${label}: live independent EQ/HPF, external changes, last observation, channel switching, reconnect; zero SETD`, async () => {
    const s = await server();
    try {
      const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, device);
      await page.getByRole('button', { name: 'Selecionar CH3 — Voz Fred', exact: true }).click();
      await page.getByRole('button', { name: 'Abrir EQ/HPF REAL' }).click();
      const panel = page.getByRole('dialog', { name: 'EQ e HPF REAL — somente leitura' });
      await panel.getByText('6.640 Hz', { exact: true }).waitFor();
      expect(await panel.locator('[data-band]').count()).toBe(4);
      expect(await panel.locator('svg path').count()).toBe(1);
      expect(await panel.locator('input').count()).toBe(0);
      expect(await panel.locator('select').count()).toBe(1);
      expect(await panel.getByLabel('Canal do EQ REAL').inputValue()).toBe('3');
      await mkdir(join(PROJECT_ROOT, 'docs/ui16/live-eq'), { recursive: true });
      await page.screenshot({ path: join(PROJECT_ROOT, `docs/ui16/live-eq/${label}.png`) });
      s.fake.last().deliver(processingFrame('ch.3.eq.b4.gain', -2).slice(4));
      await expect
        .poll(() => panel.locator('[data-band="4"]').textContent(), { timeout: 6000 })
        .toContain('-2,0 dB');
      await expect
        .poll(() => panel.locator('[data-band="4"]').textContent(), { timeout: 8000 })
        .toContain('Última observação');
      expect(await panel.locator('svg path').count()).toBe(1);
      await panel.getByLabel('Canal do EQ REAL').selectOption('2');
      await expect.poll(() => panel.textContent(), { timeout: 6000 }).not.toContain('6.640 Hz');
      await expect.poll(() => panel.locator('svg').count(), { timeout: 6000 }).toBe(0);
      s.fake.last().deliver(processingFrame('ch.2.eq.b4.freq', 6640).slice(4));
      await panel.getByText('6.640 Hz', { exact: true }).waitFor();
      expect(await panel.locator('svg').count()).toBe(0); // partial evidence
      await panel.getByLabel('Canal do EQ REAL').selectOption('3');
      await expect.poll(() => panel.locator('svg').count(), { timeout: 6000 }).toBe(1);
      await s.bridge.disconnect();
      await expect.poll(() => panel.textContent(), { timeout: 6000 }).toContain('Desatualizado');
      expect(await panel.locator('svg').count()).toBe(0);
      s.withoutSamples();
      await s.bridge.connect();
      await waitFor(() => s.bridge.link() === 'READY');
      await expect.poll(() => panel.textContent(), { timeout: 6000 }).toContain('Desatualizado');
      expect(await panel.locator('svg').count()).toBe(0);
      s.fake
        .last()
        .deliver(
          ...['ch.3.eq.b4.freq', 'ch.3.eq.b4.gain', 'ch.3.eq.b4.q'].map((key, i) =>
            processingFrame(key as ParamKey, [6640, -1, 1][i]!).slice(4),
          ),
        );
      await expect
        .poll(() => panel.locator('[data-band="4"]').textContent(), { timeout: 6000 })
        .toContain('Confirmado');
      expect(await panel.locator('svg').count()).toBe(0); // other bands belong to prior connection
      expect(s.fake.sockets.flatMap((socket) => socket.commands())).toEqual([]);
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      expect(
        await page
          .getByRole('button', { name: 'Abrir EQ/HPF REAL' })
          .evaluate((e) => e === document.activeElement),
      ).toBe(true);
      await ctx.close();
    } finally {
      await s.close();
    }
  });
}
