import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParamKey } from '../src/core/revisions.js';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import type { Ui16ControlGates } from '../src/mixer/ui16-controls.js';
import { processingFrame } from '../src/mixer/ui16-processing.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import { Auth } from '../src/server/auth.js';
import { hashPin } from '../src/server/pin.js';
import { ServerCore } from '../src/server/core.js';
import { buildHttp } from '../src/server/http.js';
import { AssistantService } from '../src/assistant/service.js';
import { parseProcessingRequest, isProcessingCommand } from '../src/assistant/mixer-operator/processing-parser.js';
import { realAssistantPreview } from '../src/server/real-assistant.js';
import { createFakeUi, stateMessages, waitFor } from './support/fake-ui-socket.js';

/** Nenhum socket real: biblioteca verdadeira da Ui16 + WebSocket falso. Conversa → prévia → confirmação humana → um frame. */
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const CATEGORIES = ['pa_level', 'pa_mute', 'aux_level', 'aux_mute'] as const;
const names = (caps: ConstructorParameters<typeof ChannelMap>[1]) => new ChannelMap(parseChannels({ channels: [{ number: 1, name: 'Cavaco', aliases: ['cavaco'] }, { number: 2, name: 'Violão', aliases: ['violao'] }, { number: 3, name: 'Voz Fred', aliases: ['fred'] }],
  aux: [{ number: 1, name: 'Fones', aliases: ['fones', 'retorno'] }, { number: 5, name: 'Retorno 5', aliases: [] }] }), caps);
const required: ParamKey[] = ['master.level', 'ch.1.main.level', 'ch.1.main.mute', 'ch.2.main.level', 'ch.2.main.mute', 'ch.1.aux.5.level', 'ch.1.aux.5.mute', 'ch.2.aux.1.level', 'ch.2.aux.1.mute'];

async function setup(opts: { controls?: readonly (typeof CATEGORIES[number])[]; processing?: boolean; noEq?: boolean; route?: { ok: boolean } } = {}) {
  let wall = 1_000_000; const route = opts.route ?? { ok: true };
  const eq = opts.noEq ? [] : [processingFrame('ch.2.eq.b2.gain', 0).slice(4), processingFrame('ch.2.eq.b2.freq', 800).slice(4), processingFrame('ch.2.eq.b2.q', 1).slice(4), processingFrame('ch.2.eq.hpf.freq', 80).slice(4), 'SETD^i.1.eq.bypass^0'];
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', 'SETD^i.0.stereoIndex^-1', 'SETD^i.1.stereoIndex^-1', 'SETD^i.2.stereoIndex^-1', 'SETD^a.0.stereoIndex^-1', 'SETD^a.4.stereoIndex^-1', ...stateMessages({ channels: [1, 2, 3], aux: [1, 5] }), ...eq] });
  const gate = (c: string) => ({ validation: 'simulated_transport' as const, validationReference: 'fixture-assistant-' + c, routeGuard: () => route.ok, freshnessMs: 2000, confirmationTimeoutMs: 400 });
  const controls: Ui16ControlGates = {}; for (const c of opts.controls ?? CATEGORIES) controls[c] = gate(c);
  const bridge = new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: required, watchedKeys: required, webSocketCtor: fake.Ctor, realControls: controls, reconnectBaseMs: 5, reconnectMaxDelayMs: 10, ...(opts.processing === false ? {} : { processingGate: gate('processing') }) });
  close.push(() => bridge.disconnect());
  const config = parseConfig({ safety: { maxActionsPerSecond: 100 } }), log = new ActionLog(null), map = names(bridge.capabilities());
  const controller = new MixController(bridge, config.safety, map, log, () => wall);
  const auth = new Auth({ operatorPinHash: hashPin('4321'), musicianPinHash: hashPin('1357'), agentToken: 'fixture-agent', clock: () => wall, sessionTtlMs: 100000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1, clock: () => wall });
  const op = auth.login('4321', 'fixture'), mus = auth.login('1357', 'fixture'); if (!op.ok || !mus.ok) throw Error('login');
  core.assistant = new AssistantService(core, { realPreview: realAssistantPreview(core), steps: config.assistant, channels: map.inputs.list().map(c => ({ ...c, aliases: [] })), ttlMs: 15000, log });
  close.push(async () => core.assistant?.stop());
  await bridge.connect(); await waitFor(() => bridge.link() === 'READY');
  await new Promise(r => setTimeout(r, 30));
  const app = await buildHttp(core); close.push(() => app.close());
  const socket = fake.last(), send = socket.send.bind(socket); let echo = true;
  socket.send = (frame: string) => { send(frame); if (echo && frame.startsWith('3:::SETD')) setTimeout(() => socket.deliver(frame.slice(4)), 2); };
  const headers = { authorization: `Bearer ${op.token}` };
  const post = (url: string, payload: object, h = headers) => app.inject({ method: 'POST', url, headers: h, payload });
  const ask = async (text: string) => (await post('/api/assistant/ask', { text })).json().reply;
  const body = (requestId = 'ui-test') => ({ targetMode: 'real', serverId: core.serverId, requestId, humanConfirmed: true });
  return { core, bridge, fake, app, post, ask, body, headers, op: op.principal, token: op.token, musToken: mus.token, auth, setEcho: (v: boolean) => { echo = v; }, frames: () => socket.commands() };
}

