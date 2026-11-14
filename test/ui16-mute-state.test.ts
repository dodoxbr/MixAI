import { afterEach, describe, expect, it } from 'vitest';
import { effectiveMute, groupFlags, MUTE_ALL_BIT, type Fact, type FactReason } from '../src/mixer/ui16-mute-state.js';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import type { ParamKey } from '../src/core/revisions.js';
import { Auth } from '../src/server/auth.js';
import { hashPin } from '../src/server/pin.js';
import { ServerCore } from '../src/server/core.js';
import { buildHttp } from '../src/server/http.js';
import { createFakeUi, stateMessages, waitFor } from './support/fake-ui-socket.js';

const ok = <T,>(value: T): Fact<T> => ({ state: 'confirmed', value });
const no = (reason: FactReason = 'not_observed'): Fact<never> => ({ state: 'unknown', reason });
const MA = MUTE_ALL_BIT;

describe('MUTE efetivo — tabela de decisão (pura)', () => {
  const run = (individual: Fact<boolean>, groups: Fact<number>, forceUnmute: Fact<boolean>) => effectiveMute({ channel: 1, individual, groups, forceUnmute });
  it.each([
    // [descrição, individual, grupos, forceUnmute, efetivo, causa, precedência]
    ['sem grupo, individual aberto', ok(false), ok(0), ok(false), 'open', 'none', 'not_needed'],
    ['sem grupo, individual mudo', ok(true), ok(0), ok(false), 'muted', 'individual', 'not_needed'],
    ['Mute All, individual aberto, sem Force Unmute → silenciado pelo Mute All', ok(false), ok(MA), ok(false), 'muted', 'mute_all', 'not_needed'],
    ['Mute All, individual mudo, sem Force Unmute → individual + Mute All', ok(true), ok(MA), ok(false), 'muted', 'individual_and_mute_all', 'not_needed'],
    ['Mute All, individual aberto, Force Unmute → precedência pendente (caso do CH3 físico)', ok(false), ok(MA), ok(true), 'unknown', 'force_unmute_precedence_pending', 'pending'],
    ['Mute All, individual mudo, Force Unmute → precedência pendente (caso do CH2 físico)', ok(true), ok(MA), ok(true), 'unknown', 'force_unmute_precedence_pending', 'pending'],
    ['sem grupo, individual mudo, Force Unmute → precedência pendente (não presume)', ok(true), ok(0), ok(true), 'unknown', 'force_unmute_precedence_pending', 'pending'],
    ['sem grupo, individual aberto, Force Unmute → aberto (nada silencia)', ok(false), ok(0), ok(true), 'open', 'none', 'not_needed'],
    ['outro grupo ativo, individual aberto → pertinência não validada', ok(false), ok(1), ok(false), 'unknown', 'other_mute_group_membership_unvalidated', 'not_needed'],
    ['outro grupo ativo, individual mudo, sem Force Unmute → mudo mesmo assim', ok(true), ok(1), ok(false), 'muted', 'individual', 'not_needed'],
    ['outro grupo + Mute All, individual aberto → Force Unmute desligado, mas grupo 1 sem pertinência validada', ok(false), ok(1 | MA), ok(false), 'unknown', 'other_mute_group_membership_unvalidated', 'not_needed'],
    ['grupos desconhecidos, individual aberto → desconhecido (um grupo poderia silenciar)', ok(false), no(), ok(false), 'unknown', 'group_state_unavailable', 'not_needed'],
    ['grupos desconhecidos, individual mudo e sem Force Unmute → mudo', ok(true), no(), ok(false), 'muted', 'individual', 'not_needed'],
    ['grupos desconhecidos, individual mudo, Force Unmute desconhecido → desconhecido', ok(true), no(), no(), 'unknown', 'group_state_unavailable', 'not_needed'],
    ['Mute All, Force Unmute desconhecido → desconhecido (nunca presume)', ok(false), ok(MA), no(), 'unknown', 'force_unmute_unavailable', 'not_needed'],
    ['individual indisponível, sem grupo → desconhecido', no('disconnected'), ok(0), ok(false), 'unknown', 'individual_unavailable', 'not_needed'],
    ['individual indisponível, Mute All e sem Force Unmute → ainda silenciado pelo Mute All', no('inbound_silence'), ok(MA), ok(false), 'muted', 'mute_all', 'not_needed'],
    ['sem grupo, individual mudo, Force Unmute desconhecido → desconhecido', ok(true), ok(0), no(), 'unknown', 'force_unmute_unavailable', 'not_needed'],
  ] as const)('%s', (_n, individual, groups, fu, effective, cause, precedence) => {
    const r = run(individual, groups, fu);
    expect([r.effective, r.cause, r.precedence]).toEqual([effective, cause, precedence]);
  });
  it('mantém os fatos separados: individual, Mute All, Force Unmute e razões das lacunas', () => {
    const r = run(ok(true), ok(MA), ok(true));
    expect(r).toMatchObject({ individual: true, muteAll: 'active', forceUnmute: true, otherGroupsActive: false, reasons: [] });
    expect(run(no('disconnected'), no('inbound_silence'), no('not_observed')).reasons).toEqual(['disconnected', 'inbound_silence', 'not_observed']);
    expect(groupFlags(ok(MA | 4))).toEqual({ muteAll: 'active', other: true });
    expect(groupFlags(ok(0))).toEqual({ muteAll: 'inactive', other: false });
    expect(groupFlags(no())).toEqual({ muteAll: 'unknown', other: null });
  });
  it('invariantes em TODAS as combinações: nunca "aberto" sem evidência; "mudo" só com Force Unmute desligado; Force Unmute + silêncio possível = precedência pendente', () => {
    const individuals = [ok(true), ok(false), no()], groups = [ok(0), ok(MA), ok(1), ok(MA | 1), no()], fus = [ok(true), ok(false), no()];
    for (const i of individuals) for (const g of groups) for (const f of fus) {
      const r = run(i, g, f), flags = groupFlags(g);
      if (r.effective === 'open') expect([i.state === 'confirmed' && i.value === false, flags.muteAll === 'inactive', flags.other === false]).toEqual([true, true, true]);
      if (r.effective === 'muted') expect(f.state === 'confirmed' && f.value === false).toBe(true);
      const fu = f.state === 'confirmed' && f.value;
      const mightBeMuted = g.state === 'confirmed' && ((i.state === 'confirmed' && i.value) || flags.muteAll === 'active' || flags.other === true);
      if (fu && mightBeMuted) expect([r.effective, r.precedence]).toEqual(['unknown', 'pending']);
    }
  });
});

