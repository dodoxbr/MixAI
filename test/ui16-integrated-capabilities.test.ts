import { afterEach, expect, it, vi } from 'vitest';
import type { ParamKey, ParamValue } from '../src/core/revisions.js';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import { controlFrame, type Ui16ControlGates } from '../src/mixer/ui16-controls.js';
import { processingFrame } from '../src/mixer/ui16-processing.js';
import { Ui16ProcessingService } from '../src/server/ui16-processing/service.js';
import { realControlsFor } from '../src/server/first-real-aux/service.js';
import { MixController } from '../src/core/controller.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseConfig } from '../src/core/config.js';
import { ActionLog } from '../src/core/log.js';
import { Auth } from '../src/server/auth.js';
import { hashPin } from '../src/server/pin.js';
import { ServerCore } from '../src/server/core.js';
import type { Intent } from '../src/assistant/intent.js';
import { fixtureChannels } from './helpers.js';
import { createFakeUi, stateMessages, waitFor } from './support/fake-ui-socket.js';
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
const opHash = hashPin('4321'),
  musHash = hashPin('1357');
const cases = [
  {
    category: 'pa_level',
    key: 'ch.2.main.level',
    previous: -10,
    target: -9,
    intent: { type: 'level', channel: 2, dest: 'pa', deltaDB: 1 },
  },
  {
    category: 'pa_mute',
    key: 'ch.2.main.mute',
    previous: false,
    target: true,
    intent: { type: 'mute', channels: [2], dest: 'pa', muted: true },
  },
  {
    category: 'aux_level',
    key: 'ch.2.aux.1.level',
    previous: -20,
    target: -19,
    intent: { type: 'level', channel: 2, dest: 'fones', aux: 1, deltaDB: 1 },
  },
  {
    category: 'aux_mute',
    key: 'ch.2.aux.1.mute',
    previous: false,
    target: true,
    intent: { type: 'mute', channels: [2], dest: 'fones', aux: 1, muted: true },
  },
  { category: 'processing', key: 'ch.2.eq.b1.gain', previous: 0, target: 1 },
  { category: 'processing', key: 'ch.2.eq.hpf.freq', previous: 80, target: 100 },
] as const;
type Scenario = (typeof cases)[number];
type Category = Scenario['category'];
const categories = ['pa_level', 'pa_mute', 'aux_level', 'aux_mute', 'processing'] as const;
async function setup(
  enabled: readonly Category[] = categories,
  opts: { legacy?: boolean; timeout?: number; short?: Category } = {},
) {
  let time = 0,
    wall = 1_000_000;
  const routes = Object.fromEntries(categories.map((c) => [c, true])) as Record<Category, boolean>;
  const required: ParamKey[] = [
    'master.level',
    ...cases.filter((c) => c.category !== 'processing').map((c) => c.key),
  ];
  const fake = createFakeUi({
    initialState: () => [
      'SETS^model^ui16',
      'SETD^i.1.stereoIndex^-1',
      'SETD^a.0.stereoIndex^-1',
      ...stateMessages({ channels: [1, 2], aux: [1] }),
      ...cases
        .filter((c) => c.category === 'processing')
        .map((c) => processingFrame(c.key, c.previous).slice(4)),
      'SETD^i.1.eq.bypass^0',
    ],
  });
  const gate = (category: Category) => ({
    validation: 'simulated_transport' as const,
    validationReference: 'cross-category-fixture-' + category,
    routeGuard: () => routes[category],
    freshnessMs: opts.short === category ? 40 : 1000,
    confirmationTimeoutMs: opts.timeout ?? 500,
  });
  const controls: Ui16ControlGates = {};
  for (const c of categories)
    if (c !== 'processing' && enabled.includes(c) && !(opts.legacy && c === 'aux_level'))
      controls[c] = gate(c);
  const bridge = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: required,
    watchedKeys: required,
    webSocketCtor: fake.Ctor,
    clock: () => time,
    reconnectBaseMs: 5,
    reconnectMaxDelayMs: 10,
    realControls: controls,
    ...(enabled.includes('processing') ? { processingGate: gate('processing') } : {}),
    ...(opts.legacy && enabled.includes('aux_level') ? { firstRealAux: gate('aux_level') } : {}),
  });
  close.push(() => bridge.disconnect());
  const log = new ActionLog(null);
  const controller = new MixController(
    bridge,
    parseConfig({ safety: { maxActionsPerSecond: 100 } }).safety,
    new ChannelMap(fixtureChannels(), bridge.capabilities()),
    log,
    () => wall,
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
  const login = auth.login('4321', 'fixture');
  if (!login.ok) throw Error('fixture login');
  const control = realControlsFor(core),
    processing = new Ui16ProcessingService(core, () => wall);
  await bridge.connect();
  await waitFor(() => bridge.link() === 'READY');
  const socket = fake.last(),
    send = socket.send.bind(socket);
  let respond: ((frame: string) => void) | undefined;
  let outstanding = 0,
    maxOutstanding = 0;
  socket.send = (frame: string) => {
    send(frame);
    if (frame.startsWith('3:::SETD')) {
      outstanding++;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      respond?.(frame);
    }
  };
  const echo = () =>
    (respond = (frame) => {
      setTimeout(() => {
        outstanding--;
        socket.deliver(frame.slice(4));
      }, 2);
    });
  const input = (requestId: string) => ({
    targetMode: 'real',
    serverId: core.serverId,
    requestId,
    humanConfirmed: true,
  });
  const preview = (c: Scenario) =>
    ('intent' in c
      ? control.previewIntent(login.principal, c.intent as Intent)
      : processing.preview(login.principal, {
          targetMode: 'real',
          serverId: core.serverId,
          key: c.key,
          value: c.target,
        })) as any;
  const confirm = (c: Scenario, id: string, requestId: string) =>
    ('intent' in c
      ? control.apply(login.principal, id, input(requestId))
      : processing.confirm(login.principal, id, input(requestId))) as Promise<any>;
  return {
    bridge,
    core,
    controller,
    auth,
    control,
    processing,
    op: login.principal,
    token: login.token,
    fake,
    socket,
    echo,
    input,
    preview,
    confirm,
    respond: (fn: (frame: string) => void) => (respond = fn),
    route: (category: Category, value: boolean) => (routes[category] = value),
    age: (ms: number) => {
      time += ms;
      wall += ms;
    },
    maxOutstanding: () => maxOutstanding,
    frames: () => socket.commands(),
  };
}
it('all categories execute and undo sequentially on one simulated bridge and the sole executor', async () => {
  const s = await setup();
  s.echo();
  const expected: string[] = [];
  for (const [i, c] of cases.entries()) {
    const pr = s.preview(c);
    expect(pr.proposal).toBeDefined();
    expect(s.frames()).toHaveLength(i);
    const reply = await s.confirm(c, pr.proposal.id, 'apply-' + i);
    expect(reply.result.ok).toBe(true);
    expect(reply.confirmation).toMatchObject({
      category: c.category,
      status: 'observed_target',
      previous: c.previous,
      requested: c.target,
      causalAcknowledgement: false,
      validation: 'simulated_transport',
    });
    expect(s.bridge.read(c.key)).toEqual({ known: true, value: c.target });
    expected.push(
      (c.category === 'processing'
        ? processingFrame(c.key, c.target)
        : controlFrame(c.key, c.target)!
      ).slice(4),
    );
  }
  for (const [i, c] of [...cases].reverse().entries()) {
    const pr =
      c.category === 'processing'
        ? s.processing.preview(s.op, { targetMode: 'real', serverId: s.core.serverId, undo: true })
        : s.control.previewIntent(s.op, { type: 'undo' });
    const result = await s.confirm(c, (pr as any).proposal.id, 'undo-' + i);
    expect(result.result.ok).toBe(true);
    expect(s.bridge.read(c.key)).toEqual({ known: true, value: c.previous });
    expected.push(
      (c.category === 'processing'
        ? processingFrame(c.key, c.previous)
        : controlFrame(c.key, c.previous)!
      ).slice(4),
    );
  }
  expect(s.frames()).toEqual(expected);
  expect(s.maxOutstanding()).toBe(1);
  expect(s.controller.peekUndo()).toBeUndefined();
});
it.each(categories)(
  'enabling only %s never grants another category on the same instance',
  async (enabled) => {
    const s = await setup([enabled]);
    for (const c of cases) {
      expect(!!s.preview(c).proposal).toBe(c.category === enabled);
      expect(s.bridge.auxHandshake.enabled(c.key)).toBe(
        c.category === enabled && enabled !== 'processing',
      );
      expect(s.bridge.processingHandshake.enabled(c.key)).toBe(
        c.category === 'processing' && enabled === 'processing',
      );
      if (c.category !== enabled) await expect(s.bridge.write(c.key, c.target)).rejects.toThrow();
    }
    for (const h of [s.bridge.auxHandshake, s.bridge.processingHandshake])
      expect(h.enabled('master.level')).toBe(false);
    expect(s.frames()).toHaveLength(0);
  },
);
it('no category is enabled by default, even though all current inputs are observed', async () => {
  const s = await setup([]);
  expect(s.bridge.identity().physicalWrite).toBe('blocked');
  for (const c of cases) {
    expect(s.bridge.read(c.key)).toEqual({ known: true, value: c.previous });
    expect(s.preview(c).proposal).toBeUndefined();
    await expect(s.bridge.write(c.key, c.target)).rejects.toThrow();
  }
  expect(s.frames()).toHaveLength(0);
});
it('legacy #101 AUX bootstrap remains AUX-level-only beside the processing gate', async () => {
  const s = await setup(['aux_level', 'processing'], { legacy: true });
  s.echo();
  const legacy = s.control.preview(s.op, {
    targetMode: 'real',
    serverId: s.core.serverId,
    channel: 2,
    aux: 1,
    deltaDB: 0.5,
  }) as any;
  expect(
    ((await s.control.apply(s.op, legacy.proposal.id, s.input('legacy'))) as any).result.ok,
  ).toBe(true);
  expect(s.preview(cases[0]).proposal).toBeUndefined();
  expect(s.preview(cases[3]).proposal).toBeUndefined();
  const pr = s.preview(cases[4]);
  expect((await s.confirm(cases[4], pr.proposal.id, 'processing')).result.ok).toBe(true);
  expect(s.frames()).toHaveLength(2);
});
it('mixed concurrent proposals remain serialized, not parallel writes through the two handshakes', async () => {
  const s = await setup();
  s.echo();
  const prs = cases.map((c) => s.preview(c).proposal);
  const replies = await Promise.all(
    cases.map((c, i) => s.confirm(c, prs[i].id, 'concurrent-' + i)),
  );
  expect(replies.every((r) => r.result.ok)).toBe(true);
  expect(s.frames()).toHaveLength(cases.length);
  expect(s.maxOutstanding()).toBe(1);
});
it('confirmation IDs and undo cannot cross from controls into processing or vice versa', async () => {
  const s = await setup();
  s.echo();
  const pa = s.preview(cases[0]),
    eq = s.preview(cases[4]);
  expect(
    ((await s.processing.confirm(s.op, pa.proposal.id, s.input('wrong'))) as any).result.ok,
  ).toBe(false);
  expect(((await s.control.apply(s.op, eq.proposal.id, s.input('wrong'))) as any).result.ok).toBe(
    false,
  );
  expect(s.frames()).toHaveLength(0);
  await s.confirm(cases[0], pa.proposal.id, 'pa');
  expect(
    (
      s.processing.preview(s.op, {
        targetMode: 'real',
        serverId: s.core.serverId,
        undo: true,
      }) as any
    ).result.ok,
  ).toBe(false);
  await s.confirm(cases[4], eq.proposal.id, 'eq');
  expect(s.control.previewIntent(s.op, { type: 'undo' }).proposal).toBeUndefined();
  expect(s.frames()).toHaveLength(2);
});
it.each(['pa_level', 'processing'] as const)(
  'the %s freshness limit is not borrowed from another enabled gate',
  async (short) => {
    const s = await setup(categories, { short });
    s.age(41);
    for (const c of cases) expect(!!s.preview(c).proposal).toBe(c.category !== short);
    expect(s.frames()).toHaveLength(0);
  },
);
it('a failed processing route does not confer or revoke unrelated control-category permissions', async () => {
  const s = await setup();
  s.route('processing', false);
  expect(s.preview(cases[4]).proposal).toBeUndefined();
  expect(s.preview(cases[0]).proposal).toBeDefined();
  s.route('pa_level', false);
  expect(s.preview(cases[0]).proposal).toBeUndefined();
  expect(s.preview(cases[2]).proposal).toBeDefined();
  expect(s.frames()).toHaveLength(0);
});
it('a processing sample cannot confirm a PA mute with the same boolean target', async () => {
  const s = await setup(categories, { timeout: 30 });
  const pr = s.preview(cases[1]);
  s.respond(() => setTimeout(() => s.socket.deliver('SETD^i.1.eq.bypass^1'), 2));
  const reply = await s.confirm(cases[1], pr.proposal.id, 'mismatch');
  expect(reply.result.ok).toBe(false);
  expect(reply.confirmation.status).toBe('unconfirmed');
  expect(s.frames()).toHaveLength(1);
});
it('revocation rejects both services and cancels confirmation without replay across categories', async () => {
  const s = await setup();
  const pa = s.preview(cases[0]),
    eq = s.preview(cases[4]);
  s.respond((frame) =>
    setTimeout(() => {
      s.auth.logout(s.token);
      s.socket.deliver(frame.slice(4));
    }, 2),
  );
  expect((await s.confirm(cases[0], pa.proposal.id, 'pa')).result.ok).toBe(false);
  expect((await s.confirm(cases[4], eq.proposal.id, 'eq')).result.ok).toBe(false);
  expect(s.frames()).toHaveLength(1);
});
it('a processing permit cannot be issued for a level/mute key even with all gates present', async () => {
  const s = await setup();
  const sample = s.bridge.auxHandshake.current(cases[0].key)!;
  expect(() =>
    s.bridge.processingHandshake.authorize({
      id: 'invalid',
      key: cases[0].key,
      previous: sample,
      requested: cases[0].target,
      authorized: () => true,
    }),
  ).toThrow();
  const eq = s.bridge.processingHandshake.current(cases[4].key)!;
  expect(() =>
    s.bridge.auxHandshake.authorize({
      id: 'invalid',
      key: cases[4].key,
      previous: eq,
      requested: cases[4].target,
      authorized: () => true,
    }),
  ).toThrow();
  expect(s.frames()).toHaveLength(0);
});
