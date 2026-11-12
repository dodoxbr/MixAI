import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Ui16RealBridge } from '../../src/mixer/ui16-real-bridge.js';
import type { Ui16ControlGates } from '../../src/mixer/ui16-controls.js';
import { processingFrame } from '../../src/mixer/ui16-processing.js';
import { MixController } from '../../src/core/controller.js';
import { ChannelMap } from '../../src/core/channels.js';
import { parseChannels, parseConfig, PROJECT_ROOT } from '../../src/core/config.js';
import { ActionLog } from '../../src/core/log.js';
import type { ParamKey } from '../../src/core/revisions.js';
import { Auth } from '../../src/server/auth.js';
import { hashPin } from '../../src/server/pin.js';
import { ServerCore } from '../../src/server/core.js';
import { buildHttp } from '../../src/server/http.js';
import { AssistantService } from '../../src/assistant/service.js';
import { realAssistantPreview } from '../../src/server/real-assistant.js';
import { createFakeUi, stateMessages, waitFor } from '../support/fake-ui-socket.js';
import { OPERATOR_PIN, MUSICIAN_PIN } from '../server-support.js';
import { enter, launch, startLab, YOGA } from './harness.js';

/**
 * Assistente conversacional sobre os controles REAL, no navegador. TODO o transporte é FALSO (socket injetado, biblioteca Ui16 verdadeira):
 * nenhum byte vai a uma mesa. O servidor REAL é composto à mão (sem startServer) para não tocar o lock compartilhado `mesa-real.lock`.
 */
let browser: Browser;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
const required: ParamKey[] = ['master.level', 'ch.1.main.level', 'ch.1.main.mute', 'ch.2.main.level', 'ch.2.main.mute', 'ch.1.aux.1.level', 'ch.1.aux.1.mute', 'ch.2.aux.1.level', 'ch.2.aux.1.mute'];