/** Ponte real com a biblioteca verdadeira e WebSocket falso; nenhuma mesa. Provas: observação, partes ausentes, reconexão e zero comandos. */
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
const names = (caps: ConstructorParameters<typeof ChannelMap>[1]) => new ChannelMap(parseChannels({ channels: [1, 2, 3, 4, 5].map(n => ({ number: n, name: 'Canal ' + n, aliases: [] })), aux: [{ number: 1, name: 'Fones', aliases: ['fones'] }] }), caps);
async function setup(initial: string[] = []) {
  const required: ParamKey[] = ['master.level', ...[1, 2, 3, 4, 5].flatMap(n => [`ch.${n}.main.level`, `ch.${n}.main.mute`] as ParamKey[])];
  let seed = initial;
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', ...stateMessages({ channels: [1, 2, 3, 4, 5], aux: [1], muted: () => false }), ...seed] });
  const bridge = new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: required, watchedKeys: required, webSocketCtor: fake.Ctor, reconnectBaseMs: 5, reconnectMaxDelayMs: 10 });
  close.push(() => bridge.disconnect());
  const log = new ActionLog(null), map = names(bridge.capabilities());
  const controller = new MixController(bridge, parseConfig({}).safety, map, log);
  const auth = new Auth({ operatorPinHash: hashPin('4321'), musicianPinHash: hashPin('1357'), agentToken: 'fixture-agent', sessionTtlMs: 600000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1 });
  const op = auth.login('4321', 'fixture'), mus = auth.login('1357', 'fixture'); if (!op.ok || !mus.ok) throw Error('login');
  await bridge.connect(); await waitFor(() => bridge.link() === 'READY'); await new Promise(r => setTimeout(r, 30));
  const app = await buildHttp(core); close.push(() => app.close());
  const get = async (token = op.token) => app.inject({ method: 'GET', url: '/api/ui16/mute-state', headers: { authorization: `Bearer ${token}` } });
  const state = async () => (await get()).json();
  const byCh = (j: any, n: number) => j.channels.find((c: any) => c.channel === n);
  return { fake, bridge, core, app, get, state, byCh, opToken: op.token, musToken: mus.token, setSeed: (s: string[]) => { seed = s; } };
}
const physical = ['SETD^mgmask^8388608', 'SETD^i.0.mute^1', 'SETD^i.1.mute^1', 'SETD^i.2.mute^0', 'SETD^i.3.mute^0', 'SETD^i.0.forceunmute^0', 'SETD^i.1.forceunmute^1', 'SETD^i.2.forceunmute^1', 'SETD^i.3.forceunmute^0', 'SETD^i.4.forceunmute^0', 'SETD^i.4.mute^1'];

