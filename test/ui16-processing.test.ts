import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import {
  processingFrame,
  processingRaw,
  processingSpec,
  processingValue,
  validProcessingValue,
} from '../src/mixer/ui16-processing.js';
import { Ui16ProcessingService } from '../src/server/ui16-processing/service.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import { Auth } from '../src/server/auth.js';
import { hashPin } from '../src/server/pin.js';
import { ServerCore } from '../src/server/core.js';
import { buildHttp } from '../src/server/http.js';
import type { ParamKey, ParamValue } from '../src/core/revisions.js';
import { fixtureChannels } from './helpers.js';
import { createFakeUi, stateMessages, waitFor } from './support/fake-ui-socket.js';
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of clean.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});
const opHash = hashPin('4321'),
  musHash = hashPin('1357');
const keys: ParamKey[] = [];
for (const b of [1, 2, 3, 4] as const)
  for (const f of ['freq', 'gain', 'q'] as const) keys.push(`ch.2.eq.b${b}.${f}`);
keys.push('ch.2.eq.hpf.freq', 'ch.2.eq.bypass');
const original = (key: ParamKey): ParamValue =>
  key.endsWith('bypass')
    ? false
    : key.endsWith('.gain')
      ? 0
      : key.endsWith('.q')
        ? 1
        : key.endsWith('hpf.freq')
          ? 80
          : 1000;