async function realServer(opts: { controls?: boolean; processing?: boolean; eq?: boolean; echo?: boolean } = {}) {
  const { controls = true, processing = true, eq = true, echo = true } = opts;
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', 'SETD^i.0.stereoIndex^-1', 'SETD^i.1.stereoIndex^-1', 'SETD^a.0.stereoIndex^-1', ...stateMessages({ channels: [1, 2], aux: [1] }),
    ...(eq ? [processingFrame('ch.2.eq.b2.gain', 0).slice(4), processingFrame('ch.2.eq.b2.freq', 800).slice(4), processingFrame('ch.2.eq.hpf.freq', 80).slice(4), 'SETD^i.1.eq.bypass^0'] : [])] });
  const gate = (name: string) => ({ validation: 'simulated_transport' as const, validationReference: 'fixture-e2e-' + name, routeGuard: () => true, freshnessMs: 30_000, confirmationTimeoutMs: 800 });
  const realControls: Ui16ControlGates = controls ? { pa_level: gate('pa_level'), pa_mute: gate('pa_mute'), aux_level: gate('aux_level'), aux_mute: gate('aux_mute') } : {};
  const bridge = new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: required, watchedKeys: required, webSocketCtor: fake.Ctor, reconnectBaseMs: 5, reconnectMaxDelayMs: 10, realControls, ...(processing ? { processingGate: gate('processing') } : {}) });
  const log = new ActionLog(null), config = parseConfig({ safety: { maxActionsPerSecond: 100 } });
  const map = new ChannelMap(parseChannels({ channels: [{ number: 1, name: 'Cavaco', aliases: ['cavaco'] }, { number: 2, name: 'Violão', aliases: ['violao'] }], aux: [{ number: 1, name: 'Fones', aliases: ['fones', 'retorno'] }] }), bridge.capabilities());
  const controller = new MixController(bridge, config.safety, map, log);
  const auth = new Auth({ operatorPinHash: hashPin(OPERATOR_PIN), musicianPinHash: hashPin(MUSICIAN_PIN), agentToken: 'fixture-agent', sessionTtlMs: 600_000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1 });
  core.assistant = new AssistantService(core, { realPreview: realAssistantPreview(core), steps: config.assistant, channels: map.inputs.list().map(c => ({ ...c, aliases: [] })), ttlMs: 15000, log });
  await bridge.connect();
  await waitFor(() => bridge.link() === 'READY', 5000);
  await new Promise(r => setTimeout(r, 40));
  const socket = fake.last(), send = socket.send.bind(socket); let answering = echo;
  socket.send = (frame: string) => { send(frame); if (answering && frame.startsWith('3:::SETD')) setTimeout(() => socket.deliver(frame.slice(4)), 20); };
  const app = await buildHttp(core, { webRoot: join(PROJECT_ROOT, 'dist', 'web', 'browser') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { base, fake, bridge, core, frames: () => fake.last().commands(), echo: (v: boolean) => { answering = v; }, close: async () => { core.assistant?.stop(); await app.close(); await bridge.disconnect(); } };
}
const say = async (page: Page, text: string) => { await page.getByPlaceholder('O que você deseja ajustar?').fill(text); await page.getByRole('button', { name: 'Enviar' }).click(); };
const card = (page: Page) => page.locator('.proposal').last();
const testid = (page: Page, id: string) => card(page).getByTestId(id);

it('LAB: assistente indica LAB, EQ/HPF não são preparados e nada chega a uma mesa', async () => {
  const lab = await startLab();
  const { ctx, page } = await enter(browser, lab.base, OPERATOR_PIN, YOGA);
  try {
    await say(page, 'Coloca o HPF do violão em 100 Hz');
    await page.locator('.assist-item').last().filter({ hasText: 'somente no REAL' }).waitFor();
    expect(await page.getByTestId('assist-mode').textContent()).toContain('LAB');
    expect(await page.locator('.proposal').count()).toBe(0);
  } finally { await ctx.close(); await lab.server.close(); }
});

it('REAL simulado: volume, mute, EQ e HPF por conversa, com cancelamento, confirmação, observação e desfazer', async () => {
  const s = await realServer();
  const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, YOGA);
  try {
    // 1. volume no PA: cartão com anterior/proposto/observado; cancelar não envia nada
    await say(page, 'Sobe 0,5 dB do violão no PA');
    await testid(page, 'card-confirm').waitFor();
    expect(await page.getByTestId('assist-mode').textContent()).toContain('REAL');
    expect(await testid(page, 'card-mode').textContent()).toContain('volume no PA');
    expect(await testid(page, 'card-current').textContent()).toContain('−10.0');
    expect(await testid(page, 'card-observed').textContent()).toContain('−10.0');
    expect(await testid(page, 'card-result').textContent()).toContain('−9.5');
    expect(s.frames()).toEqual([]);
    await testid(page, 'card-cancel').click();
    await testid(page, 'card-state').filter({ hasText: 'Cancelado' }).waitFor();
    expect(s.frames()).toEqual([]);
    // 2. o mesmo pedido, agora confirmado: um frame, observação recebida, sem causalidade
    await say(page, 'Sobe 0,5 dB do violão no PA');
    await testid(page, 'card-confirm').waitFor();
    await testid(page, 'card-confirm').click();
    await testid(page, 'card-state').filter({ hasText: 'observação recebida' }).waitFor();
    expect(s.frames()).toHaveLength(1); expect(s.frames()[0]).toMatch(/^SETD\^i\.1\.mix\^/);
    expect(await page.locator('.assist-item').last().textContent()).toContain('não prova que o MixAI causou');
    // 3. mute no AUX
    await say(page, 'Muta o violão nos fones');
    await testid(page, 'card-confirm').waitFor(); await testid(page, 'card-confirm').click();
    await testid(page, 'card-state').filter({ hasText: 'observação recebida' }).waitFor();
    expect(s.frames()).toHaveLength(2); expect(s.frames()[1]).toBe('SETD^i.1.aux.0.mute^1');
    // 4. EQ: ganho da banda 2, cartão do canal de entrada
    await say(page, 'Aumenta 1 dB do ganho da banda 2 do violão');
    await testid(page, 'card-confirm').waitFor();
    expect(await card(page).textContent()).toContain('Canal de entrada (sem destino PA/AUX)');
    expect(await testid(page, 'card-mode').textContent()).toContain('EQ/HPF');
    expect(await testid(page, 'card-result').textContent()).toContain('+1.0 dB');
    await testid(page, 'card-confirm').click();
    await testid(page, 'card-state').filter({ hasText: 'observação recebida' }).waitFor();
    expect(s.frames()).toHaveLength(3);
    // 5. desfazer supervisionado do EQ: botão pede NOVA proposta; só a confirmação envia
    await testid(page, 'card-undo').click();
    await page.locator('.proposal').filter({ hasText: 'Desfazer' }).last().waitFor();
    expect(s.frames()).toHaveLength(3);
    expect(await card(page).textContent()).toContain('0.0 dB');
    await testid(page, 'card-confirm').click();
    await testid(page, 'card-state').filter({ hasText: 'observação recebida' }).waitFor();
    expect(s.frames()).toHaveLength(4);
    // 6. HPF e bypass
    await say(page, 'Coloca o HPF do violão em 100 Hz');
    await testid(page, 'card-confirm').waitFor();
    expect(await testid(page, 'card-current').textContent()).toContain('80 Hz'); expect(await testid(page, 'card-result').textContent()).toContain('100 Hz');
    await testid(page, 'card-confirm').click();
    await testid(page, 'card-state').filter({ hasText: 'observação recebida' }).waitFor();
    await say(page, 'Ativa o bypass do EQ do violão');
    await testid(page, 'card-confirm').waitFor(); await testid(page, 'card-confirm').click();
    await testid(page, 'card-state').filter({ hasText: 'observação recebida' }).waitFor();
    expect(s.frames()).toHaveLength(6);
    // 7. master: consulta permitida; alteração recusada sem cartão
    const cards = await page.locator('.proposal').count();
    await say(page, 'Quanto está o master?');
    await page.locator('.assist-item').last().filter({ hasText: 'Master' }).waitFor();
    await say(page, 'Sobe o master 1 dB');
    await page.locator('.assist-item').last().filter({ hasText: 'Nada' }).waitFor().catch(() => undefined);
    expect(await page.locator('.proposal').count()).toBe(cards);
    expect(s.frames()).toHaveLength(6);
  } finally { await ctx.close(); await s.close(); }
});