describe('GET /api/ui16/mute-state (REAL, somente leitura)', () => {
  it('combinação física observada (Mute All + Force Unmute em CH2/CH3): cada canal com causa própria e zero comandos', async () => {
    const s = await setup(physical);
    const j = await s.state();
    expect(j).toMatchObject({ targetMode: 'real', hardwareValidation: 'pending', source: 'independent_socket_input', groups: { state: 'confirmed', mask: MA, muteAll: 'active', otherGroupsActive: false } });
    expect(s.byCh(j, 1)).toMatchObject({ individual: true, forceUnmute: false, effective: 'muted', cause: 'individual_and_mute_all' });
    expect(s.byCh(j, 2)).toMatchObject({ individual: true, forceUnmute: true, effective: 'unknown', cause: 'force_unmute_precedence_pending', precedence: 'pending' });
    expect(s.byCh(j, 3)).toMatchObject({ individual: false, forceUnmute: true, effective: 'unknown', cause: 'force_unmute_precedence_pending' });
    expect(s.byCh(j, 4)).toMatchObject({ individual: false, forceUnmute: false, effective: 'muted', cause: 'mute_all' });
    expect(s.byCh(j, 5)).toMatchObject({ individual: true, effective: 'muted', cause: 'individual_and_mute_all' });
    expect(s.fake.last().commands()).toEqual([]);
  });
  it('o MUTE individual existente continua intacto (lê i.N.mute) e o Mute All muda só o efetivo', async () => {
    const s = await setup(physical);
    expect(s.bridge.reading('ch.4.main.mute' as ParamKey)).toMatchObject({ state: 'confirmed', value: false });
    s.fake.last().deliver('SETD^mgmask^0'); await new Promise(r => setTimeout(r, 20));
    const j = await s.state();
    expect(j.groups).toMatchObject({ muteAll: 'inactive' });
    expect(s.byCh(j, 4)).toMatchObject({ individual: false, effective: 'open', cause: 'none' });
    expect(s.byCh(j, 1)).toMatchObject({ individual: true, effective: 'muted', cause: 'individual' });
    expect(s.byCh(j, 2)).toMatchObject({ effective: 'unknown', cause: 'force_unmute_precedence_pending' }); // individual mudo + Force Unmute continua sem regra validada
    s.fake.last().deliver('SETD^mgmask^8388608'); await new Promise(r => setTimeout(r, 20));
    expect(s.byCh(await s.state(), 4)).toMatchObject({ effective: 'muted', cause: 'mute_all' });
  });
  it('dados parciais: sem mgmask / sem Force Unmute nunca viram "aberto" por padrão', async () => {
    const s = await setup(['SETD^i.0.forceunmute^0']); // só um canal tem Force Unmute; nenhuma máscara
    let j = await s.state();
    expect(j.groups).toMatchObject({ state: 'unknown', mask: null, muteAll: 'unknown', reason: 'not_observed' });
    expect(s.byCh(j, 1)).toMatchObject({ individual: false, effective: 'unknown', cause: 'group_state_unavailable' });
    expect(s.byCh(j, 2)).toMatchObject({ effective: 'unknown', forceUnmute: null });
    s.fake.last().deliver('SETD^mgmask^8388608'); await new Promise(r => setTimeout(r, 20));
    j = await s.state();
    expect(s.byCh(j, 1)).toMatchObject({ effective: 'muted', cause: 'mute_all' });
    expect(s.byCh(j, 2)).toMatchObject({ effective: 'unknown', cause: 'force_unmute_unavailable', reasons: ['not_observed'] });
  });
  it.each([['mgmask não numérico', 'SETD^mgmask^abc'], ['mgmask acima de 24 bits', 'SETD^mgmask^16777216'], ['mgmask negativo', 'SETD^mgmask^-1']])('amostra inválida (%s): grupos desconhecidos, sessão preservada, sem escrita', async (_n, frame) => {
    const s = await setup([frame]);
    const j = await s.state();
    expect(j.groups).toMatchObject({ state: 'unknown', reason: 'invalid_sample', muteAll: 'unknown' });
    expect(s.bridge.link()).toBe('READY');
    expect(s.fake.last().commands()).toEqual([]);
  });
  it('Force Unmute inválido para um canal só torna esse canal desconhecido', async () => {
    const s = await setup(['SETD^mgmask^8388608', 'SETD^i.0.forceunmute^2', 'SETD^i.1.forceunmute^0']);
    const j = await s.state();
    expect(s.byCh(j, 1)).toMatchObject({ forceUnmute: null, effective: 'unknown', reasons: ['invalid_sample'] });
    expect(s.byCh(j, 2)).toMatchObject({ forceUnmute: false, effective: 'muted', cause: 'mute_all' });
  });
  it('perda de conexão e reconexão: nada antigo é reutilizado; só valores observados na nova geração valem', async () => {
    const s = await setup(physical);
    expect(s.byCh(await s.state(), 4)).toMatchObject({ effective: 'muted', cause: 'mute_all' });
    s.setSeed(['SETD^i.1.forceunmute^0']); // a mesa volta sem republicar mgmask
    s.fake.last().drop();
    await waitFor(() => s.bridge.link() !== 'READY', 3000).catch(() => undefined);
    let j = await s.state();
    if (s.bridge.link() !== 'READY') expect(s.byCh(j, 4)).toMatchObject({ effective: 'unknown' });
    await waitFor(() => s.bridge.link() === 'READY', 5000); await new Promise(r => setTimeout(r, 50));
    j = await s.state();
    expect(j.groups).toMatchObject({ state: 'unknown', reason: 'not_observed' }); // a máscara anterior NÃO sobrevive à reconexão
    expect(s.byCh(j, 4)).toMatchObject({ effective: 'unknown', cause: 'group_state_unavailable' });
    expect(s.byCh(j, 2)).toMatchObject({ forceUnmute: false });
    s.fake.last().deliver('SETD^mgmask^8388608'); await new Promise(r => setTimeout(r, 20));
    // o Force Unmute do CH4 também não foi republicado na nova conexão: continua desconhecido até a mesa informar
    expect(s.byCh(await s.state(), 4)).toMatchObject({ effective: 'unknown', cause: 'force_unmute_unavailable', reasons: ['not_observed'] });
    s.fake.last().deliver('SETD^i.3.forceunmute^0'); await new Promise(r => setTimeout(r, 20));
    expect(s.byCh(await s.state(), 4)).toMatchObject({ effective: 'muted', cause: 'mute_all' });
    expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
  });
  it('mesa desconectada de propósito: fatos desconhecidos com razão "disconnected"', async () => {
    const s = await setup(physical);
    await s.bridge.disconnect();
    const j = await s.state();
    expect(j.groups).toMatchObject({ state: 'unknown', reason: 'disconnected' });
    expect(s.byCh(j, 4)).toMatchObject({ effective: 'unknown', individual: null, reasons: expect.arrayContaining(['disconnected']) });
  });
  it('acesso: só o operador autenticado; músico e sem sessão são recusados; Origin diferente é recusado', async () => {
    const s = await setup(physical);
    expect((await s.app.inject({ method: 'GET', url: '/api/ui16/mute-state' })).statusCode).toBe(401);
    expect((await s.get(s.musToken)).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'GET', url: '/api/ui16/mute-state', headers: { authorization: `Bearer ${s.opToken}`, origin: 'http://evil.example' } })).statusCode).toBe(403);
    expect((await s.get()).headers['cache-control']).toBe('no-store');
    expect((await s.app.inject({ method: 'POST', url: '/api/ui16/mute-state', headers: { authorization: `Bearer ${s.opToken}` }, payload: {} })).statusCode).toBe(404); // sem escrita
  });
  it('a rota nem existe fora do REAL', async () => {
    const { startTestServer } = await import('./server-support.js');
    const lab = await startTestServer();
    try { const token = await lab.login('4321'); expect((await lab.http('/api/ui16/mute-state', { token })).status).toBe(404); } finally { await lab.server.close(); }
  });
});