async function setup(
  options: {
    enabled?: boolean;
    noProcessing?: boolean;
    mono?: boolean;
    model?: boolean;
    timeout?: number;
  } = {},
) {
  let monotonic = 0,
    wall = 1_000_000,
    route = true;
  const required: ParamKey[] = ['ch.2.main.level', 'ch.2.main.mute', 'master.level'];
  const fake = createFakeUi({
    initialState: () => [
      ...(options.model === false ? [] : ['SETS^model^ui16']),
      ...(options.mono === false ? [] : ['SETD^i.1.stereoIndex^-1']),
      ...stateMessages({ channels: [1, 2], aux: [1] }),
      ...(options.noProcessing ? [] : keys.map((k) => processingFrame(k, original(k)).slice(4))),
    ],
  });
  const bridge = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: required,
    watchedKeys: required,
    webSocketCtor: fake.Ctor,
    clock: () => monotonic,
    reconnectBaseMs: 5,
    reconnectMaxDelayMs: 10,
    ...(options.enabled === false
      ? {}
      : {
          processingGate: {
            validation: 'simulated_transport' as const,
            validationReference: 'processing-fixture-v1',
            routeGuard: () => route,
            freshnessMs: 1000,
            confirmationTimeoutMs: options.timeout ?? 500,
          },
        }),
  });
  clean.push(() => bridge.disconnect());
  const log = new ActionLog(null);
  const controller = new MixController(
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
  const core = new ServerCore(controller, bridge, 'real', auth, log, {
    musicianAux: 1,
    clock: () => wall,
  });
  await bridge.connect();
  await waitFor(() => bridge.link() === 'READY');
  const login = auth.login('4321', 'fixture'),
    musician = auth.login('1357', 'fixture');
  if (!login.ok || !musician.ok) throw Error('fixture login');
  const service = new Ui16ProcessingService(core, () => wall);
  const socket = fake.last(),
    send = socket.send.bind(socket);
  let response: ((frame: string) => void) | undefined;
  socket.send = (frame: string) => {
    send(frame);
    if (frame.startsWith('3:::SETD')) response?.(frame);
  };
  const preview = (key: string = 'ch.2.eq.b1.gain', value: ParamValue = 1, extra: object = {}) =>
    service.preview(login.principal, {
      targetMode: 'real',
      serverId: core.serverId,
      key,
      value,
      ...extra,
    }) as any;
  const confirmation = (requestId = 'attempt') => ({
    targetMode: 'real',
    serverId: core.serverId,
    requestId,
    humanConfirmed: true,
  });
  const confirm = (id: string, requestId = 'attempt') =>
    service.confirm(login.principal, id, confirmation(requestId)) as Promise<any>;
  return {
    bridge,
    core,
    controller,
    auth,
    service,
    socket,
    fake,
    log,
    op: login.principal,
    mus: musician.principal,
    token: login.token,
    musToken: musician.token,
    preview,
    confirm,
    confirmation,
    echo: () =>
      (response = (frame) => {
        setTimeout(() => socket.deliver(frame.slice(4)), 2);
      }),
    respond: (f: (frame: string) => void) => (response = f),
    age: (ms: number) => {
      wall += ms;
      monotonic += ms;
    },
    route: (v: boolean) => (route = v),
    frames: () => socket.sent.filter((f) => f.startsWith('3:::SETD')),
  };
}
describe('Ui16 processing: real library, injected transport only', () => {
  for (const key of keys)
    it(`one proven setter + independent observation + explicit reversal: ${key}`, async () => {
      const s = await setup();
      const value = key.endsWith('bypass')
        ? true
        : key.endsWith('.gain')
          ? 1
          : key.endsWith('.q')
            ? 1.2
            : key.endsWith('hpf.freq')
              ? 100
              : 1200;
      const pre = s.preview(key, value);
      expect(pre.proposal).toMatchObject({
        previous: original(key),
        target: value,
        reverse: { key, value: original(key) },
        requiresHumanConfirmation: true,
        scope: 'input_channel_processing_not_destination_specific',
      });
      expect(s.frames()).toHaveLength(0);
      s.echo();
      const applied = await s.confirm(pre.proposal.id);
      expect(applied.result.ok).toBe(true);
      expect(applied.confirmation).toMatchObject({
        status: 'observed_target',
        causalAcknowledgement: false,
        source: 'independent_socket_input',
        validation: 'simulated_transport',
      });
      expect(s.frames()).toEqual([processingFrame(key, value)]);
      expect(s.bridge.read(key)).toEqual({ known: true, value });
      const undo = s.service.preview(s.op, {
        targetMode: 'real',
        serverId: s.core.serverId,
        undo: true,
      }) as any;
      expect(undo.proposal.target).toBe(original(key));
      const undone = await s.confirm(undo.proposal.id, 'undo');
      expect(undone.result.ok, JSON.stringify(undone)).toBe(true);
      expect(s.frames()).toEqual([
        processingFrame(key, value),
        processingFrame(key, original(key)),
      ]);
    });
  it('default bootstrap is read-only; cannot counterfeit simulation with the real transport', async () => {
    const s = await setup({ enabled: false });
    expect(s.preview().result.ok).toBe(false);
    expect(s.service.state(s.op, 2)).toMatchObject({
      physicalWriteEnabled: false,
      capabilities: { hpf: { slope: false }, lpf: false, compressor: 'unavailable_library_facade' },
    });
    await expect(s.bridge.write('ch.2.eq.b1.gain', 1)).rejects.toThrow(
      'BRIDGE_PHYSICAL_WRITE_UNVALIDATED',
    );
    expect(
      () =>
        new Ui16RealBridge({
          ip: 'fixture.invalid',
          requiredKeys: [],
          watchedKeys: [],
          processingGate: {
            validation: 'simulated_transport',
            validationReference: 'fixture',
            routeGuard: () => true,
          },
        }),
    ).toThrow('PROCESSING_SIMULATION_REQUIRES_INJECTED_TRANSPORT');
    expect(s.frames()).toHaveLength(0);
  });
  it.each([
    'ch.2.eq.hpf.slope',
    'ch.2.eq.lpf.freq',
    'ch.2.compressor.threshold',
    'ch.2.gate.threshold',
    'ch.2.deesser.frequency',
    'ch.2.eq.b5.gain',
    'ch.13.eq.b1.gain',
    'master.level',
    'ch.2.aux.1.level',
  ])('rejects unsupported parameter %s', async (key) => {
    const s = await setup();
    expect(s.preview(key, 1).result.ok).toBe(false);
    expect(s.frames()).toHaveLength(0);
  });
  it.each([
    ['ch.2.eq.b1.gain', 7],
    ['ch.2.eq.b1.gain', -7],
    ['ch.2.eq.b1.gain', 2],
    ['ch.2.eq.b1.gain', 0.15],
    ['ch.2.eq.b1.freq', 10],
    ['ch.2.eq.b1.freq', 22050],
    ['ch.2.eq.b1.freq', 1000.1],
    ['ch.2.eq.b1.q', 0],
    ['ch.2.eq.b1.q', 11],
    ['ch.2.eq.b1.q', 3],
    ['ch.2.eq.hpf.freq', 301],
    ['ch.2.eq.bypass', 1],
    ['ch.2.eq.b1.gain', true],
    ['ch.2.eq.b1.gain', NaN],
    ['ch.2.eq.b1.gain', Infinity],
  ])('rejects invalid/out-of-policy %s=%s', async (key, value) => {
    const s = await setup();
    expect(s.preview(key as string, value as ParamValue).result.ok).toBe(false);
    expect(s.frames()).toHaveLength(0);
  });
  it('HPF bypass is a 20 Hz frequency write, never a bypass/slope setter; undo explicitly restores the observed frequency', async () => {
    const s = await setup();
    s.echo();
    const pre = s.preview('ch.2.eq.hpf.freq', 20);
    expect((await s.confirm(pre.proposal.id)).result.ok).toBe(true);
    expect(s.service.state(s.op, 2)).toMatchObject({
      hpfBypass: { state: 'derived', value: true, basis: 'frequency_20_hz' },
    });
    const undo = s.service.preview(s.op, {
      targetMode: 'real',
      serverId: s.core.serverId,
      undo: true,
    }) as any;
    expect(undo.proposal.target).toBe(80);
    expect((await s.confirm(undo.proposal.id, 'undo')).result.ok).toBe(true);
  });
  it.each([{ noProcessing: true }, { mono: false }, { model: false }])(
    'refuses missing current evidence %j',
    async (options) => {
      const s = await setup(options);
      expect(s.preview().result.ok).toBe(false);
      expect(s.frames()).toHaveLength(0);
    },
  );
  it('stale data cannot authorize a write or masquerade as current state', async () => {
    const s = await setup();
    s.age(1001);
    expect(s.preview().result.ok).toBe(false);
    expect(s.service.state(s.op, 2)).toMatchObject({
      parameters: { 'ch.2.eq.b1.gain': { state: 'stale', value: undefined } },
    });
    expect(s.frames()).toHaveLength(0);
  });
  it('assistant proposals are consultative, explicit and never auto-executed; operator must confirm', async () => {
    const s = await setup();
    const pre = s.preview('ch.2.eq.b1.gain', 1, { source: 'assistant' });
    expect(pre.proposal.source).toBe('assistant');
    expect(s.frames()).toHaveLength(0);
    expect(
      await s.service.confirm(s.op, pre.proposal.id, {
        ...s.confirmation(),
        humanConfirmed: false,
      }),
    ).toMatchObject({ result: { ok: false, code: 'FORBIDDEN' } });
    expect(
      s.service.preview(s.mus, {
        targetMode: 'real',
        serverId: s.core.serverId,
        key: 'ch.2.eq.b1.gain',
        value: 1,
      }),
    ).toMatchObject({ result: { ok: false, code: 'FORBIDDEN' } });
    expect(
      (
        await s.core.execute(s.op, {
          requestId: 'direct',
          command: { type: 'set_processing', key: 'ch.2.eq.b1.gain', value: 1 },
        })
      ).result.ok,
    ).toBe(false);
    expect(s.frames()).toHaveLength(0);
  });
  it('duplicate requests consume exactly one authorization; a different requestId cannot replay it', async () => {
    const s = await setup();
    s.echo();
    const pre = s.preview();
    const a = s.confirm(pre.proposal.id),
      b = s.confirm(pre.proposal.id);
    expect(await a).toEqual(await b);
    expect((await s.confirm(pre.proposal.id, 'different')).result.code).toBe('CONFIRMATION_USED');
    expect(s.frames()).toHaveLength(1);
  });
  it('external changes, expired proposals, route mismatch and session revocation refuse before sending', async () => {
    for (const fault of ['external', 'expired', 'route', 'revoked'] as const) {
      const s = await setup();
      const pre = s.preview();
      if (fault === 'external') s.socket.deliver(processingFrame('ch.2.eq.b1.gain', -1).slice(4));
      if (fault === 'expired') s.age(15001);
      if (fault === 'route') s.route(false);
      if (fault === 'revoked') s.auth.logout(s.token);
      expect((await s.confirm(pre.proposal.id)).result.ok).toBe(false);
      expect(s.frames()).toHaveLength(0);
    }
  });
  it('cancel and cross-session confirmation cannot execute a proposal', async () => {
    const s = await setup();
    const pre = s.preview();
    const other = s.auth.login('4321', 'other');
    if (!other.ok) throw Error('fixture');
    expect(
      await s.service.confirm(other.principal, pre.proposal.id, s.confirmation()),
    ).toMatchObject({ result: { ok: false } });
    s.service.cancel(s.op, pre.proposal.id);
    expect((await s.confirm(pre.proposal.id)).result.ok).toBe(false);
    expect(s.frames()).toHaveLength(0);
  });
  it('outgoing library cache echo is not independent confirmation; timeout fences the parameter', async () => {
    const s = await setup({ timeout: 20 });
    const pre = s.preview();
    const result = await s.confirm(pre.proposal.id);
    expect(result.result.ok).toBe(false);
    expect(result.confirmation.status).toBe('unconfirmed');
    expect(s.bridge.reading('ch.2.eq.b1.gain').state).toBe('stale');
    expect(s.preview().result.ok).toBe(false);
    expect(s.frames()).toHaveLength(1);
  });
  it.each(['different', 'disconnect', 'revoke', 'stereo'] as const)(
    'in-flight %s produces no false success or retry',
    async (fault) => {
      const s = await setup();
      const pre = s.preview();
      s.respond((frame) => {
        setTimeout(() => {
          if (fault === 'disconnect') s.socket.drop();
          else if (fault === 'revoke') {
            s.auth.logout(s.token);
            s.socket.deliver(frame.slice(4));
          } else if (fault === 'stereo')
            s.socket.deliver('SETD^i.1.stereoIndex^0\n' + frame.slice(4));
          else s.socket.deliver(processingFrame('ch.2.eq.b1.gain', -1).slice(4));
        }, 2);
      });
      const result = await s.confirm(pre.proposal.id);
      expect(result.result.ok).toBe(false);
      expect(result.confirmation.status).toBe('unconfirmed');
      expect(s.frames()).toHaveLength(1);
    },
  );
  it('queued permission and revision are revalidated, not captured only when previewing', async () => {
    const s = await setup();
    const pre = s.preview();
    const original = s.core.execute.bind(s.core);
    vi.spyOn(s.core, 'execute').mockImplementation(async (...args) => {
      s.auth.logout(s.token);
      return original(...args);
    });
    expect((await s.confirm(pre.proposal.id)).result.ok).toBe(false);
    expect(s.frames()).toHaveLength(0);
  });
  it('undo cannot erase an external mixer edit or revert unknown state', async () => {
    const s = await setup();
    s.echo();
    const pre = s.preview();
    await s.confirm(pre.proposal.id);
    const undo = s.service.preview(s.op, {
      targetMode: 'real',
      serverId: s.core.serverId,
      undo: true,
    }) as any;
    s.socket.deliver(processingFrame('ch.2.eq.b1.gain', -1).slice(4));
    expect((await s.confirm(undo.proposal.id, 'undo')).result.ok).toBe(false);
    expect(s.frames()).toHaveLength(1);
  });
  it('HTTP uses existing authentication and strict single-parameter payloads', async () => {
    const s = await setup();
    const app = await buildHttp(s.core);
    await app.listen({ host: '127.0.0.1', port: 0 });
    clean.push(() => app.close());
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const req = (path: string, token?: string, body?: object) =>
      fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await req('/api/ui16/processing/2')).status).toBe(401);
    expect((await req('/api/ui16/processing/2', s.musToken)).status).toBe(403);
    expect((await req('/api/ui16/processing/2', s.token)).status).toBe(200);
    const input = {
      targetMode: 'real',
      serverId: s.core.serverId,
      key: 'ch.2.eq.b1.gain',
      value: 1,
    };
    expect(
      (
        await req('/api/ui16/processing/preview', s.token, {
          ...input,
          values: { 'ch.2.eq.b2.gain': 1 },
        })
      ).status,
    ).toBe(400);
    const pre = (await (await req('/api/ui16/processing/preview', s.token, input)).json()) as any;
    s.echo();
    expect(
      (
        (await (
          await req(`/api/ui16/processing/${pre.proposal.id}/confirm`, s.token, s.confirmation())
        ).json()) as any
      ).result.ok,
    ).toBe(true);
    expect(s.frames()).toHaveLength(1);
  });
});
it('range boundaries use exact library conversions, not guessed protocol constants', () => {
  for (const key of keys) {
    const spec = processingSpec(key)!;
    for (const value of spec.range ?? [false, true]) {
      expect(validProcessingValue(key, value)).toBe(true);
      expect(processingValue(key, processingRaw(key, value))).toBe(value);
    }
  }
});
it('ordinary undo cannot consume a REAL processing reversal without its own fresh confirmation', async () => {
  const s = await setup();
  s.echo();
  await s.confirm(s.preview().proposal.id);
  const before = s.controller.peekUndo();
  expect(
    (await s.core.execute(s.op, { requestId: 'unapproved-undo', command: { type: 'undo' } })).result
      .code,
  ).toBe('FORBIDDEN');
  expect(s.controller.peekUndo()?.id).toBe(before?.id);
  expect(s.frames()).toHaveLength(1);
});
it('serializes different parameters in the sole executor, and rejects concurrent stale proposals for one parameter', async () => {
  const s = await setup();
  s.echo();
  const a = s.preview(),
    b = s.preview('ch.2.eq.b2.gain', 1),
    stale = s.preview();
  const replies = await Promise.all([
    s.confirm(a.proposal.id),
    s.confirm(b.proposal.id),
    s.confirm(stale.proposal.id),
  ]);
  expect(replies[0].result.ok).toBe(true);
  expect(replies[1].result.ok).toBe(true);
  expect(replies[2].result.ok).toBe(false);
  expect(s.frames()).toHaveLength(2);
});
it('late input cannot retroactively confirm or replay an expired operation', async () => {
  const s = await setup({ timeout: 20 });
  const pre = s.preview();
  const result = await s.confirm(pre.proposal.id);
  s.socket.deliver(processingFrame('ch.2.eq.b1.gain', 1).slice(4));
  expect(result.confirmation.status).toBe('unconfirmed');
  expect((await s.confirm(pre.proposal.id)).confirmation.status).toBe('unconfirmed');
  expect(s.frames()).toHaveLength(1);
});
it('invalid inbound HPF and boolean samples close the session instead of inventing valid readings', async () => {
  for (const [key, raw] of [
    ['ch.2.eq.hpf.freq', 1],
    ['ch.2.eq.bypass', 0.5],
  ] as const) {
    const s = await setup();
    s.socket.deliver(`SETD^i.1.${key.split('.').slice(2).join('.')}^${raw}`);
    expect(s.bridge.reading(key)).toMatchObject({ state: 'unavailable', reason: 'invalid_sample' });
    expect(s.preview().result.ok).toBe(false);
    expect(s.frames()).toHaveLength(0);
  }
});
it('library setter bypass without the exact queued permit is sealed before any frame leaves', async () => {
  const s = await setup();
  const ui = s.bridge.supervisor.currentUi()!;
  ui.master.input(2).eq.band(1).setGainDB(1);
  expect(s.frames()).toHaveLength(0);
  expect(s.bridge.link()).toBe('STOPPED');
});
it('send failures are indeterminate and never retried', async () => {
  const s = await setup();
  const pre = s.preview();
  s.respond(() => {
    throw Error('fixture post-send failure');
  });
  const result = await s.confirm(pre.proposal.id);
  expect(result.result.ok).toBe(false);
  expect(result.confirmation.status).toBe('unconfirmed');
  expect(s.frames()).toHaveLength(1);
});

