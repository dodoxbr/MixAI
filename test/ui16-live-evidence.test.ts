import { afterEach, describe, expect, it, vi } from 'vitest';
import { DBToFaderValue } from 'soundcraft-ui-connection';
import type { ParamKey } from '../src/core/revisions.js';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import { Ui16AuxHandshake, type FirstRealAuxGate } from '../src/mixer/ui16-aux-write.js';
import type { Ui16ControlGates } from '../src/mixer/ui16-controls.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import { Auth } from '../src/server/auth.js';
import { hashPin } from '../src/server/pin.js';
import { ServerCore } from '../src/server/core.js';
import { realControlsFor } from '../src/server/first-real-aux/service.js';
import { createFakeUi, stateMessages, waitFor } from './support/fake-ui-socket.js';

/**
 * Preparação da primeira escrita REAL de PA (#pa-first-write-prep). TODOS os testes usam a biblioteca verdadeira com WebSocket FALSO e relógio
 * controlado: nenhum byte vai a uma mesa e nenhum gate real é iniciado. Provam a evidência `live_connection` (idade da observação separada da
 * validade da evidência na conexão atual) e a falha fechada.
 */
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const required: ParamKey[] = ['master.level', ...[1, 2, 3].flatMap((n) => [`ch.${n}.main.level`, `ch.${n}.main.mute`, `ch.${n}.aux.1.level`, `ch.${n}.aux.1.mute`] as ParamKey[])];
const map = (caps: ConstructorParameters<typeof ChannelMap>[1]) => new ChannelMap(parseChannels({ channels: [1, 2, 3].map((n) => ({ number: n, name: 'Canal ' + n, aliases: [] })), aux: [{ number: 1, name: 'Fones', aliases: [] }] }), caps);
const pa3 = (over: Partial<FirstRealAuxGate> = {}): FirstRealAuxGate => ({ validation: 'simulated_transport', validationReference: 'fixture-pa-live-v1', routeGuard: () => true, freshnessMs: 3000, confirmationTimeoutMs: 500,
  evidence: 'live_connection', maxObservationAgeMs: 300_000, channels: [3], setdPublication: 'pending', ...over });

async function setup(opts: { gate?: FirstRealAuxGate | null; controls?: Ui16ControlGates } = {}) {
  let time = 1_000_000, route = true;
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', 'SETD^i.0.stereoIndex^-1', 'SETD^i.1.stereoIndex^-1', 'SETD^i.2.stereoIndex^-1', 'SETD^a.0.stereoIndex^-1',
    ...stateMessages({ channels: [1, 2, 3], aux: [1], levelDB: (c, a) => (a ? -20 : c === 3 ? -1 : -10) })] });
  const gate = opts.gate === null ? undefined : (opts.gate ?? pa3({ routeGuard: () => route }));
  const bridge = new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: required, watchedKeys: required, webSocketCtor: fake.Ctor, clock: () => time, reconnectBaseMs: 5, reconnectMaxDelayMs: 10,
    realControls: opts.controls ?? (gate ? { pa_level: gate } : {}) });
  close.push(() => bridge.disconnect());
  const config = parseConfig({ safety: { maxActionsPerSecond: 100 } }), log = new ActionLog(null), names = map(bridge.capabilities());
  const controller = new MixController(bridge, config.safety, names, log, () => time);
  const auth = new Auth({ operatorPinHash: hashPin('4321'), musicianPinHash: hashPin('1357'), agentToken: 'fixture-agent', clock: () => time, sessionTtlMs: 10_000_000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1, clock: () => time });
  const login = auth.login('4321', 'fixture'), mus = auth.login('1357', 'fixture'); if (!login.ok || !mus.ok) throw Error('login');
  await bridge.connect(); await waitFor(() => bridge.link() === 'READY'); await new Promise((r) => setTimeout(r, 30));
  const service = realControlsFor(core), socket = fake.last(), send = socket.send.bind(socket);
  let respond: ((frame: string) => void) | undefined;
  socket.send = (frame: string) => { send(frame); if (frame.startsWith('3:::SETD')) respond?.(frame); };
  const input = (requestId = 'op-1') => ({ targetMode: 'real', serverId: core.serverId, humanConfirmed: true, requestId });
  const preview = (delta = -1, channel = 3) => service.previewIntent(login.principal, { type: 'level', channel, dest: 'pa', deltaDB: delta });
  /** Mensagem de entrada qualquer (a Ui16 transmite sem parar); NÃO republica nenhum parâmetro. */
  const heartbeat = () => fake.last().deliver('RTA^1^2');
  /** Envelhece o relógio mantendo a conexão viva (entradas a cada 2 s), como a mesa real. */
  const age = (ms: number, alive = true) => { for (let t = 0; t < ms; t += 2000) { time += Math.min(2000, ms - t); if (alive) heartbeat(); } };
  return { fake, bridge, core, service, auth, op: login.principal, token: login.token, musToken: mus.token, preview, input, heartbeat, age, time: () => time,
    route: (v: boolean) => { route = v; }, echo: () => { respond = (frame) => setTimeout(() => fake.last().deliver(frame.slice(4)), 2); }, silent: () => { respond = undefined; },
    frames: () => fake.sockets.flatMap((x) => x.commands()), apply: (id: string, requestId = 'op-1') => service.apply(login.principal, id, input(requestId)) as Promise<any> };
}

