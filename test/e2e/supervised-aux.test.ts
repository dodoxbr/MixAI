import { join } from 'node:path';
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
import { fixtureChannels } from '../helpers.js';
import { createFakeUi, stateMessages, waitFor } from '../support/fake-ui-socket.js';
import { OPERATOR_PIN, MUSICIAN_PIN } from '../server-support.js';
import { enter, launch, startLab, YOGA } from './harness.js';

/**
 * Teste supervisionado AUX no navegador. TODO o transporte é FALSO (socket injetado): nenhum byte vai a uma Ui16.
 * O servidor REAL é composto à mão (sem startServer) para não tocar o lock compartilhado `mesa-real.lock`.
 */
let browser: Browser;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
const required: ParamKey[] = ['ch.2.main.level', 'ch.2.main.mute', 'ch.2.aux.1.level', 'ch.2.aux.1.mute', 'master.level'];

async function realServer(opts: { gate: boolean; echo?: boolean }) {
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', 'SETD^i.1.stereoIndex^-1', 'SETD^i.0.stereoIndex^-1', 'SETD^a.0.stereoIndex^-1', ...stateMessages({ channels: [1, 2], aux: [1] })] });
  const bridge = new Ui16RealBridge({
    ip: 'fixture.invalid', requiredKeys: [...required, 'ch.1.aux.1.level'], watchedKeys: [...required, 'ch.1.aux.1.level'], webSocketCtor: fake.Ctor,
    reconnectBaseMs: 5, reconnectMaxDelayMs: 10,
    ...(opts.gate ? { firstRealAux: { validation: 'simulated_transport' as const, validationReference: 'fixture-e2e', routeGuard: () => true, freshnessMs: 30_000, confirmationTimeoutMs: 1500 } } : {}),
  });
  const log = new ActionLog(null);
  const controller = new MixController(bridge, parseConfig({ safety: { maxActionsPerSecond: 100 } }).safety, new ChannelMap(fixtureChannels(), bridge.capabilities()), log);
  const auth = new Auth({ operatorPinHash: hashPin(OPERATOR_PIN), musicianPinHash: hashPin(MUSICIAN_PIN), agentToken: 'fixture-agent', sessionTtlMs: 600_000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1 });
  await bridge.connect();
  await waitFor(() => bridge.link() === 'READY', 5000);
  const socket = fake.last(), send = socket.send.bind(socket);
  socket.send = (frame: string) => { send(frame); if (opts.echo && frame.startsWith('3:::SETD')) setTimeout(() => socket.deliver(frame.slice(4)), 20); };
  const app = await buildHttp(core, { webRoot: join(PROJECT_ROOT, 'dist', 'web', 'browser') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { base, fake, bridge, close: async () => { await app.close(); await bridge.disconnect(); } };
}
const pick = async (page: import('playwright').Page) => {
  expect(await page.getByTestId('sup-plus').isDisabled()).toBe(true); // nada pré-selecionado
  await page.getByLabel('Canal do teste').selectOption('2');
  await page.getByLabel('AUX do teste').selectOption('1');
};
const open = async (base: string) => {
  const { ctx, page } = await enter(browser, base, OPERATOR_PIN, YOGA);
  await page.locator('[aria-label^="Selecionar CH"]').first().click();
  await page.getByText('Teste supervisionado — primeiro envio AUX (REAL)').click();
  return { ctx, page };
};

it('LAB: tela bloqueada, sem rota REAL e sem envio', async () => {
  const lab = await startLab();
  try {
    const { ctx, page } = await open(lab.base);
    await page.getByTestId('sup-lab').waitFor();
    expect(await page.getByTestId('sup-lab').textContent()).toContain('Bloqueado');
    expect(await page.getByTestId('sup-plus').isDisabled()).toBe(true);
    expect(await page.getByTestId('sup-minus').isDisabled()).toBe(true);
    await ctx.close();
  } finally { await lab.server.close(); }
});

it('REAL com gate fechado (padrão): bloqueado, nenhum comando chega ao transporte', async () => {
  const s = await realServer({ gate: false });
  try {
    const { ctx, page } = await open(s.base);
    await page.getByTestId('sup-disabled').waitFor();
    expect(await page.getByTestId('sup-feature').textContent()).toContain('Desabilitado');
    expect(await page.getByTestId('sup-plus').isDisabled()).toBe(true);
    expect(s.fake.last().commands()).toEqual([]);
    await ctx.close();
  } finally { await s.close(); }
});

it('REAL simulado: prévia, cancelamento (nada enviado), confirmação humana e observed_target com um único SETD', async () => {
  const s = await realServer({ gate: true, echo: true });
  try {
    const { ctx, page } = await open(s.base);
    await page.getByTestId('sup-feature').filter({ hasText: 'Habilitado' }).waitFor();
    expect(await page.getByTestId('sup-link').textContent()).toBe('READY');
    expect(await page.getByTestId('sup-model').textContent()).toBe('ui16');
    await pick(page);
    await page.getByTestId('sup-observed').filter({ hasText: '−20.0' }).waitFor();
    await page.getByTestId('sup-plus').click();
    await page.getByTestId('sup-preview').waitFor();
    expect(await page.getByTestId('sup-previous').textContent()).toContain('−20.0');
    expect(await page.getByTestId('sup-requested').textContent()).toContain('−19.5');
    await page.getByTestId('sup-cancel').click();
    await page.getByTestId('sup-preview').waitFor({ state: 'detached' });
    expect(s.fake.last().commands()).toEqual([]);
    await page.getByTestId('sup-plus').click();
    await page.getByTestId('sup-confirm').click();
    await page.getByTestId('sup-outcome').waitFor();
    expect(await page.getByTestId('sup-status').textContent()).toContain('observed_target');
    expect(await page.getByTestId('sup-result-observed').textContent()).toContain('−19.5');
    expect(await page.getByTestId('sup-outcome').textContent()).toContain('não prova que o MixAI causou');
    const sent = s.fake.last().commands();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^SETD\^i\.1\.aux\.0\.value\^/);
    await ctx.close();
  } finally { await s.close(); }
});

it('REAL simulado sem retorno da mesa: unconfirmed, sem repetição automática', async () => {
  const s = await realServer({ gate: true, echo: false });
  try {
    const { ctx, page } = await open(s.base);
    await pick(page);
    await page.getByTestId('sup-observed').filter({ hasText: '−20.0' }).waitFor();
    await page.getByTestId('sup-minus').click();
    await page.getByTestId('sup-confirm').click();
    await page.getByTestId('sup-outcome').waitFor();
    expect(await page.getByTestId('sup-status').textContent()).toContain('unconfirmed');
    expect(await page.getByTestId('sup-outcome').textContent()).toContain('Nada foi repetido');
    await page.waitForTimeout(2500);
    expect(s.fake.last().commands()).toHaveLength(1);
    await ctx.close();
  } finally { await s.close(); }
});
