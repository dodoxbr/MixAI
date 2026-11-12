import { afterEach, describe, expect, it, vi } from 'vitest';
import { DBToFaderValue } from 'soundcraft-ui-connection';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import type { ParamKey } from '../src/core/revisions.js';
import { Auth } from '../src/server/auth.js';
import { hashPin } from '../src/server/pin.js';
import { ServerCore } from '../src/server/core.js';
import { FirstRealAuxService } from '../src/server/first-real-aux/service.js';
import { buildHttp } from '../src/server/http.js';
import { fixtureChannels } from './helpers.js';
import {
  createFakeUi,
  stateMessages,
  waitFor,
  sleep,
} from './support/fake-ui-socket.js';
import { wsClient } from './server-support.js';

const key: ParamKey = 'ch.2.aux.1.level';
const required: ParamKey[] = [
  'ch.2.main.level',
  'ch.2.main.mute',
  key,
  'ch.2.aux.1.mute',
  'master.level',
];
const opHash = hashPin('4321'),
  musHash = hashPin('1357');
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(
  options: {
    enabled?: boolean;
    mono?: boolean;
    identified?: boolean;
    timeout?: number;
    partial?: boolean;
  } = {},
) {
  let time = 0,
    wall = 1_000_000,
    route = true;
  const fake = createFakeUi({
    initialState: () => [
      ...(options.identified === false ? [] : ['SETS^model^ui16']),
      ...(options.mono === false
        ? []
        : [
            'SETD^i.1.stereoIndex^-1',
            'SETD^i.0.stereoIndex^-1',
            'SETD^a.0.stereoIndex^-1',
          ]),
      ...stateMessages({ channels: [1, 2], aux: [1] }),
    ],
  });
  const bridge = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: [
      ...required,
      'ch.1.aux.1.level',
      ...(options.partial ? ['ch.3.aux.1.level' as ParamKey] : []),
    ],
    syncTimeoutMs: options.partial ? 20 : 5000,
    watchedKeys: [...required, 'ch.1.aux.1.level'],
    webSocketCtor: fake.Ctor,
    clock: () => time,
    reconnectBaseMs: 5,
    reconnectMaxDelayMs: 10,
    ...(options.enabled === false
      ? {}
      : {
          firstRealAux: {
            validation: 'simulated_transport' as const,
            validationReference: 'fixture-aux-v1',
            routeGuard: () => route,
            freshnessMs: 1000,
            confirmationTimeoutMs: options.timeout ?? 80,
          },
        }),
  });
  cleanup.push(() => bridge.disconnect());
  const log = new ActionLog(null);
  const c = new MixController(
    bridge,
    parseConfig({ safety: { maxActionsPerSecond: 100 } }).safety,
    new ChannelMap(fixtureChannels(), bridge.capabilities()),
    log,
  );
  const auth = new Auth({
    operatorPinHash: opHash,
    musicianPinHash: musHash,
    agentToken: 'fixture-agent',
    clock: () => wall,
    sessionTtlMs: 100000,
  });
  const core = new ServerCore(c, bridge, 'real', auth, log, {
    musicianAux: 1,
    clock: () => wall,
  });
  await bridge.connect();
  await waitFor(
    () => bridge.link() === (options.partial ? 'DEGRADED_READ_ONLY' : 'READY'),
  );
  const opLogin = auth.login('4321', 'fixture'),
    musLogin = auth.login('1357', 'fixture');
  if (!opLogin.ok || !musLogin.ok) throw Error('fixture login');
  const service = new FirstRealAuxService(core, () => wall);
  const preview = () =>
    service.preview(opLogin.principal, {
      targetMode: 'real',
      serverId: core.serverId,
      channel: 2,
      aux: 1,
      deltaDB: 1,
    });
  const confirmation = (requestId = 'attempt') => ({
    targetMode: 'real',
    serverId: core.serverId,
    requestId,
    humanConfirmed: true,
  });
  const apply = async (id: string, requestId = 'attempt') =>
    (await service.apply(
      opLogin.principal,
      id,
      confirmation(requestId),
    )) as any;
  let incoming: ((frame: string) => void) | undefined;
  const socket = fake.last(),
    send = socket.send.bind(socket);
  socket.send = (frame: string) => {
    send(frame);
    if (frame.startsWith('3:::SETD')) incoming?.(frame);
  };
  const respond = (fn: (frame: string) => void) => {
    incoming = fn;
  };
  const echo = () =>
    respond((frame) => setTimeout(() => socket.deliver(frame.slice(4)), 2));
  return {
    bridge,
    c,
    core,
    auth,
    service,
    fake,
    op: opLogin.principal,
    operatorToken: opLogin.token,
    mus: musLogin.principal,
    musicianToken: musLogin.token,
    preview,
    confirmation,
    apply,
    respond,
    echo,
    age: (ms: number) => {
      time += ms;
      wall += ms;
    },
    route: (value: boolean) => (route = value),
  };
}
describe('first Ui16 AUX write: real library + simulated socket only', () => {
  it('is disabled by default and rejects fake-validation bootstrap without an injected transport', async () => {
    const s = await setup({ enabled: false });
    expect(s.preview()).toMatchObject({ result: { ok: false } });
    await expect(s.bridge.write(key, -19)).rejects.toThrow(
      'BRIDGE_PHYSICAL_WRITE_UNVALIDATED',
    );
    expect(
      () =>
        new Ui16RealBridge({
          ip: 'fixture.invalid',
          requiredKeys: required,
          watchedKeys: required,
          firstRealAux: {
            validation: 'simulated_transport',
            validationReference: 'fixture',
            routeGuard: () => true,
          },
        }),
    ).toThrow('AUX_SIMULATION_REQUIRES_INJECTED_TRANSPORT');
    expect(s.fake.last().commands()).toEqual([]);
  });
  it.each([{ mono: false }, { identified: false }])(
    'blocks unknown link configuration or unidentified device: %j',
    async (options) => {
      const s = await setup(options);
      expect(s.preview()).toHaveProperty('result');
      expect(s.fake.last().commands()).toEqual([]);
    },
  );
  it('requires operator, explicit REAL, current server, registered channel/AUX and <=1 dB', async () => {
    const s = await setup();
    const input = {
      targetMode: 'real',
      serverId: s.core.serverId,
      channel: 2,
      aux: 1,
      deltaDB: 1,
    };
    const agent = s.auth.authenticate('fixture-agent', '127.0.0.1')!;
    for (const p of [s.mus, agent])
      expect(s.service.preview(p, input)).toMatchObject({
        result: { code: 'FORBIDDEN' },
      });
    for (const data of [
      { ...input, targetMode: undefined },
      { ...input, serverId: 'old' },
      { ...input, channel: 11 },
      { ...input, aux: 6 },
      { ...input, deltaDB: 1.5 },
      { ...input, deltaDB: NaN },
    ])
      expect(s.service.preview(s.op, data)).toHaveProperty('result');
    const id = s.preview().proposal!.id;
    const denied = await s.service.apply(s.op, id, {
      ...s.confirmation(),
      humanConfirmed: false,
    });
    expect(denied).toMatchObject({ result: { code: 'FORBIDDEN' } });
    expect(s.fake.last().commands()).toEqual([]);
  });
  it('sends exactly the library-proven AUX frame, awaits independent input and reports all three values', async () => {
    const s = await setup();
    const master = s.bridge.read('master.level');
    s.echo();
    const pr = s.preview();
    expect(pr).toMatchObject({
      previous: -20,
      requested: -19,
      proposal: { needsApproval: true },
    });
    const result = await s.apply(pr.proposal!.id);
    expect(result).toMatchObject({
      result: { ok: true },
      confirmation: {
        status: 'observed_target',
        previous: -20,
        requested: -19,
        observed: -19,
        source: 'independent_socket_input',
        validation: 'simulated_transport',
        causalAcknowledgement: false,
      },
    });
    expect(s.fake.last().commands()).toEqual([
      `SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`,
    ]);
    expect(s.bridge.read('master.level')).toEqual(master);
    expect(s.c.peekUndo()?.keys).toEqual([key]);
  });
  it('does not treat outgoing cache/SETD echo as confirmation; timeout is unconfirmed with no replay', async () => {
    const s = await setup();
    const pr = s.preview();
    const pending = s.apply(pr.proposal!.id);
    await waitFor(() => s.fake.last().commands().length === 1);
    // Library cache changes without any incoming packet; adapter must still expose no current target.
    expect(s.bridge.supervisor.read(key)).toEqual({ known: true, value: -19 });
    expect(s.bridge.read(key)).toEqual({ known: false });
    const result = await pending;
    expect(result).toMatchObject({
      result: { ok: false },
      confirmation: {
        status: 'unconfirmed',
        reason: 'timeout',
        previous: -20,
        requested: -19,
        observed: null,
      },
    });
    expect(s.c.peekUndo()).toBeUndefined();
    expect(s.bridge.reading(key).state).toBe('stale');
    s.fake.last().deliver(`SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`);
    expect(s.bridge.read(key)).toEqual({ known: true, value: -19 });
    const duplicate = await s.apply(pr.proposal!.id);
    expect(duplicate.confirmation.status).toBe('unconfirmed');
    expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('does not overwrite an external change between preview and queue execution', async () => {
    const s = await setup();
    const id = s.preview().proposal!.id;
    s.fake.last().deliver(`SETD^i.1.aux.0.value^${DBToFaderValue(-22)}`);
    expect(await s.apply(id)).toMatchObject({
      result: { ok: false },
      confirmation: { status: 'not_sent' },
    });
    expect(s.fake.last().commands()).toEqual([]);
  });
  it('reports a different concurrent observation without retry or automatic rollback', async () => {
    const s = await setup();
    s.respond(() =>
      setTimeout(
        () =>
          s.fake.last().deliver(`SETD^i.1.aux.0.value^${DBToFaderValue(-22)}`),
        2,
      ),
    );
    const result = await s.apply(s.preview().proposal!.id);
    expect(result).toMatchObject({
      result: { ok: false },
      confirmation: {
        status: 'unconfirmed',
        reason: 'different_value',
        observed: -22,
      },
    });
    expect(s.fake.last().commands()).toHaveLength(1);
    expect(s.c.peekUndo()).toBeUndefined();
  });
  it('revocation while queued or awaiting observation never grants/retains approval', async () => {
    const s = await setup();
    const id = s.preview().proposal!.id;
    s.respond((frame) => {
      s.auth.logout(s.operatorToken);
      setTimeout(() => s.fake.last().deliver(frame.slice(4)), 2);
    });
    expect(await s.apply(id)).toMatchObject({
      result: { ok: false },
      confirmation: { status: 'unconfirmed', reason: 'authorization_revoked' },
    });
    expect(s.fake.last().commands()).toHaveLength(1);
    expect(s.preview()).toMatchObject({ result: { code: 'FORBIDDEN' } });
  });
  it('disconnects mid-operation, rejects delayed retired-socket frames, and never replays', async () => {
    const s = await setup();
    const old = s.fake.last();
    s.respond(() => old.drop());
    const result = await s.apply(s.preview().proposal!.id);
    expect(result).toMatchObject({
      confirmation: { status: 'unconfirmed', reason: 'connection_changed' },
    });
    const generation = s.bridge.supervisor.generation();
    await waitFor(
      () =>
        s.bridge.supervisor.generation() > generation &&
        s.bridge.link() === 'READY',
    );
    old.deliver(`SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`);
    expect(s.bridge.read(key)).toEqual({ known: true, value: -20 });
    expect(s.fake.sockets.flatMap((socket) => socket.commands())).toHaveLength(
      1,
    );
  });
  it('blocks same-parameter concurrency and duplicate approvals without another send', async () => {
    const s = await setup();
    const first = s.preview().proposal!.id,
      second = s.preview().proposal!.id;
    const started = s.apply(first);
    await waitFor(() => s.fake.last().commands().length === 1);
    const duplicate = s.apply(first);
    expect(await s.apply(second, 'other')).toMatchObject({
      result: { code: 'CONFLICT' },
    });
    s.fake.last().deliver(`SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`);
    expect((await started).confirmation.status).toBe('observed_target');
    expect((await duplicate).confirmation.status).toBe('observed_target');
    expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('rejects stale samples, degraded/offline links, route changes and stereo-linked inputs', async () => {
    const s = await setup();
    s.age(1001);
    expect(s.preview()).toHaveProperty('result');
    s.age(-1001);
    s.route(false);
    expect(s.preview()).toHaveProperty('result');
    s.route(true);
    s.fake.last().deliver('SETD^i.1.stereoIndex^0');
    expect(s.preview()).toHaveProperty('result');
    s.fake.last().drop();
    expect(s.preview()).toHaveProperty('result');
    expect(s.fake.sockets.flatMap((socket) => socket.commands())).toEqual([]);
  });
  it('cancels uncertain confirmation if stereo-link configuration changes during the operation', async () => {
    const s = await setup();
    s.respond(() => s.fake.last().deliver('SETD^a.0.stereoIndex^0'));
    expect(await s.apply(s.preview().proposal!.id)).toMatchObject({
      confirmation: { status: 'unconfirmed', reason: 'configuration_changed' },
    });
    expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('undo uses the existing executor/stack and requires a new human authorization', async () => {
    const s = await setup();
    s.echo();
    expect((await s.apply(s.preview().proposal!.id)).result.ok).toBe(true);
    const undo = s.service.preview(s.op, {
      targetMode: 'real',
      serverId: s.core.serverId,
      undo: true,
    });
    expect(undo.proposal?.needsApproval).toBe(true);
    const reversed = await s.apply(undo.proposal!.id, 'undo');
    expect(reversed).toMatchObject({
      result: { ok: true },
      confirmation: {
        previous: -19,
        requested: -20,
        observed: -20,
        status: 'observed_target',
      },
    });
    expect(s.c.peekUndo()).toBeUndefined();
    expect(s.fake.last().commands()).toHaveLength(2);
    await expect(s.bridge.write(key, -19)).rejects.toThrow();
    expect(s.fake.last().commands()).toHaveLength(2);
  });
  it.each([
    'master.level',
    'ch.2.main.level',
    'ch.2.main.mute',
    'ch.2.aux.1.mute',
    'ch.2.eq.b1.gain',
    'ch.2.eq.hpf.freq',
  ] as ParamKey[])(
    'never authorizes out-of-scope parameter %s',
    async (target) => {
      const s = await setup();
      await expect(s.bridge.write(target, -19)).rejects.toThrow(
        'BRIDGE_PHYSICAL_WRITE_UNVALIDATED',
      );
      await expect(s.bridge.loadSnapshot('a', 'b')).rejects.toThrow();
      expect(s.fake.last().commands()).toEqual([]);
    },
  );
  it('rechecks session authorization inside the existing queue, including queued work', async () => {
    const s = await setup();
    const first = s.service.preview(s.op, {
      targetMode: 'real',
      serverId: s.core.serverId,
      channel: 1,
      aux: 1,
      deltaDB: 1,
    });
    const executing = s.apply(first.proposal!.id, 'first');
    await waitFor(() => s.fake.last().commands().length === 1);
    const queued = s.apply(s.preview().proposal!.id, 'queued');
    s.auth.logout(s.operatorToken);
    s.fake.last().deliver(`SETD^i.0.aux.0.value^${DBToFaderValue(-19)}`);
    expect(await executing).toMatchObject({
      confirmation: { status: 'unconfirmed' },
    });
    expect(await queued).toMatchObject({
      result: { ok: false, code: 'FORBIDDEN' },
      confirmation: { status: 'not_sent' },
    });
    expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('does not accept a late target merely because the timeout callback was delayed', async () => {
    const s = await setup();
    const pending = s.apply(s.preview().proposal!.id);
    await waitFor(() => s.fake.last().commands().length === 1);
    s.age(81);
    s.fake.last().deliver(`SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`);
    expect(await pending).toMatchObject({
      confirmation: { status: 'unconfirmed', reason: 'timeout', observed: -19 },
    });
    expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('does not report success if an incoming batch also contains a later divergent value', async () => {
    const s = await setup();
    s.respond((frame) =>
      s.fake
        .last()
        .deliver(
          `${frame.slice(4)}\nSETD^i.1.aux.0.value^${DBToFaderValue(-22)}`,
        ),
    );
    expect(await s.apply(s.preview().proposal!.id)).toMatchObject({
      result: { ok: false },
      confirmation: {
        status: 'unconfirmed',
        reason: 'different_value',
        observed: -22,
      },
    });
    expect(s.c.peekUndo()).toBeUndefined();
    expect(s.fake.last().commands()).toHaveLength(1);
  });
  it('a consumed/unused permit cannot be borrowed by a later executor task', async () => {
    const s = await setup();
    const sample = s.bridge.auxHandshake.current(key)!;
    s.bridge.auxHandshake.authorize({
      id: 'unused',
      key,
      previous: sample,
      requested: -19,
      authorized: () => true,
    });
    await Promise.resolve();
    await expect(s.bridge.write(key, -19)).rejects.toThrow();
    expect(s.fake.last().commands()).toEqual([]);
  });
  it('a silently closed transport is refused before any write attempt', async () => {
    const s = await setup();
    const id = s.preview().proposal!.id;
    s.fake.last().kill();
    expect(await s.apply(id)).toMatchObject({ result: { ok: false } });
    expect(s.fake.last().commands()).toEqual([]);
  });
  it('rejects partial synchronization even when this particular AUX sample is known', async () => {
    const s = await setup({ partial: true });
    expect(s.bridge.link()).toBe('DEGRADED_READ_ONLY');
    expect(s.preview()).toMatchObject({ result: { ok: false } });
    expect(s.fake.last().commands()).toEqual([]);
  });
  it('the wire gate refuses a master frame even while a human AUX operation is pending', async () => {
    const s = await setup();
    const pending = s.apply(s.preview().proposal!.id);
    await waitFor(() => s.fake.last().commands().length === 1);
    s.fake.last().send('3:::SETD^m.mix^0.5');
    expect(await pending).toMatchObject({
      confirmation: { status: 'unconfirmed' },
    });
    expect(s.fake.sockets.flatMap((socket) => socket.commands())).toEqual([
      `SETD^i.1.aux.0.value^${DBToFaderValue(-19)}`,
    ]);
  });
  it('represents an observed closed fader as -inf, never as missing data', async () => {
    const s = await setup();
    s.respond(() => s.fake.last().deliver('SETD^i.1.aux.0.value^0'));
    const result = await s.apply(s.preview().proposal!.id);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      confirmation: {
        status: 'unconfirmed',
        reason: 'different_value',
        observed: '-inf',
      },
    });
    expect(s.c.peekUndo()).toBeUndefined();
    expect(s.fake.last().commands()).toHaveLength(1);
  });
});

describe('HTTP + existing WebSocket boundary', () => {
  it('shares real operator authentication, explicit mode and human confirmation, with no PIN changes', async () => {
    const s = await setup();
    s.echo();
    const app = await buildHttp(s.core);
    cleanup.push(() => app.close());
    const headers = { authorization: `Bearer ${s.operatorToken}` };
    const payload = {
      targetMode: 'real',
      serverId: s.core.serverId,
      channel: 2,
      aux: 1,
      deltaDB: 1,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ui16/aux/preview',
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ui16/aux/preview',
          headers: { authorization: `Bearer ${s.musicianToken}` },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ui16/aux/preview',
          headers: { ...headers, origin: 'https://untrusted.invalid' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ui16/aux/preview',
          headers,
          payload: { ...payload, targetMode: 'lab' },
        })
      ).statusCode,
    ).toBe(400);
    const preview = (
      await app.inject({
        method: 'POST',
        url: '/api/ui16/aux/preview',
        headers,
        payload,
      })
    ).json();
    const denied = await app.inject({
      method: 'POST',
      url: `/api/ui16/aux/${preview.proposal.id}/confirm`,
      headers,
      payload: { ...s.confirmation(), humanConfirmed: false },
    });
    expect(denied.statusCode).toBe(400);
    expect(s.fake.last().commands()).toHaveLength(0);
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/ui16/aux/${preview.proposal.id}/confirm`,
      headers,
      payload: s.confirmation(),
    });
    expect(confirmed.json().confirmation.status).toBe('observed_target');
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = await wsClient(base, s.operatorToken);
    cleanup.push(async () => {
      ws.ws.close();
      await ws.closed;
    });
    ws.ws.send(
      JSON.stringify({
        type: 'command',
        requestId: 'raw-ws',
        targetMode: 'real',
        command: { type: 'set_level', channel: 2, aux: 1, deltaDB: -1 },
      }),
    );
    const deniedWs = await ws.next(
      (m) => m.type === 'result' && m.requestId === 'raw-ws',
    );
    expect(deniedWs.result.ok).toBe(false);
    expect(s.fake.last().commands()).toHaveLength(1);
  });
});