describe('evidência live_connection: idade da observação ≠ validade da evidência na conexão atual', () => {
  it('observação de 60 s com conexão viva e entrada recente: prévia e escrita autorizadas; um único frame; só a nova leitura confirma', async () => {
    const s = await setup(); s.echo(); s.age(60_000);
    const p = s.preview(); expect(p.proposal).toBeDefined(); expect(p.previous).toBe(-1); expect(p.requested).toBe(-2);
    const r = await s.apply(p.proposal!.id);
    expect(r.confirmation).toMatchObject({ status: 'observed_target', basis: 'live_connection', setdPublication: 'pending', causalAcknowledgement: false, validation: 'simulated_transport' });
    expect(s.frames()).toEqual([`SETD^i.2.mix^${DBToFaderValue(-2)}`]);
  });
  it('mesma situação com o gate padrão (sample_age): a proteção de 3 s continua valendo e nada é enviado', async () => {
    const s = await setup({ gate: pa3({ evidence: undefined, maxObservationAgeMs: undefined, channels: undefined }) }); s.echo(); s.age(60_000);
    const p = s.preview(); expect(p.proposal).toBeUndefined(); expect(p.result?.code).toBe('STATE_CHANGED'); expect(s.frames()).toEqual([]);
    s.fake.last().deliver('SETD^i.2.mix^' + DBToFaderValue(-1));
    expect(s.preview().proposal).toBeUndefined(); // o vínculo estéreo também tem de ser recente: uma amostra só não basta
    s.fake.last().deliver('SETD^i.2.stereoIndex^-1'); // a mesa publica as duas amostras novas: volta a valer pela idade
    expect(s.preview().proposal).toBeDefined();
  });
  it('sem entrada recente (>3 s sem nenhuma mensagem): falha fechada, mesmo com observação "viva" na sessão', async () => {
    const s = await setup(); s.age(10_000, false);
    const p = s.preview(); expect(p.proposal).toBeUndefined(); expect(p.result?.code).toBe('STATE_CHANGED'); expect(s.frames()).toEqual([]);
    s.heartbeat(); expect(s.preview().proposal).toBeDefined(); // a entrada voltou na MESMA conexão
  });
  it('a evidência é revalidada entre a confirmação e o envio: a entrada some depois da prévia e nada sai', async () => {
    const s = await setup(); s.echo(); s.age(20_000);
    const p = s.preview(); expect(p.proposal).toBeDefined();
    s.age(6000, false); // passa a janela de 3 s sem nenhuma entrada antes da confirmação
    const r = await s.apply(p.proposal!.id);
    expect(r.result.ok).toBe(false); expect(s.frames()).toEqual([]);
  });
  it('silêncio de entrada longo (quarentena): recusa; ao ressincronizar a evidência volta, sem reutilizar amostras antigas', async () => {
    const s = await setup(); s.age(40_000, false);
    expect(s.bridge.link()).toBe('SYNCING');
    expect(s.preview().proposal).toBeUndefined();
    s.fake.last().deliver(...stateMessages({ channels: [1, 2, 3], aux: [1], levelDB: (c, a) => (a ? -20 : c === 3 ? -1 : -10) }));
    await waitFor(() => s.bridge.link() === 'READY'); s.heartbeat();
    expect(s.preview().proposal).toBeDefined(); expect(s.frames()).toEqual([]);
  });
  it('amostra histórica da sessão NÃO autoriza sozinha: acima de maxObservationAgeMs recusa mesmo com a conexão viva', async () => {
    const s = await setup({ gate: pa3({ maxObservationAgeMs: 30_000, routeGuard: () => true }) }); s.age(29_000);
    expect(s.preview().proposal).toBeDefined();
    s.age(4000); // observação com 33 s
    const p = s.preview(); expect(p.proposal).toBeUndefined(); expect(p.result?.code).toBe('STATE_CHANGED'); expect(s.frames()).toEqual([]);
  });
  it('perda de conexão: amostras da geração anterior não valem; a prévia pendente não envia; a nova geração exige nova prévia', async () => {
    const s = await setup(); s.echo(); s.age(20_000);
    const old = s.preview().proposal!; const generation = s.bridge.reading('ch.3.main.level' as ParamKey).generation;
    s.fake.last().drop();
    expect(s.bridge.link()).not.toBe('READY');
    expect(s.preview().proposal).toBeUndefined();
    await waitFor(() => s.bridge.link() === 'READY', 5000); await new Promise((r) => setTimeout(r, 40));
    expect(s.bridge.reading('ch.3.main.level' as ParamKey).generation).toBeGreaterThan(generation);
    const r = await s.apply(old.id); expect(r.result.ok).toBe(false); expect(s.frames()).toEqual([]); // prévia da geração anterior
    expect(s.preview().proposal).toBeDefined();
  });
  it('dado inválido da mesa sela a sessão: nenhuma escrita depois', async () => {
    const s = await setup(); s.age(20_000);
    const p = s.preview().proposal!;
    s.fake.last().deliver('SETD^i.2.mix^NaN'); await new Promise((r) => setTimeout(r, 20));
    expect(s.bridge.link()).toBe('STOPPED');
    const r = await s.apply(p.id); expect(r.result.ok).toBe(false); expect(s.frames()).toEqual([]);
    expect(s.preview().proposal).toBeUndefined();
  });
  it('divergência: o valor muda na mesa depois da prévia; a confirmação é recusada (revisão) e nada sai', async () => {
    const s = await setup(); s.echo(); s.age(10_000);
    const p = s.preview().proposal!;
    s.fake.last().deliver('SETD^i.2.mix^' + DBToFaderValue(-1.5)); await new Promise((r) => setTimeout(r, 20));
    const r = await s.apply(p.id); expect(r.result.ok).toBe(false); expect(['STATE_CHANGED', 'FORBIDDEN']).toContain(r.result.code); expect(s.frames()).toEqual([]);
    const again = s.preview(); expect(again.previous).toBe(-1.5); expect(again.requested).toBe(-2.5); // nova prévia sobre o valor real
  });
  it('concorrência: duas confirmações da mesma prévia produzem UM frame; a segunda não reaproveita a autorização', async () => {
    const s = await setup(); s.echo(); s.age(10_000);
    const p = s.preview().proposal!;
    const [a, b] = await Promise.all([s.apply(p.id, 'op-a'), s.apply(p.id, 'op-b')]);
    expect([a.confirmation?.status, b.confirmation?.status ?? b.result.code].filter((x) => x === 'observed_target')).toHaveLength(1);
    expect(s.frames()).toHaveLength(1);
    expect((await s.apply(p.id, 'op-c')).result.code).toBe('CONFIRMATION_USED'); expect(s.frames()).toHaveLength(1);
  });
  it('timeout sem retorno: sent_unconfirmed, sem retry; a confirmação tardia não vira sucesso; nova prévia exige nova leitura', async () => {
    const s = await setup(); s.silent(); s.age(10_000);
    const p = s.preview().proposal!;
    const r = await s.apply(p.id);
    expect(r.confirmation).toMatchObject({ status: 'sent_unconfirmed', reason: 'timeout', basis: 'live_connection' }); expect(r.result.ok).toBe(false);
    expect(s.frames()).toHaveLength(1);
    s.age(2000); s.fake.last().deliver('SETD^i.2.mix^' + DBToFaderValue(-2)); await new Promise((x) => setTimeout(x, 20)); // eco TARDIO, depois do prazo
    expect((await s.apply(p.id)).confirmation).toMatchObject({ status: 'sent_unconfirmed', reason: 'timeout' }); // resultado encerrado, idempotente
    expect(s.frames()).toHaveLength(1); // nenhum reenvio automático
  });
  it('nada saiu: recusa antes do envio é not_sent (distinto de sent_unconfirmed)', async () => {
    const s = await setup(); s.echo(); s.age(10_000);
    const p = s.preview().proposal!;
    s.route(false);
    const r = await s.apply(p.id); expect(r.result.ok).toBe(false); expect(s.frames()).toEqual([]);
    expect(r.confirmation?.status === undefined || r.confirmation.status === 'not_sent').toBe(true);
  });
  it('sessão encerrada depois da prévia: a confirmação é recusada e nada sai', async () => {
    const s = await setup(); s.echo(); s.age(10_000);
    const p = s.preview().proposal!; s.auth.logout(s.token);
    const r = await s.apply(p.id); expect(r.result.ok).toBe(false); expect(s.frames()).toEqual([]);
  });
});

