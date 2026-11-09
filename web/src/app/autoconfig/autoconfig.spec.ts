import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AutoConfigService, AUTO_ADAPTER } from './autoconfig.service';
import { AutoConfigComponent } from './autoconfig.component';
import { AutoConfigView, type AutoAdapter } from './autoconfig-contract';
import { AutoHttpError } from './autoconfig-http';
import { SessionService } from '../core/session.service';
import { LiveService } from '../core/live.service';
const context = { eventId: 'event-a', eventName: 'Ensaio', eventVersion: 1 };
// Canonical D fixtures exist exclusively in tests. Production reads the authenticated API.
function plan(state = 'proposed', version = 2): any {
  const p = {
    schemaVersion: 1,
    id: 'plan-000001',
    title: 'Revisar retorno',
    eventId: 'event-a',
    scope: 'AUX1',
    version,
    serverId: 'server-a',
    createdAt: '2026-11-09T00:00:00Z',
    expiresAt: '2035-11-09T00:10:00Z',
    state,
    items: [
      {
        spec: {
          id: 'test-000001',
          operation: 'level_delta',
          channel: 3,
          deltaDB: 1,
          rationale: 'Teste virtual humano',
          evidence: [{ kind: 'human_report', text: 'Relato humano' }],
        },
        state,
        questions: [],
        observation: { status: 'known', value: -10, revision: 7 },
        target: -9,
        digest: 'a'.repeat(64),
      },
    ],
    context: {
      mode: 'lab',
      serverId: 'server-a',
      revision: 7,
      origin: 'lab_simulation',
      realObservation: 'unavailable',
      acousticMeasurement: 'unavailable',
    },
    receipts: [],
    history: [],
    interrupted: false,
    stale: false,
    simulationOnly: true,
    availability: {
      context: 'known',
      realObservation: 'unavailable',
      acousticMeasurement: 'unavailable',
      reference: 'absent',
    },
    virtualState: {},
    counts: {},
  };
  if (['approved_for_lab', 'simulated', 'reviewed'].includes(state))
    Object.assign(p.items[0]!, {
      approval: {
        id: 'approval-00001',
        operatorSessionId: 'operator-001',
        scope: 'simulation_only',
        digest: 'a'.repeat(64),
        at: '2026-11-09T00:00:00Z',
      },
    });
  if (['simulated', 'reviewed'].includes(state))
    Object.assign(p.items[0]!, {
      result: {
        id: 'result-000001',
        origin: 'lab_simulation',
        before: -10,
        target: -9,
        after: -9,
        outcome: 'passed',
        verification: 'virtual_values_only',
        audioAnalysis: 'not_performed',
      },
    });
  return AutoConfigView.parse(p);
}
function boot(request = vi.fn<AutoAdapter['request']>().mockResolvedValue(plan())) {
  const token = signal<string | null>('session-a'),
    role = signal('operator'),
    hello = signal<any>({ role: 'operator', mode: 'lab', serverId: 'server-a' }),
    connection = signal('online'),
    state = signal<any>({ revision: 7 });
  const command = vi.fn(),
    expire = vi.fn(() => token.set(null));
  TestBed.configureTestingModule({
    providers: [
      { provide: AUTO_ADAPTER, useValue: { request } },
      { provide: SessionService, useValue: { token, role, expire } },
      {
        provide: LiveService,
        useValue: {
          hello,
          connection,
          state,
          command,
          channels: signal([{ number: 3, name: 'Voz' }]),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(AutoConfigComponent);
  fixture.componentRef.setInput('event', context);
  fixture.detectChanges();
  const ui = TestBed.inject(AutoConfigService);
  return { fixture, ui, token, role, hello, connection, state, command, expire, request };
}
async function create(ui: AutoConfigService) {
  ui.start();
  ui.answer('Clareza');
  ui.answer('3');
  ui.answer('AUX1');
  await ui.prepare('Voz baixa', 1);
}
it('creates only an unapproved server draft, asks individual questions and never prepares or approves automatically', async () => {
  const { ui, request, command } = boot();
  ui.start();
  ui.answer('Clareza');
  ui.answer('999');
  expect(ui.question()).toBe(1);
  ui.answer('3');
  ui.answer('MASTER');
  expect(ui.question()).toBe(2);
  ui.answer('AUX1');
  ui.back();
  expect(ui.question()).toBe(2);
  ui.answer('AUX1');
  await ui.prepare('Voz baixa', 0);
  expect(request).not.toHaveBeenCalled();
  await ui.prepare('Voz baixa', 1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toBe('/api/autoconfig');
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    scope: 'AUX1',
    items: [{ operation: 'level_delta', deltaDB: 1, channel: 3 }],
  });
  expect(request.mock.calls[0]?.[1]).not.toHaveProperty('approved');
  expect(command).not.toHaveBeenCalled();
});
it('click requests approval on the server; there is no optimistic authorization and rejected authorization cannot simulate', async () => {
  let resolve!: (v: unknown) => void;
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(plan())
    .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    .mockRejectedValueOnce(new AutoHttpError('FORBIDDEN'));
  const { ui } = boot(request);
  await create(ui);
  const pending = ui.approve('test-000001');
  expect(ui.status()['test-000001']).toBe('proposed');
  await ui.simulate('test-000001');
  expect(request).toHaveBeenCalledTimes(2);
  resolve(plan('approved_for_lab', 3));
  await pending;
  expect(ui.status()['test-000001']).toBe('approved');
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    action: 'approve',
    expectedVersion: 2,
    digest: 'a'.repeat(64),
    scope: 'simulation_only',
    expectedStateRevision: 7,
    confirmed: true,
  });
  await ui.simulate('test-000001');
  expect(ui.results()).toEqual({});
  expect(ui.needsRefresh()).toBe(true);
  expect(ui.error()).toContain('recusou');
});
it('uses server approvalId/version, never double-dispatches and accepts only server simulation results', async () => {
  let resolve!: (v: unknown) => void;
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(plan())
    .mockResolvedValueOnce(plan('approved_for_lab', 3))
    .mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  const { ui, command } = boot(request);
  await create(ui);
  await ui.approve('test-000001');
  const pending = ui.simulate('test-000001');
  await ui.simulate('test-000001');
  expect(request).toHaveBeenCalledTimes(3);
  expect(ui.status()['test-000001']).toBe('approved');
  expect(request.mock.calls[2]?.[1]).toMatchObject({
    action: 'simulate',
    approvalId: 'approval-00001',
    expectedVersion: 3,
  });
  resolve(plan('simulated', 5));
  await pending;
  expect(ui.results()['test-000001']).toMatchObject({ before: -10, after: -9 });
  expect(ui.status()['test-000001']).toBe('simulated');
  expect(command).not.toHaveBeenCalled();
});
it.each(['token', 'role', 'mode', 'server', 'event', 'offline'] as const)(
  'drops late server responses and private data after %s changes',
  async (change) => {
    let resolve!: (v: unknown) => void;
    const request = vi
      .fn<AutoAdapter['request']>()
      .mockResolvedValueOnce(plan())
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const b = boot(request);
    await create(b.ui);
    const pending = b.ui.approve('test-000001');
    if (change === 'token') b.token.set('other');
    if (change === 'role') b.role.set('musician');
    if (change === 'mode') b.hello.update((h) => ({ ...h, mode: 'real' }));
    if (change === 'server') b.hello.update((h) => ({ ...h, serverId: 'other-server' }));
    if (change === 'event')
      b.fixture.componentRef.setInput('event', { ...context, eventId: 'event-b' });
    if (change === 'offline') b.connection.set('offline');
    b.fixture.detectChanges();
    resolve(plan('approved_for_lab', 3));
    await pending;
    expect(b.ui.status()['test-000001']).not.toBe('approved');
    expect(b.ui.references()).toEqual([]);
    expect(b.ui.busy()).toBe(false);
  },
);
it('409 never replays actions; explicit server read is required to resume', async () => {
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(plan())
    .mockRejectedValueOnce(new AutoHttpError('CONFLICT'));
  const { ui } = boot(request);
  await create(ui);
  await ui.approve('test-000001');
  await ui.approve('test-000001');
  expect(request).toHaveBeenCalledTimes(2);
  expect(ui.needsRefresh()).toBe(true);
  expect(ui.error()).toContain('Conflito');
});
it('401 expires the existing session and raw errors are never rendered', async () => {
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockRejectedValueOnce(new AutoHttpError('UNAUTHORIZED'));
  const { ui, expire, fixture } = boot(request);
  await create(ui);
  expect(expire).toHaveBeenCalledOnce();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).not.toContain('Bearer');
});
it('validates strict D models, rejects acoustic claims, renders text without HTML and shows unavailable values', async () => {
  const p = plan();
  p.items[0].spec.rationale = '<img src=x onerror=alert(1)>';
  const { ui, fixture } = boot(vi.fn().mockResolvedValue(p));
  await create(ui);
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('img')).toBeNull();
  expect(fixture.nativeElement.textContent).toContain('<img');
  const invalid = plan();
  invalid.simulationOnly = false;
  expect(() => AutoConfigView.parse(invalid)).toThrow();
  const result = plan('simulated');
  result.items[0].result.audioAnalysis = 'performed';
  expect(() => AutoConfigView.parse(result)).toThrow();
});
it('state changes block mutation until a fresh read and explicit server preparation', async () => {
  const { ui, state, fixture, request } = boot();
  await create(ui);
  state.set({ revision: 8 });
  fixture.detectChanges();
  await ui.approve('test-000001');
  expect(request).toHaveBeenCalledTimes(1);
  expect(ui.needsRefresh()).toBe(true);
});
it('timeout aborts and never retries, including a late success', async () => {
  let resolve!: (v: unknown) => void;
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockImplementation(() => new Promise((r) => (resolve = r)));
  const { ui } = boot(request);
  vi.useFakeTimers();
  try {
    const pending = create(ui);
    await vi.advanceTimersByTimeAsync(10001);
    expect(ui.busy()).toBe(false);
    expect(ui.needsRefresh()).toBe(true);
    resolve(plan());
    await pending;
    expect(ui.model()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it('REAL is hidden and cannot request any API', async () => {
  const { ui, hello, fixture, request } = boot();
  hello.update((h) => ({ ...h, mode: 'real' }));
  fixture.detectChanges();
  await create(ui);
  expect(request).not.toHaveBeenCalled();
  expect(ui.eligible()).toBe(false);
});
it('review/save use server versions and display only a persisted, associated reference receipt', async () => {
  const saved = { ...plan('saved', 7), referenceId: 'reference-00001' };
  const workspace = {
    schemaVersion: 1,
    serverId: 'server-a',
    mode: 'lab',
    capabilities: { execution: 'virtual_only', realWrite: false },
    channels: [],
    plans: [saved],
  };
  const reference = {
    id: 'reference-00001',
    version: 1,
    validationStatus: 'UNVERIFIED',
    simulation: { planId: 'plan-000001', mode: 'lab', notApplied: true },
  };
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(plan())
    .mockResolvedValueOnce(plan('approved_for_lab', 3))
    .mockResolvedValueOnce(plan('simulated', 5))
    .mockResolvedValueOnce(plan('reviewed', 6))
    .mockResolvedValueOnce(saved)
    .mockResolvedValueOnce(workspace)
    .mockResolvedValueOnce({ plan: saved, reference });
  const { ui } = boot(request);
  await create(ui);
  await ui.approve('test-000001');
  await ui.simulate('test-000001');
  await ui.decide('test-000001', true);
  expect(ui.canSave()).toBe(true);
  await ui.save();
  expect(ui.references()).toEqual([reference]);
  expect(ui.model()?.state).toBe('saved');
  expect(request.mock.calls[3]?.[1]).toMatchObject({
    action: 'review',
    accepted: true,
    expectedVersion: 5,
  });
  expect(request.mock.calls[4]?.[1]).toMatchObject({
    action: 'save',
    expectedVersion: 6,
    confirmed: true,
    expectedStateRevision: 7,
  });
  const ids = request.mock.calls.slice(1, 5).map((c) => (c[1] as { requestId: string }).requestId);
  expect(new Set(ids).size).toBe(4);
});
it('an explicit GET cannot reactivate a server approval; preparation is required', async () => {
  const approved = plan('approved_for_lab', 3),
    workspace = {
      schemaVersion: 1,
      serverId: 'server-a',
      mode: 'lab',
      capabilities: { execution: 'virtual_only', realWrite: false },
      channels: [],
      plans: [approved],
    };
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(plan())
    .mockResolvedValueOnce(workspace)
    .mockResolvedValueOnce({ plan: approved, reference: null })
    .mockResolvedValueOnce(plan('proposed', 4));
  const { ui } = boot(request);
  await create(ui);
  await ui.refresh();
  expect(ui.requiresPreparation()).toBe(true);
  await ui.simulate('test-000001');
  expect(request).toHaveBeenCalledTimes(3);
  await ui.reprepare();
  expect(ui.requiresPreparation()).toBe(false);
  expect(ui.status()['test-000001']).toBe('proposed');
});
it('undo and cancel request the backend, without local review or virtual-value mutation', async () => {
  const rejected = plan('rejected', 6);
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(plan())
    .mockResolvedValueOnce(plan('approved_for_lab', 3))
    .mockResolvedValueOnce(plan('simulated', 5))
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(plan('proposed', 2))
    .mockResolvedValueOnce(plan('rejected', 3));
  const { ui, command } = boot(request);
  await create(ui);
  await ui.approve('test-000001');
  await ui.simulate('test-000001');
  await ui.undo('test-000001');
  expect(request.mock.calls[3]?.[1]).toMatchObject({
    action: 'undo',
    resultId: 'result-000001',
    confirmed: true,
    expectedVersion: 5,
  });
  await create(ui);
  await ui.cancel();
  expect(request.mock.calls[5]?.[1]).toMatchObject({ action: 'cancel', expectedVersion: 2 });
  expect(ui.stage()).toBe('cancelled');
  expect(command).not.toHaveBeenCalled();
});
it('answers missing server fields via revise without synthesizing observations or approval', async () => {
  const missing = plan('needs_info');
  delete missing.items[0]!.spec.channel;
  delete missing.items[0]!.spec.deltaDB;
  missing.items[0]!.questions = [
    {
      schemaVersion: 1,
      id: 'channel',
      message: 'Confirme o canal.',
      required: true,
      source: 'server_validation',
    },
  ];
  const request = vi
    .fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(missing)
    .mockResolvedValueOnce(plan('draft', 3));
  const { ui } = boot(request);
  await create(ui);
  await ui.revise('test-000001', 999, 1);
  expect(request).toHaveBeenCalledTimes(1);
  await ui.revise('test-000001', 3, 1);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    action: 'revise',
    expectedVersion: 2,
    items: [{ channel: 3, deltaDB: 1, operation: 'level_delta' }],
  });
  expect(ui.status()['test-000001']).toBe('blocked');
});
it('uses the existing nonce generator on HTTP LAN where randomUUID is unavailable', async () => {
  const { ui, request } = boot();
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  try {
    await create(ui);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{6,64}$/),
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
