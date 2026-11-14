import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { join } from 'node:path';
import { DBToFaderValue } from 'soundcraft-ui-connection';
import { Ui16RealBridge } from '../../src/mixer/ui16-real-bridge.js';
import { ChannelMap } from '../../src/core/channels.js';
import { keysFor } from '../../src/core/app.js';
import { parseConfig, PROJECT_ROOT } from '../../src/core/config.js';
import { MixController } from '../../src/core/controller.js';
import { ActionLog } from '../../src/core/log.js';
import { ServerCore } from '../../src/server/core.js';
import { Auth } from '../../src/server/auth.js';
import { hashPin } from '../../src/server/pin.js';
import { buildHttp } from '../../src/server/http.js';
import { createFakeUi, stateMessages } from '../support/fake-ui-socket.js';
import {
  enter,
  launch,
  physicalBandChannels,
  OPERATOR_PIN,
  YOGA,
  PHONE,
} from './harness.js';
let browser: Browser;
beforeAll(async () => (browser = await launch()));
afterAll(async () => browser.close());
async function setup() {
  const names = new ChannelMap(
      physicalBandChannels(),
      { inputs: 12, aux: 6 },
      { allowUnmapped: false },
    ),
    keys = keysFor(names);
  const fake = createFakeUi({
    initialState: () => [
      ...stateMessages({ channels: names.inputs.configured(), aux: [1] }),
      `SETD^i.0.aux.1.value^${DBToFaderValue(-12)}`,
      'SETD^i.0.aux.1.mute^1',
    ],
  });
  const mixer = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: keys.required,
    watchedKeys: keys.watched,
    webSocketCtor: fake.Ctor,
  });
  const log = new ActionLog(null),
    controller = new MixController(mixer, parseConfig({}).safety, names, log);
  const auth = new Auth({
      operatorPinHash: hashPin(OPERATOR_PIN),
      agentToken: 'fixture-agent',
    }),
    core = new ServerCore(controller, mixer, 'real', auth, log, {
      musicianAux: 1,
    });
  const app = await buildHttp(core, {
    webRoot: join(PROJECT_ROOT, 'dist/web/browser'),
  });
  await mixer.connect();
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    base,
    mixer,
    fake,
    close: async () => {
      await app.close();
      await mixer.disconnect();
    },
  };
}
for (const [label, device] of [
  ['Yoga', YOGA],
  ['tablet', { viewport: { width: 820, height: 1180 }, hasTouch: true }],
  ['celular', PHONE],
] as const)
  it(
    'AUX SENDS: six independent observed buses, unknown states, no writes — ' +
      label,
    async () => {
      const s = await setup();
      const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, device);
      try {
        const strip = page.locator('.strips mx-strip').first();
        const pa = await strip.locator('.strip-value').textContent();
        await page.getByRole('tab', { name: 'AUX SENDS', exact: true }).click();
        await page
          .getByRole('navigation', { name: 'Barramentos AUX' })
          .waitFor();
        expect(await page.locator('.aux-selector button').count()).toBe(6);
        expect(await page.locator('.shared-warning').textContent()).toContain(
          'HA800',
        );
        await page.getByRole('button', { name: 'AUX 2', exact: true }).click();
        await expect
          .poll(() => strip.locator('.strip-value').textContent())
          .toContain('−12.0');
        expect(
          await strip
            .getByRole('button', { name: 'MUTE', exact: true })
            .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(
          await page.locator('.shared-warning').textContent(),
        ).not.toContain('HA800');
        s.fake
          .last()
          .deliver(
            `SETD^i.0.aux.1.value^${DBToFaderValue(-18.5)}`,
            'SETD^i.0.aux.1.mute^0',
          );
        await expect
          .poll(() => strip.locator('.strip-value').textContent())
          .toContain('−18.5');
        await expect
          .poll(() =>
            strip
              .getByRole('button', { name: 'MUTE', exact: true })
              .getAttribute('aria-pressed'),
          )
          .toBe('false');
        await page.getByRole('button', { name: 'AUX 6', exact: true }).click();
        await expect
          .poll(() => strip.locator('.strip-value').textContent())
          .toContain('Desconhecido');
        expect(
          await strip.locator('.mute').getAttribute('aria-pressed'),
        ).toBeNull();
        expect(await strip.locator('.mute').isDisabled()).toBe(true);expect(await strip.locator('mx-fader .thumb').count()).toBe(0);
        expect(
          await page
            .getByRole('region', { name: 'Master do AUX selecionado' })
            .count(),
        ).toBe(1); // labelled read-only section, not an invented master control
        expect(await page.locator('.aux-master').textContent()).toContain(
          'MASTER AUX 6',
        );
        expect(
          await page.locator('.aux-reading').allTextContents(),
        ).toContainEqual(expect.stringContaining('PRE/POST: indisponível'));
        await page.getByRole('tab', { name: 'PA', exact: true }).click();
        await expect
          .poll(() => strip.locator('.strip-value').textContent())
          .toBe(pa);
        expect(await page.locator('.master-area mx-strip').count()).toBe(1);
        await page.getByRole('tab', { name: 'AUX SENDS', exact: true }).click();
        expect(
          await page
            .getByRole('button', { name: 'AUX 6', exact: true })
            .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(await page.locator('.strips mx-strip').count()).toBe(11);
        const bounds = await strip.locator('.mute').boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
      } finally {
        await ctx.close();
        await s.close();
      }
    },
  );
