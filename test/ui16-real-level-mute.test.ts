import { afterEach, describe, expect, it, vi } from 'vitest';
import { DBToFaderValue } from 'soundcraft-ui-connection';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import { controlFrame, UI16_CONTROL_CATEGORIES, type Ui16ControlCategory, type Ui16ControlGates } from '../src/mixer/ui16-controls.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import type { ParamKey } from '../src/core/revisions.js';
import type { Intent } from '../src/assistant/intent.js';
import { AssistantService } from '../src/assistant/service.js';
import { Auth } from '../src/server/auth.js';
import { hashPin } from '../src/server/pin.js';
import { ServerCore } from '../src/server/core.js';
import { realControlsFor } from '../src/server/first-real-aux/service.js';
import { buildHttp } from '../src/server/http.js';
import { createFakeUi, stateMessages, waitFor } from './support/fake-ui-socket.js';

const opHash = hashPin('4321'), musHash = hashPin('1357');
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const scenarios: Array<{ category: Ui16ControlCategory; key: ParamKey; intent: Intent; previous: number | boolean; target: number | boolean; wire: string }> = [
  { category: 'pa_level', key: 'ch.2.main.level', intent: { type: 'level', channel: 2, dest: 'pa', deltaDB: 1 }, previous: -10, target: -9, wire: `SETD^i.1.mix^${DBToFaderValue(-9)}` },
  { category: 'pa_mute', key: 'ch.2.main.mute', intent: { type: 'mute', channels: [2], dest: 'pa', muted: true }, previous: false, target: true, wire: 'SETD^i.1.mute^1' },
  { category: 'aux_level', key: 'ch.2.aux.1.level', intent: { type: 'level', channel: 2, dest: 'fones', aux: 1, deltaDB: 1 }, previous: -20, target: -19, wire: `SETD^i.1.aux.0.value^${DBToFaderValue(-19)}` },
  { category: 'aux_mute', key: 'ch.2.aux.1.mute', intent: { type: 'mute', channels: [2], dest: 'fones', aux: 1, muted: true }, previous: false, target: true, wire: 'SETD^i.1.aux.0.mute^1' },
];
async function setup(opts: { categories?: Ui16ControlCategory[]; mono?: boolean; unknown?: ParamKey; maxStepDB?: number } = {}) {
  let wall = 1_000_000, time = 0, route = true;
  const keys = ['master.level', 'ch.1.main.level', 'ch.1.main.mute', ...scenarios.map(s => s.key)] as ParamKey[];
  const fake = createFakeUi({ initialState: () => ['SETS^model^ui16', ...(opts.mono === false ? [] : ['SETD^i.0.stereoIndex^-1', 'SETD^i.1.stereoIndex^-1', 'SETD^a.0.stereoIndex^-1']), ...stateMessages({ channels: [1, 2], aux: [1] }).filter(line => !opts.unknown || line.split('^')[1] !== controlFrame(opts.unknown, opts.unknown.endsWith('mute') ? false : -10)?.split('^')[1])] });
  const gates: Ui16ControlGates = {};
  for (const category of opts.categories ?? scenarios.map(s => s.category)) if (category !== 'master_level') gates[category] = { validation: 'simulated_transport', validationReference: `fixture-${category}-v1`, routeGuard: () => route, freshnessMs: 1000, confirmationTimeoutMs: 100 };
  const bridge = new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: keys.filter(k => k !== opts.unknown), watchedKeys: keys, webSocketCtor: fake.Ctor, realControls: gates, clock: () => time, reconnectBaseMs: 5, reconnectMaxDelayMs: 10 });
  close.push(() => bridge.disconnect());
  const config = parseConfig({ safety: { maxActionsPerSecond: 100, ...(opts.maxStepDB === undefined ? {} : { maxStepDB: opts.maxStepDB }) } }), log = new ActionLog(null);
  const names = new ChannelMap(parseChannels({ channels: [{ number: 1, name: 'Cavaco', aliases: ['cavaco'] }, { number: 2, name: 'Violão', aliases: ['violao'] }], aux: [{ number: 1, name: 'Fones', aliases: ['fones', 'retorno'] }] }), bridge.capabilities());
  const controller = new MixController(bridge, config.safety, names, log, () => wall);
  const auth = new Auth({ operatorPinHash: opHash, musicianPinHash: musHash, agentToken: 'fixture-agent', clock: () => wall, sessionTtlMs: 100000 });
  const core = new ServerCore(controller, bridge, 'real', auth, log, { musicianAux: 1, clock: () => wall });
  const login = auth.login('4321', 'fixture'), musician = auth.login('1357', 'fixture');
  if (!login.ok || !musician.ok) throw Error('fixture login');
  const service = realControlsFor(core);
  core.assistant = new AssistantService(core, { realPreview: (p, intent, source) => service.previewIntent(p, intent, source), steps: config.assistant, channels: names.inputs.list().map(c => ({ ...c, aliases: [] })), ttlMs: 15000, log });
  close.push(async () => core.assistant?.stop());
  await bridge.connect(); await waitFor(() => bridge.link() === 'READY');
  const op = login.principal, preview = (intent: Intent) => service.previewIntent(op, intent);
  const input = (requestId = 'operation') => ({ targetMode: 'real', serverId: core.serverId, humanConfirmed: true, requestId });
  const apply = async (id: string, requestId = 'operation') => await service.apply(op, id, input(requestId)) as any;
  const socket = fake.last(), send = socket.send.bind(socket);
  let respond: ((frame: string) => void) | undefined;
  socket.send = frame => { send(frame); if (frame.startsWith('3:::SETD')) respond?.(frame); };
  const echo = () => { respond = frame => setTimeout(() => socket.deliver(frame.slice(4)), 2); };
  return { fake, bridge, core, controller, auth, op, musician: musician.principal, token: login.token, musToken: musician.token, service, preview, apply, input, echo, respond: (fn: (frame: string) => void) => { respond = fn; }, age: (ms: number) => { time += ms; wall += ms; }, route: (value: boolean) => { route = value; } };
}