it('failure before the one-frame gate consumes its permit is known not-sent', async () => {
  const s = await setup();
  const pre = s.preview();
  s.socket.send = () => {
    throw Error('fixture before gate');
  };
  const result = await s.confirm(pre.proposal.id);
  expect(result.result.ok).toBe(false);
  expect(result.confirmation.status).toBe('not_sent');
  expect(s.frames()).toHaveLength(0);
});
it('an unexpected executor failure cannot be labeled as certainly not-sent', async () => {
  const s = await setup();
  const pre = s.preview();
  vi.spyOn(s.core, 'execute').mockRejectedValueOnce(Error('fixture executor failure'));
  const result = await s.confirm(pre.proposal.id);
  expect(result.result.code).toBe('INDETERMINATE');
  expect(result.confirmation.status).toBe('unconfirmed');
});
it.each([0.0000001, 0.000000000001])(
  'rounded 20 Hz with raw %s cannot prove HPF bypass or an exact reversible origin',
  async (raw) => {
    const s = await setup();
    s.socket.deliver(`SETD^i.1.eq.hpf.freq^${raw}`);
    expect(s.service.state(s.op, 2)).toMatchObject({
      hpfBypass: { state: 'derived', value: false },
    });
    expect(s.preview('ch.2.eq.hpf.freq', 40).result.ok).toBe(false);
    expect(s.frames()).toHaveLength(0);
  },
);
it('a rounded inbound match is not an exact target observation', async () => {
  const s = await setup();
  const pre = s.preview('ch.2.eq.hpf.freq', 20);
  s.respond(() => {
    setTimeout(() => s.socket.deliver('SETD^i.1.eq.hpf.freq^0.0000001'), 2);
  });
  const result = await s.confirm(pre.proposal.id);
  expect(result.result.ok).toBe(false);
  expect(result.confirmation.status).toBe('unconfirmed');
  expect(s.frames()).toHaveLength(1);
});
it('revoked HTTP sessions receive no in-flight confirmation payload', async () => {
  const s = await setup();
  const app = await buildHttp(s.core);
  await app.listen({ host: '127.0.0.1', port: 0 });
  clean.push(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const previewResponse = await fetch(base + '/api/ui16/processing/preview', {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      targetMode: 'real',
      serverId: s.core.serverId,
      key: 'ch.2.eq.b1.gain',
      value: 1,
    }),
  });
  const pre = (await previewResponse.json()) as any;
  s.respond((frame) => {
    setTimeout(() => {
      s.auth.logout(s.token);
      s.socket.deliver(frame.slice(4));
    }, 2);
  });
  const res = await fetch(`${base}/api/ui16/processing/${pre.proposal.id}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(s.confirmation()),
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ code: 'UNAUTHORIZED' });
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(s.frames()).toHaveLength(1);
});
it('HTTP refuses MCP, foreign origins and confirmation flags smuggled into previews', async () => {
  const s = await setup();
  const app = await buildHttp(s.core);
  await app.listen({ host: '127.0.0.1', port: 0 });
  clean.push(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const input = { targetMode: 'real', serverId: s.core.serverId, key: 'ch.2.eq.b1.gain', value: 1 };
  const req = (token: string, body: object, origin?: string) =>
    fetch(base + '/api/ui16/processing/preview', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });
  expect((await req('fixture-agent', input)).status).toBe(403);
  expect((await req(s.token, input, 'https://foreign.invalid')).status).toBe(403);
  expect((await req(s.token, { ...input, humanConfirmed: true })).status).toBe(400);
  expect(s.frames()).toHaveLength(0);
});