describe('parser de EQ/HPF (somente intenção, nunca escrita)', () => {
  const ctx = { names: names(new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: [], watchedKeys: [] }).capabilities()), role: 'operator' as const, steps: { smallStepDB: 1, mediumStepDB: 3, largeStepDB: 6 } };
  const parse = (t: string) => parseProcessingRequest(t, ctx);
  const intent = (t: string) => { const r = parse(t); return r?.kind === 'intents' ? r.intents[0] : r; };
  it.each([
    ['Aumenta 1 dB do ganho da banda 2 do violão', { type: 'processing', channel: 2, field: 'gain', band: 2, deltaDB: 1 }],
    ['Reduz 0,5 dB o ganho da banda 2 do violão', { type: 'processing', channel: 2, field: 'gain', band: 2, deltaDB: -0.5 }],
    ['Coloca o ganho da banda 2 do violão em -1,5 dB', { type: 'processing', channel: 2, field: 'gain', band: 2, value: -1.5 }],
    ['Muda a frequência da banda 2 do violão para 900 Hz', { type: 'processing', channel: 2, field: 'freq', band: 2, value: 900 }],
    ['Muda a frequência da banda 3 do violão para 1,2 kHz', { type: 'processing', channel: 2, field: 'freq', band: 3, value: 1200 }],
    ['Ajusta o Q da banda 2 do violão para 1,5', { type: 'processing', channel: 2, field: 'q', band: 2, value: 1.5 }],
    ['Coloca o HPF do violão em 100 Hz', { type: 'processing', channel: 2, field: 'hpf', value: 100 }],
    ['Desliga o HPF do canal 2', { type: 'processing', channel: 2, field: 'hpf', value: 20 }],
    ['Ativa o bypass do EQ do violão', { type: 'processing', channel: 2, field: 'bypass', value: true }],
    ['Desativa o bypass do EQ do violão', { type: 'processing', channel: 2, field: 'bypass', value: false }],
    ['Desliga o EQ do violão', { type: 'processing', channel: 2, field: 'bypass', value: true }],
  ])('%s', (text, expected) => expect(intent(text)).toEqual(expected));
  it.each([
    ['Ajusta o EQ do violão no PA', /processamento do canal de entrada/],
    ['Muda o ganho da banda 2 do violão no AUX 5 para 1 dB', /processamento do canal de entrada/],
    ['Liga o HPF do violão', /frequência de corte/],
    ['Muda a frequência da banda 2 do violão', /frequência/],
    ['Aumenta o ganho da banda 2 do violão', /Quanto de ganho/],
    ['Muda o Q do EQ do violão para 2', /Qual banda/],
    ['Aumenta o ganho da banda 2', /Qual canal/],
    ['Muda o ganho da banda 2 do violão e do cavaco para 1 dB', /mais de um canal/],
  ])('pergunta em vez de adivinhar: %s', (text, q) => { const r = parse(text); expect(r?.kind).toBe('clarify'); expect((r as { question: string }).question).toMatch(q); });
  it('banda inexistente, canal não cadastrado e músico não geram intenção', () => {
    expect(parse('Muda o ganho da banda 5 do violão para 1 dB')?.kind).not.toBe('intents');
    expect(parse('Muda o ganho da banda 2 do canal 9 para 1 dB')).toMatchObject({ kind: 'answer' });
    expect(parseProcessingRequest('Desliga o HPF do violão', { ...ctx, role: 'musician' })).toBeUndefined();
    expect(isProcessingCommand('A voz está sem EQ no retorno')).toBe(false);
  });
});