it('REAL: gate fechado, ausência de leitura e EQ com destino não geram cartão nem frame', async () => {
  const s = await realServer({ controls: false, processing: false, eq: false });
  const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, YOGA);
  try {
    await say(page, 'Muta o violão no PA');
    await page.getByTestId('real-blocked').first().waitFor();
    await say(page, 'Aumenta 1 dB do ganho da banda 2 do violão');
    await page.locator('.assist-item').last().filter({ hasText: 'Recurso REAL bloqueado' }).waitFor();
    await say(page, 'Muda o ganho da banda 2 do violão no PA para 1 dB');
    await page.locator('.assist-item').last().filter({ hasText: 'processamento do canal de entrada' }).waitFor();
    expect(await page.locator('.proposal').count()).toBe(0); expect(s.frames()).toEqual([]);
  } finally { await ctx.close(); await s.close(); }
});

it('REAL: ausência de leitura do EQ (gate aberto) é recusada sem cartão', async () => {
  const s = await realServer({ eq: false });
  const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, YOGA);
  try {
    await say(page, 'Aumenta 1 dB do ganho da banda 2 do violão');
    await page.locator('.assist-item').last().filter({ hasText: /Leitura independente|não calculo/ }).waitFor();
    expect(await page.locator('.proposal').count()).toBe(0); expect(s.frames()).toEqual([]);
  } finally { await ctx.close(); await s.close(); }
});

it('REAL: sem retorno da mesa o resultado é incerto, sem retry, e a conexão perdida bloqueia novos pedidos', async () => {
  const s = await realServer({ echo: false });
  const { ctx, page } = await enter(browser, s.base, OPERATOR_PIN, YOGA);
  try {
    await say(page, 'Sobe 0,5 dB do violão no PA');
    await testid(page, 'card-confirm').waitFor(); await testid(page, 'card-confirm').click();
    await testid(page, 'card-state').filter({ hasText: 'NÃO confirmado' }).waitFor();
    expect(await page.locator('.assist-item').last().textContent()).toContain('Nada foi repetido');
    await page.waitForTimeout(2000); expect(s.frames()).toHaveLength(1);
    expect(await page.getByTestId('card-undo').count()).toBe(0);
    await s.bridge.disconnect(); // conexão perdida: sem leitura independente, nenhuma prévia pode ser calculada
    await say(page, 'Muta o cavaco no PA');
    await page.locator('.assist-item').last().filter({ hasText: /bloqueado|REAL|indispon|conex/i }).waitFor();
    expect(await page.locator('.proposal').filter({ hasText: 'mutar' }).count()).toBe(0);
    expect(s.frames()).toHaveLength(1);
  } finally { await ctx.close(); await s.close(); }
});