describe.each(scenarios)('$category: real library, exclusively fake WebSocket', scenario => {
  it('one exact library frame, independent observation, previous value and human undo on the same executor', async () => {
    const s = await setup(), execute = vi.spyOn(s.core, 'execute'), write = vi.spyOn(s.bridge, 'write'); s.echo();
    const pr = s.preview(scenario.intent); expect(pr.proposal?.realControl?.category).toBe(scenario.category); expect(pr.previous).toBe(scenario.previous); expect(pr.requested).toBe(scenario.target); expect(write).not.toHaveBeenCalled();
    const result = await s.apply(pr.proposal!.id); expect(result).toMatchObject({ result: { ok: true }, confirmation: { status: 'observed_target', previous: scenario.previous, requested: scenario.target, observed: scenario.target, causalAcknowledgement: false } });
    expect(execute).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1); expect(s.fake.last().commands()).toEqual([scenario.wire]); expect(s.controller.peekUndo()?.keys).toEqual([scenario.key]);
    const undo = s.preview({ type: 'undo' }); expect(undo.proposal?.needsApproval).toBe(true); expect((await s.apply(undo.proposal!.id, 'undo')).confirmation.status).toBe('observed_target'); expect(s.bridge.read(scenario.key)).toEqual({ known: true, value: scenario.previous }); expect(s.controller.peekUndo()).toBeUndefined(); expect(write).toHaveBeenCalledTimes(2);
  });
  it('category grants never enable any other category or master', async () => {
    const s = await setup({ categories: [scenario.category] });
    expect(s.preview(scenario.intent).proposal).toBeDefined();
    for (const other of scenarios.filter(x => x.category !== scenario.category)) expect(s.preview(other.intent).proposal).toBeUndefined();
    expect(s.preview({ type: 'master', deltaDB: -0.5 }).proposal).toBeUndefined(); expect(s.fake.last().commands()).toEqual([]);
  });
  it('library outbound cache is not physical confirmation; timeout/late input cannot reclassify or resend', async () => {
    const s = await setup(), pr = s.preview(scenario.intent), pending = s.apply(pr.proposal!.id);
    await waitFor(() => s.fake.last().commands().length === 1); expect(s.bridge.supervisor.read(scenario.key)).toEqual({ known: true, value: scenario.target }); expect(s.bridge.reading(scenario.key).state).toBe('pending');
    const r = await pending; expect(r.confirmation).toMatchObject({ status: 'unconfirmed', reason: 'timeout', observed: null }); expect(s.bridge.reading(scenario.key).state).toBe('stale'); expect(s.controller.peekUndo()).toBeUndefined();
    s.fake.last().deliver(scenario.wire); expect(s.bridge.read(scenario.key)).toEqual({ known: true, value: scenario.target }); expect((await s.apply(pr.proposal!.id)).confirmation.status).toBe('unconfirmed'); expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('fresh independent sample, mono configuration, operator and registered destinations are required', async () => {
    const unknown = await setup({ unknown: scenario.key }); expect(unknown.preview(scenario.intent).proposal).toBeUndefined();
    const mono = await setup({ mono: false }); expect(mono.preview(scenario.intent).proposal).toBeUndefined();
    const s = await setup(); expect(s.service.previewIntent(s.musician, scenario.intent).result?.code).toBe('FORBIDDEN');
    const agent = s.auth.authenticate('fixture-agent', '127.0.0.1')!; expect(s.service.previewIntent(agent, scenario.intent).result?.code).toBe('FORBIDDEN');
    s.age(1001); expect(s.preview(scenario.intent).proposal).toBeUndefined(); s.age(-1001); s.route(false); expect(s.preview(scenario.intent).proposal).toBeUndefined(); expect(s.fake.last().commands()).toEqual([]);
  });
  it('stale previews and same-parameter simultaneous confirmations never overwrite external state', async () => {
    const s = await setup(), first = s.preview(scenario.intent), second = s.preview(scenario.intent), pending = s.apply(first.proposal!.id);
    await waitFor(() => s.fake.last().commands().length === 1); expect((await s.apply(second.proposal!.id, 'second')).result.code).toBe('CONFLICT');
    s.fake.last().deliver(scenario.wire); expect((await pending).confirmation.status).toBe('observed_target'); expect((await s.apply(first.proposal!.id)).confirmation.status).toBe('observed_target'); expect(s.fake.last().commands()).toHaveLength(1);
    expect((await s.apply(second.proposal!.id, 'third')).result.ok).toBe(false); expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('disconnect and retired-socket messages do not replay work after recovery', async () => {
    const s = await setup(), old = s.fake.last(), generation = s.bridge.supervisor.generation(); s.respond(() => old.drop());
    expect((await s.apply(s.preview(scenario.intent).proposal!.id)).confirmation).toMatchObject({ status: 'unconfirmed', reason: 'connection_changed' });
    await waitFor(() => s.bridge.supervisor.generation() > generation && s.bridge.link() === 'READY'); old.deliver(scenario.wire);
    expect(s.bridge.read(scenario.key)).toEqual({ known: true, value: scenario.previous }); expect(s.fake.sockets.flatMap(x => x.commands())).toEqual([scenario.wire]);
  });
  it('a session revoked while awaiting observation cannot produce success or undo', async () => {
    const s = await setup(); s.respond(frame => { s.auth.logout(s.token); setTimeout(() => s.fake.last().deliver(frame.slice(4)), 2); });
    const r = await s.apply(s.preview(scenario.intent).proposal!.id); expect(r.confirmation).toMatchObject({ status: 'unconfirmed', reason: 'authorization_revoked' }); expect(s.controller.peekUndo()).toBeUndefined(); expect(s.fake.last().commands()).toEqual([scenario.wire]);
  });
  it('direct/raw executor calls and disabled categories cannot borrow a permit', async () => {
    const s = await setup({ categories: [] }); expect(s.preview(scenario.intent).proposal).toBeUndefined();
    await expect(s.bridge.write(scenario.key, scenario.target)).rejects.toThrow(); expect(s.fake.last().commands()).toEqual([]);
  });
});
it('master is independently observed and never writable, even with forged bootstrap or blanket channel grants', async () => {
  const s = await setup(); const listener = vi.fn(); s.bridge.onParamChange(listener);
  s.fake.last().deliver(`SETD^m.mix^${DBToFaderValue(-5)}`); expect(s.bridge.read('master.level')).toEqual({ known: true, value: -5 }); expect(listener).toHaveBeenCalledWith('master.level', -5, 'external');
  expect(s.service.capabilities(s.op)).toMatchObject({ categories: expect.arrayContaining([{ category: 'master_level', enabled: false, available: false, reason: 'separate_approval_and_physical_validation_pending' }]), master: { state: 'confirmed', value: -5 } });
  await expect(s.bridge.write('master.level', -6)).rejects.toThrow();
  expect(() => new Ui16RealBridge({ ip: 'fixture.invalid', requiredKeys: [], watchedKeys: [], webSocketCtor: s.fake.Ctor, realControls: { master_level: { enabled: true } } as never })).toThrow('MASTER_CONTROL_DISABLED'); expect(s.fake.last().commands()).toEqual([]);
});
it('level steps obey both the 1 dB ceiling and existing lower limits, and -infinity is never a numeric origin', async () => {
  const s = await setup({ maxStepDB: 0.5 });
  expect(s.preview({ type: 'level', channel: 2, dest: 'pa', deltaDB: 1 }).proposal).toBeUndefined();
  expect(s.preview({ type: 'level', channel: 2, dest: 'pa', deltaDB: 0.5 }).proposal).toBeDefined();
  expect(s.preview({ type: 'level', channel: 2, dest: 'pa', deltaDB: 2 }).proposal).toBeUndefined();
  s.fake.last().deliver('SETD^i.1.mix^0'); expect(s.preview({ type: 'level', channel: 2, dest: 'pa', deltaDB: 0.5 }).proposal).toBeUndefined(); expect(s.fake.last().commands()).toEqual([]);
});
it('batch, uncatalogued AUX, EQ/HPF, phantom, scenes and master remain unauthorized', async () => {
  const s = await setup(); expect(s.preview({ type: 'mute', channels: [1, 2], dest: 'pa', muted: true }).proposal).toBeUndefined();
  expect(s.preview({ type: 'level', channel: 2, dest: 'fones', aux: 5, deltaDB: 0.5 }).proposal).toBeUndefined();
  for (const key of ['ch.2.eq.b1.gain', 'ch.2.eq.hpf.freq', 'master.level'] as ParamKey[]) await expect(s.bridge.write(key, 1)).rejects.toThrow();
  await expect(s.bridge.loadSnapshot('fixture', 'fixture')).rejects.toThrow(); expect(s.fake.last().commands()).toEqual([]);
});
it('assistant natural language prepares only; explicit REAL human-confirm endpoint executes the same proposal', async () => {
  const s = await setup(), app = await buildHttp(s.core); close.push(() => app.close()); s.echo();
  const headers = { authorization: `Bearer ${s.token}` }, request = (url: string, payload: object, h = headers) => app.inject({ method: 'POST', url, headers: h, payload });
  const asked = (await request('/api/assistant/ask', { text: 'Sobe 0,5 dB do violão no PA' })).json().reply;
  expect(asked.kind).toBe('proposals'); const card = asked.proposals[0]; expect(card.realControl).toMatchObject({ category: 'pa_level', targetMode: 'real', serverId: s.core.serverId }); expect(s.fake.last().commands()).toEqual([]);
  const oldApply = (await request(`/api/assistant/proposals/${card.id}/apply`, { requestId: 'legacy' })).json(); expect(oldApply.status).toBe('failed');
  expect((await request(card.realControl.confirmationPath, { ...s.input(), humanConfirmed: false })).statusCode).toBe(400);
  expect((await request(`/api/ui16/aux/${card.id}/confirm`, s.input())).json().result.code).toBe('FORBIDDEN');
  const result = (await request(card.realControl.confirmationPath, s.input())).json(); expect(result.confirmation.status).toBe('observed_target'); expect(s.fake.last().commands()).toHaveLength(1);
  const mute = (await request('/api/assistant/ask', { text: 'Muta o violão nos fones' })).json().reply; expect(mute.proposals[0].realControl.category).toBe('aux_mute');
  expect((await request(mute.proposals[0].realControl.confirmationPath, s.input('mute'))).json().confirmation.observed).toBe(true);
  expect((await request('/api/ui16/controls/preview', { targetMode: 'real', serverId: s.core.serverId, operation: 'master', deltaDB: -0.5 })).json().result.code).toBe('FORBIDDEN');
});
it('HTTP remains strict, session-bound, authenticated and origin-checked; capabilities cannot activate anything', async () => {
  const s = await setup({ categories: [] }), app = await buildHttp(s.core); close.push(() => app.close());
  const payload = { targetMode: 'real', serverId: s.core.serverId, operation: 'mute', channel: 2, muted: true };
  for (const [headers, statusCode] of [[{}, 401], [{ authorization: `Bearer ${s.musToken}` }, 403], [{ authorization: `Bearer ${s.token}`, origin: 'https://untrusted.invalid' }, 403]] as const) expect((await app.inject({ method: 'POST', url: '/api/ui16/controls/preview', headers, payload })).statusCode).toBe(statusCode);
  const headers = { authorization: `Bearer ${s.token}` };
  expect((await app.inject({ method: 'POST', url: '/api/ui16/controls/preview', headers, payload: { ...payload, approved: true } })).statusCode).toBe(400);
  const caps = (await app.inject({ method: 'GET', url: '/api/ui16/controls', headers })).json(); expect(caps.categories).toHaveLength(UI16_CONTROL_CATEGORIES.length); expect(caps.categories.every((x: any) => !x.enabled)).toBe(true);
  expect((await app.inject({ method: 'POST', url: '/api/ui16/controls/preview', headers, payload })).json().result.ok).toBe(false); expect(s.fake.last().commands()).toEqual([]);
});
it.each(scenarios)('external state or stereo change invalidates $category without retry', async scenario => {
  const s = await setup();
  s.respond(() => s.fake.last().deliver('SETD^i.1.stereoIndex^0'));
  const result = await s.apply(s.preview(scenario.intent).proposal!.id);
  expect(result.confirmation).toMatchObject({ status: 'unconfirmed', reason: 'configuration_changed' }); expect(s.fake.last().commands()).toEqual([scenario.wire]); expect(s.controller.peekUndo()).toBeUndefined();
});
it('a PA mute cannot report success from an incoming batch containing a later unmute', async () => {
  const s = await setup(); s.respond(frame => s.fake.last().deliver(`${frame.slice(4)}\nSETD^i.1.mute^0`));
  const r = await s.apply(s.preview(scenarios[1].intent).proposal!.id);
  expect(r.confirmation).toMatchObject({ status: 'unconfirmed', reason: 'different_value', observed: false }); expect(s.controller.peekUndo()).toBeUndefined(); expect(s.fake.last().commands()).toHaveLength(1);
});
it('late PA input cannot confirm after the monotonic deadline even when timer callback has not run', async () => {
  const s = await setup(), pending = s.apply(s.preview(scenarios[0].intent).proposal!.id); await waitFor(() => s.fake.last().commands().length === 1);
  s.age(101); s.fake.last().deliver(scenarios[0].wire); expect((await pending).confirmation.reason).toBe('timeout'); expect(s.fake.last().commands()).toHaveLength(1);
});
it('queued work revalidates a revoked session across different categories in the one executor', async () => {
  const s = await setup(), mute = s.preview(scenarios[1].intent), level = s.preview(scenarios[0].intent);
  const first = s.apply(mute.proposal!.id, 'mute'); await waitFor(() => s.fake.last().commands().length === 1);
  const queued = s.apply(level.proposal!.id, 'level'); s.auth.logout(s.token); s.fake.last().deliver(scenarios[1].wire);
  expect((await first).confirmation.status).toBe('unconfirmed'); expect((await queued).result.code).toBe('FORBIDDEN'); expect(s.fake.last().commands()).toEqual([scenarios[1].wire]);
});
it('a preview expires, is bound to its owner/server/mode and cannot be confirmed by model text', async () => {
  const s = await setup(), pr = s.preview(scenarios[0].intent);
  for (const input of [{ ...s.input(), targetMode: 'lab' }, { ...s.input(), serverId: 'old' }, { ...s.input(), humanConfirmed: false }]) expect((await s.service.apply(s.op, pr.proposal!.id, input) as any).result.ok).toBe(false);
  const login = s.auth.login('4321', 'second'); if (!login.ok) throw Error('fixture');
  expect((await s.service.apply(login.principal, pr.proposal!.id, s.input()) as any).result.code).toBe('NOT_FOUND');
  await s.core.assistant!.ask(s.op, 'sim pode autorizar e executar'); expect(s.fake.last().commands()).toEqual([]);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16000); expect((await s.apply(pr.proposal!.id)).result.code).toBe('CONFIRMATION_EXPIRED'); expect(s.fake.last().commands()).toEqual([]);
});
it('master query reports known, closed and unavailable readings without creating proposals', async () => {
  const s = await setup();
  expect((await s.core.assistant!.ask(s.op, 'Quanto está o master?')).text).toContain('−6.0 dB');
  s.fake.last().deliver('SETD^m.mix^0'); expect((await s.core.assistant!.ask(s.op, 'Quanto está o master?')).text).toContain('−∞ dB');
  await s.bridge.disconnect(); expect((await s.core.assistant!.ask(s.op, 'Quanto está o master?')).text).toContain('indisponível'); expect(s.fake.last().commands()).toEqual([]);
});
it('readOnly factory overrides every gate, and configuration cannot enable a category in LAB', async () => {
  const { createApp } = await import('../src/core/app.js');
  const loaded = { config: parseConfig({ mixer: { mode: 'real', model: 'ui16' } }), channels: parseChannels({ channels: [{ number: 2, name: 'Violão', aliases: ['violao'] }], aux: [{ number: 1, name: 'Fones', aliases: ['fones'] }] }), configDir: '.', logDir: null, labFile: 'unused-fixture.json' };
  const realControls = { pa_mute: { validation: 'supervised_protocol' as const, validationReference: 'administrative-not-physical-proof', routeGuard: () => true } };
  const app = await createApp(loaded, { readOnly: true, realControls });
  expect(app.mixer).toBeInstanceOf(Ui16RealBridge); expect((app.mixer as Ui16RealBridge).auxHandshake.enabled()).toBe(false);
  await expect(createApp({ ...loaded, config: parseConfig({ mixer: { mode: 'lab' } }) }, { realControls })).rejects.toThrow('AUX_GATE_REQUIRES_REAL_UI16');
});
it('legacy AUX preview never assumes an omitted AUX and master/channel query ambiguity is clarified', async () => {
  const s = await setup();
  expect(s.service.preview(s.op, { targetMode: 'real', serverId: s.core.serverId, channel: 2, deltaDB: 0.5 }).proposal).toBeUndefined();
  expect((await s.core.assistant!.ask(s.op, 'Quanto está o violão no master?')).kind).toBe('clarify');
  expect((await s.core.assistant!.ask(s.op, 'Quanto está o master no AUX1?')).kind).toBe('clarify'); expect(s.fake.last().commands()).toEqual([]);
});
it('even all enabled categories cannot send a second/different frame during a one-parameter authorization', async () => {
  const s = await setup(), pending = s.apply(s.preview(scenarios[0].intent).proposal!.id);
  await waitFor(() => s.fake.last().commands().length === 1);
  s.fake.last().send(`3:::${scenarios[3].wire}`);
  expect((await pending).confirmation.status).toBe('unconfirmed');
  expect(s.fake.sockets.flatMap(socket => socket.commands())).toEqual([scenarios[0].wire]);
});
it('the #101 supervised AUX screen/status stays disabled when only a PA capability is granted', async () => {
  const s = await setup({ categories: ['pa_level'] }), app = await buildHttp(s.core); close.push(() => app.close());
  const status = (await app.inject({ method: 'GET', url: '/api/ui16/aux/status?channel=2&aux=1', headers: { authorization: `Bearer ${s.token}` } })).json();
  expect(status.feature).toMatchObject({ gate: false, available: false, state: 'disabled' }); expect(status.observed).toBeNull();
  expect(s.preview(scenarios[0].intent).proposal).toBeDefined(); expect(s.preview(scenarios[2].intent).proposal).toBeUndefined(); expect(s.fake.last().commands()).toEqual([]);
});