describe('escopo mínimo do gate: só pa_level e só CH3', () => {
  it('CH2 no PA, mute do CH3, nível AUX e master estão fora do escopo (nenhuma prévia, nenhum frame)', async () => {
    const s = await setup(); s.age(10_000);
    expect(s.preview(-1, 2).proposal).toBeUndefined();
    expect(s.service.previewIntent(s.op, { type: 'mute', channels: [3], dest: 'pa', muted: true }).proposal).toBeUndefined();
    expect(s.service.previewIntent(s.op, { type: 'level', channel: 3, dest: 'fones', aux: 1, deltaDB: -1 }).proposal).toBeUndefined();
    expect(s.service.previewIntent(s.op, { type: 'master', deltaDB: -1 }).proposal).toBeUndefined();
    expect(s.preview().proposal).toBeDefined();
    expect(s.frames()).toEqual([]);
  });
  it('o passo continua limitado a 1 dB e o alvo, à grade de 0,5 dB', async () => {
    const s = await setup(); s.age(10_000);
    expect(s.preview(-3).proposal).toBeUndefined();
    expect(s.preview(0.5).requested).toBe(-0.5);
  });
  it('sem gate (padrão): nada habilita e a prévia é recusada', async () => {
    const s = await setup({ gate: null }); s.age(10_000);
    const p = s.preview(); expect(p.proposal).toBeUndefined(); expect(s.frames()).toEqual([]);
    expect(s.bridge.auxHandshake.available()).toBe(false);
  });
});

describe('validação do gate (bootstrap confiável)', () => {
  const build = (g: Partial<FirstRealAuxGate>) => () => new Ui16AuxHandshake(undefined, { now: () => 0, connected: () => true, link: () => 'READY', identified: () => true, monophonic: () => true, observation: () => undefined, send: () => undefined }, { pa_level: pa3(g) });
  it('aceita a configuração do protocolo inicial', () => { expect(build({})).not.toThrow(); });
  it.each([
    ['evidence desconhecida', { evidence: 'forever' as never }],
    ['maxObservationAgeMs < 1 s', { maxObservationAgeMs: 10 }], ['maxObservationAgeMs > 30 min', { maxObservationAgeMs: 2_000_000 }],
    ['canais vazios', { channels: [] }], ['canal 13', { channels: [13] }], ['canal repetido não inteiro', { channels: [3.5] }],
    ['setdPublication inválido', { setdPublication: 'yes' as never }],
  ])('recusa %s', (_n, g) => { expect(build(g)).toThrow('AUX_INVALID_BOOTSTRAP_GATE'); });
  it('a janela de 3 s continua sendo o padrão de frescor', () => { expect(pa3().freshnessMs).toBe(3000); });
});