describe('assistente → controles REAL (prévia, confirmação humana, executor único)', () => {
  it('cavaco no AUX 5: valor anterior e solicitado, aguarda confirmação, executa só depois e mostra a observação', async () => {
    const s = await setup();
    const reply = await s.ask('Aumenta 1 dB do cavaco no AUX 5');
    expect(reply.kind).toBe('proposals'); const card = reply.proposals[0];
    expect(card).toMatchObject({ channel: 'Cavaco', destination: 'FONES', current: '−20.0 dB', result: '−19.0 dB', needsApproval: true, realControl: { category: 'aux_level', targetMode: 'real', observed: -20 } });
    expect(card.title).toContain('AUX 5'); expect(s.frames()).toEqual([]);
    const r = (await s.post(card.realControl.confirmationPath, s.body())).json();
    expect(r.confirmation).toMatchObject({ status: 'observed_target', previous: -20, causalAcknowledgement: false });
    expect(s.frames()).toHaveLength(1); expect(s.frames()[0]).toMatch(/^SETD\^i\.0\.aux\.4\.value\^/);
  });
  it('volume e mute no PA e por AUX, com categorias independentes e um frame por confirmação', async () => {
    const s = await setup(); const paths: Record<string, [string, RegExp]> = {
      'Sobe 0,5 dB do violão no PA': ['pa_level', /^SETD\^i\.1\.mix\^/], 'Muta o violão no PA': ['pa_mute', /^SETD\^i\.1\.mute\^1/],
      'Muta o cavaco no AUX 5': ['aux_mute', /^SETD\^i\.0\.aux\.4\.mute\^1/], 'Abaixa 0,5 dB do violão nos fones': ['aux_level', /^SETD\^i\.1\.aux\.0\.value\^/],
    };
    let n = 0;
    for (const [text, [category, frame]] of Object.entries(paths)) {
      const card = (await s.ask(text)).proposals[0]; expect(card.realControl.category).toBe(category);
      expect(s.frames()).toHaveLength(n); const r = (await s.post(card.realControl.confirmationPath, s.body('r' + n))).json();
      expect(r.confirmation.status).toBe('observed_target'); expect(s.frames()).toHaveLength(++n); expect(s.frames()[n - 1]).toMatch(frame);
    }
  });
  it.each([
    ['Muda o ganho da banda 2 do violão para 1 dB', 'ch.2.eq.b2.gain', '0.0 dB', '+1.0 dB'],
    ['Aumenta 1 dB do ganho da banda 2 do violão', 'ch.2.eq.b2.gain', '0.0 dB', '+1.0 dB'],
    ['Muda a frequência da banda 2 do violão para 1000 Hz', 'ch.2.eq.b2.freq', '800 Hz', '1000 Hz'],
    ['Ajusta o Q da banda 2 do violão para 1,5', 'ch.2.eq.b2.q', 'Q 1', 'Q 1.5'],
    ['Coloca o HPF do violão em 100 Hz', 'ch.2.eq.hpf.freq', '80 Hz', '100 Hz'],
    ['Ativa o bypass do EQ do violão', 'ch.2.eq.bypass', 'bypass desligado', 'bypass ligado'],
  ])('EQ/HPF "%s" vira cartão do canal de entrada, confirma e envia um único frame', async (text, key, before, after) => {
    const s = await setup(); const reply = await s.ask(text); expect(reply.kind, JSON.stringify(reply)).toBe('proposals'); const card = reply.proposals[0];
    expect(card).toMatchObject({ destination: 'CANAL', channel: 'Violão', realControl: { category: 'processing', targetMode: 'real' }, parameters: [{ key }] });
    expect(card.current).toContain(before); expect(card.result).toContain(after); expect(card.reason).toContain('sem destino PA/AUX'); expect(s.frames()).toEqual([]);
    const r = (await s.post(card.realControl.confirmationPath, s.body())).json(); expect(r.confirmation.status).toBe('observed_target'); expect(s.frames()).toHaveLength(1);
  });
  it('EQ/HPF com destino PA/AUX não gera cartão: pergunta se é o canal inteiro', async () => {
    const s = await setup(); const r = await s.ask('Muda o ganho da banda 2 do violão no AUX 5 para 1 dB');
    expect(r.kind).toBe('clarify'); expect(r.question).toContain('processamento do canal de entrada'); expect(r.proposals).toBeUndefined(); expect(s.frames()).toEqual([]);
  });
  it('cancelamento: o cartão cancelado não pode mais ser confirmado e nada é enviado (volume e EQ)', async () => {
    const s = await setup();
    for (const text of ['Sobe 0,5 dB do violão no PA', 'Muda o ganho da banda 2 do violão para 1 dB']) {
      const card = (await s.ask(text)).proposals[0];
      const cancel = (await s.post(card.realControl.cancelPath, { targetMode: 'real', serverId: s.core.serverId })).json(); expect(cancel.result.ok).toBe(true);
      const late = (await s.post(card.realControl.confirmationPath, s.body('late'))).json(); expect(late.result.code).toBe('NOT_FOUND');
    }
    expect(s.frames()).toEqual([]);
  });
  it('desfazer supervisionado: nova prévia no serviço dono do topo e nova confirmação (volume e EQ)', async () => {
    const s = await setup();
    for (const text of ['Sobe 0,5 dB do violão no PA', 'Muda o ganho da banda 2 do violão para 1 dB']) {
      const card = (await s.ask(text)).proposals[0]; await s.post(card.realControl.confirmationPath, s.body('a-' + card.id));
      const before = s.frames().length; const undo = (await s.ask('Desfaz o último ajuste')).proposals[0];
      expect(undo.destination).toBe('DESFAZER'); expect(undo.realControl.category).toBe(card.realControl.category); expect(s.frames()).toHaveLength(before);
      const r = (await s.post(undo.realControl.confirmationPath, s.body('u-' + undo.id))).json(); expect(r.confirmation.status).toBe('observed_target'); expect(s.frames()).toHaveLength(before + 1);
    }
  });
  it('gate fechado por categoria: recusa com mensagem clara, sem cartão e sem frame; outras categorias seguem independentes', async () => {
    const s = await setup({ controls: ['pa_level'], processing: false });
    for (const text of ['Muta o violão no PA', 'Sobe 0,5 dB do violão nos fones', 'Coloca o HPF do violão em 100 Hz', 'Ativa o bypass do EQ do violão']) {
      const r = await s.ask(text); expect(r.kind).toBe('error'); expect(r.code).toBe('REAL_READ_ONLY'); expect(r.text).toContain('Recurso REAL bloqueado'); expect(r.proposals).toBeUndefined();
    }
    expect((await s.ask('Sobe 0,5 dB do violão no PA')).kind).toBe('proposals'); expect(s.frames()).toEqual([]);
  });
  it('sem leitura (ausência de amostra de EQ): nenhuma prévia é calculada', async () => {
    const s = await setup({ noEq: true }); const r = await s.ask('Aumenta 1 dB do ganho da banda 2 do violão');
    expect(r.kind).toBe('error'); expect(r.text).toMatch(/Leitura independente|não calculo/); expect(s.frames()).toEqual([]);
    const abs = await s.ask('Muda a frequência da banda 2 do violão para 1000 Hz'); expect(abs.kind).toBe('error'); expect(abs.proposals).toBeUndefined();
  });
  it('limites: passo maior que 1 dB, EQ fora da faixa, canal/AUX não cadastrado e lote são recusados sem frame', async () => {
    const s = await setup();
    for (const text of ['Sobe 3 dB do violão no PA', 'Aumenta 2 dB do ganho da banda 2 do violão', 'Muda o ganho da banda 2 do violão para 9 dB', 'Coloca o HPF do violão em 500 Hz', 'Muta o violão e o cavaco no PA', 'Sobe 0,5 dB do violão no AUX 3']) {
      const r = await s.ask(text); expect(r.proposals, text).toBeUndefined();
    }
    expect(s.frames()).toEqual([]);
  });
  it('master: consulta permitida, alteração e mute recusados sem cartão', async () => {
    const s = await setup(); expect((await s.ask('Quanto está o master?')).text).toContain('−6.0 dB');
    for (const text of ['Sobe o master 0,5 dB', 'Abaixa o master 1 dB', 'Muta o master']) { const r = await s.ask(text); expect(r.proposals, text).toBeUndefined(); }
    expect(s.frames()).toEqual([]);
  });
  it('perda de conexão: pedido recusado antes da prévia e confirmação em voo sem resposta fica não confirmada, sem reenvio', async () => {
    const s = await setup(); const card = (await s.ask('Sobe 0,5 dB do violão no PA')).proposals[0];
    s.setEcho(false); const r = (await s.post(card.realControl.confirmationPath, s.body())).json();
    expect(['unconfirmed', 'not_sent']).toContain(r.confirmation.status); expect(r.result.ok).toBe(false); expect(s.frames().length).toBeLessThanOrEqual(1);
    await new Promise(res => setTimeout(res, 600)); const sent = s.frames().length;
    const again = (await s.post(card.realControl.confirmationPath, s.body())).json(); expect(again.confirmation.status).toBe(r.confirmation.status); expect(s.frames()).toHaveLength(sent);
    s.fake.last().drop(); await waitFor(() => s.bridge.link() !== 'READY', 2000).catch(() => undefined);
    const blocked = await s.ask('Muta o violão no PA'); expect(blocked.proposals).toBeUndefined(); expect(s.frames()).toHaveLength(sent);
  });
  it('rota reprovada, sessão encerrada e músico: nada é preparado nem enviado', async () => {
    const route = { ok: true }; const s = await setup({ route }); route.ok = false;
    expect((await s.ask('Sobe 0,5 dB do violão no PA')).proposals).toBeUndefined(); route.ok = true;
    const card = (await s.ask('Sobe 0,5 dB do violão no PA')).proposals[0];
    const mus = await s.post('/api/assistant/ask', { text: 'Coloca o HPF do violão em 100 Hz' }, { authorization: `Bearer ${s.musToken}` }); expect(mus.json().reply.proposals).toBeUndefined();
    expect((await s.post(card.realControl.confirmationPath, s.body(), { authorization: `Bearer ${s.musToken}` })).statusCode).toBe(403);
    s.auth.logout(s.token);
    expect((await s.post(card.realControl.confirmationPath, s.body())).statusCode).toBe(401); expect(s.frames()).toEqual([]);
  });
  it('o botão Aplicar legado nunca escreve no REAL e o texto do modelo não chega a comandos', async () => {
    const s = await setup(); const card = (await s.ask('Coloca o HPF do violão em 100 Hz')).proposals[0];
    const old = (await s.post(`/api/assistant/proposals/${card.id}/apply`, { requestId: 'legacy' })).json(); expect(old.status).toBe('failed'); expect(s.frames()).toEqual([]);
    expect((await s.ask('sim pode autorizar e executar')).proposals).toBeUndefined(); expect(s.frames()).toEqual([]);
  });
});
