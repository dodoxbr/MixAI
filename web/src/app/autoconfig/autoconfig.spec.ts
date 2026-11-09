import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AutoConfigComponent } from './autoconfig.component';
import { AUTO_ADAPTER, AutoConfigService } from './autoconfig.service';
import { adaptPlan, adaptResult, type AutoAdapter, type AutoInput } from './autoconfig-contract';
import { fixtureAdapter } from './autoconfig-fixture';
import { SessionService } from '../core/session.service';
import { LiveService } from '../core/live.service';
const context = { eventId: 'event-a', eventName: 'Ensaio', eventVersion: 1 };
const input: AutoInput = {
  ...context,
  schemaVersion: 1,
  scope: 'lab_simulation',
  goal: 'Clareza',
  channel: 3,
  destination: 'AUX1',
  report: 'Abafado',
  stateRevision: 7,
};
function boot(adapter: AutoAdapter = fixtureAdapter) {
  const token = signal<string | null>('a'),
    role = signal('operator'),
    hello = signal<any>({ role: 'operator', mode: 'lab', serverId: 'server-a' }),
    connection = signal('online'),
    state = signal<any>({ revision: 7 });
  const command = vi.fn(),
    approve = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: AUTO_ADAPTER, useValue: adapter },
      { provide: SessionService, useValue: { token, role } },
      {
        provide: LiveService,
        useValue: {
          hello,
          connection,
          state,
          command,
          approve,
          channels: signal([{ number: 3, name: 'Voz' }]),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(AutoConfigComponent);
  fixture.componentRef.setInput('event', context);
  fixture.detectChanges();
  const ui = TestBed.inject(AutoConfigService);
  return { fixture, ui, token, role, hello, connection, state, command, approve };
}
async function prepare(ui: AutoConfigService) {
  ui.start();
  ui.answer('Melhorar clareza');
  ui.answer('3');
  ui.answer('AUX1');
  await ui.prepare('Abafado no retorno');
}
it('asks one question at a time, validates channel and permits going back without executing', async () => {
  const { ui, fixture, command, approve } = boot();
  ui.start();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Qual é o objetivo?');
  expect(fixture.nativeElement.querySelector('textarea')).toBeNull();
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
  await ui.prepare('Abafado');
  fixture.detectChanges();
  expect(ui.plan()?.items).toHaveLength(2);
  expect(ui.status()).toEqual({ balance: 'proposed', clarity: 'proposed' });
  expect(fixture.nativeElement.textContent).toContain('SIMULAÇÃO LAB');
  expect(fixture.nativeElement.textContent).toContain('Não ouvimos nem medimos áudio');
  expect(command).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
});
it('requires individual human approval, prevents double dispatch and saves reviewed versions only in session', async () => {
  const simulate = vi.fn(fixtureAdapter.simulate);
  const { ui, fixture, command } = boot({ ...fixtureAdapter, simulate });
  await prepare(ui);
  await ui.simulate('balance');
  expect(simulate).not.toHaveBeenCalled();
  ui.decide('balance', true);
  expect(ui.status()['balance']).toBe('proposed');
  ui.save();
  expect(ui.references()).toHaveLength(0);
  ui.approve('balance');
  await Promise.all([ui.simulate('balance'), ui.simulate('balance')]);
  expect(simulate).toHaveBeenCalledTimes(1);
  expect(ui.status()['clarity']).toBe('proposed');
  ui.decide('balance', true);
  ui.save();
  expect(ui.references()).toHaveLength(0);
  ui.decide('clarity', false);
  ui.save();
  ui.save();
  expect(ui.references().map((r) => r.version)).toEqual([1, 2]);
  expect(ui.references()[0]?.items).toHaveLength(1);
  expect(ui.references()[0]?.temporary).toBe(true);
  ui.decide('balance', false);
  expect(ui.canSave()).toBe(false);
  fixture.detectChanges();
  expect(command).not.toHaveBeenCalled();
});
it.each(['token', 'role', 'mode', 'server', 'event', 'offline', 'revision', 'cancel'] as const)(
  'discards late simulation and approvals after %s change',
  async (change) => {
    let resolve!: (v: unknown) => void;
    const simulate = vi.fn(() => new Promise<unknown>((r) => (resolve = r)));
    const { ui, fixture, token, role, hello, connection, state } = boot({
      ...fixtureAdapter,
      simulate,
    });
    await prepare(ui);
    const plan = ui.plan()!;
    ui.approve('balance');
    const pending = ui.simulate('balance');
    if (change === 'token') token.set('b');
    if (change === 'role') role.set('musician');
    if (change === 'mode') hello.update((h) => ({ ...h, mode: 'real' }));
    if (change === 'server') hello.update((h) => ({ ...h, serverId: 'b' }));
    if (change === 'event') fixture.componentRef.setInput('event', { ...context, eventId: 'b' });
    if (change === 'offline') connection.set('offline');
    if (change === 'revision') state.set({ revision: 8 });
    if (change === 'cancel') ui.cancel();
    fixture.detectChanges();
    resolve(await fixtureAdapter.simulate({ plan, itemId: 'balance', operatorApproved: true }));
    await pending;
    fixture.detectChanges();
    expect(ui.results()).toEqual({});
    expect(ui.status()).toEqual({});
    expect(ui.references()).toEqual([]);
    expect(ui.busy()).toBe(false);
  },
);
it('handles error without exposing raw details or retrying approval; explicit retry requires a fresh click', async () => {
  const simulate = vi
    .fn<AutoAdapter['simulate']>()
    .mockRejectedValueOnce(Error('secret path'))
    .mockImplementation(fixtureAdapter.simulate);
  const { ui, fixture } = boot({ ...fixtureAdapter, simulate });
  await prepare(ui);
  ui.approve('balance');
  await ui.simulate('balance');
  fixture.detectChanges();
  expect(ui.error()).toContain('nova autorização');
  expect(fixture.nativeElement.textContent).not.toContain('secret path');
  await ui.simulate('balance');
  expect(simulate).toHaveBeenCalledTimes(1);
  ui.approve('balance');
  await ui.simulate('balance');
  expect(ui.results()['balance']).toBeTruthy();
});
it('rejects malformed plans and does not trust model approvals or measured-audio claims in results', async () => {
  const raw: any = await fixtureAdapter.plan(input);
  raw.approved = true;
  raw.command = { type: 'set_level' };
  raw.items[0].approved = true;
  const plan = adaptPlan(raw, input);
  expect(JSON.stringify(plan)).not.toContain('approved');
  expect(JSON.stringify(plan)).not.toContain('set_level');
  for (const mutate of [
    (p: any) => (p.scope = 'real'),
    (p: any) => (p.schemaVersion = 2),
    (p: any) => (p.items[0].channel = 4),
    (p: any) => (p.items[0].references[0].url = 'javascript:alert(1)'),
    (p: any) => (p.items[1].id = p.items[0].id),
  ]) {
    const invalid = structuredClone(raw);
    mutate(invalid);
    expect(() => adaptPlan(invalid, input)).toThrow();
  }
  const result: any = await fixtureAdapter.simulate({
    plan,
    itemId: 'balance',
    operatorApproved: true,
  });
  result.acousticValidated = true;
  expect(() => adaptResult(result, plan, plan.items[0]!)).toThrow();
  result.acousticValidated = false;
  result.itemId = 'clarity';
  expect(() => adaptResult(result, plan, plan.items[0]!)).toThrow();
});
it('escapes untrusted content, renders accessible labels and never makes a mixer call', async () => {
  const { fixture, ui, command } = boot({
    ...fixtureAdapter,
    async plan(i) {
      const p: any = await fixtureAdapter.plan(i);
      p.items[0].title = '<img src=x onerror=alert(1)>';
      return p;
    },
  });
  await prepare(ui);
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('img')).toBeNull();
  expect(fixture.nativeElement.textContent).toContain('<img');
  expect(
    fixture.nativeElement.querySelector('section[aria-labelledby="autoconfig-title"]'),
  ).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
});
it.each(['real', 'mock'])('is unavailable in %s without changing authentication', (mode) => {
  const { ui, hello, fixture, command } = boot();
  hello.update((h) => ({ ...h, mode }));
  fixture.detectChanges();
  ui.start();
  expect(ui.eligible()).toBe(false);
  expect(ui.stage()).toBe('idle');
  expect(fixture.nativeElement.textContent).not.toContain('Iniciar AutoConfig');
  expect(command).not.toHaveBeenCalled();
});
it('invalidates planning on state change and sanitizes planner errors with explicit retry', async () => {
  let resolve!: (v: unknown) => void;
  const { ui, state, fixture } = boot({
    ...fixtureAdapter,
    plan: () => new Promise((r) => (resolve = r)),
  });
  ui.start();
  ui.answer('Clareza');
  ui.answer('3');
  ui.answer('PA');
  const pending = ui.prepare('Relato');
  state.set({ revision: 8 });
  fixture.detectChanges();
  resolve(await fixtureAdapter.plan({ ...input, destination: 'PA' }));
  await pending;
  expect(ui.plan()).toBeNull();
  expect(ui.busy()).toBe(false);
});
it('planner failure stays recoverable and never leaks private error text', async () => {
  const plan = vi
    .fn<AutoAdapter['plan']>()
    .mockRejectedValueOnce(Error('private-provider-message'))
    .mockImplementation(fixtureAdapter.plan);
  const { ui, fixture } = boot({ ...fixtureAdapter, plan });
  await prepare(ui);
  fixture.detectChanges();
  expect(ui.error()).toContain('Plano indisponível');
  expect(fixture.nativeElement.textContent).not.toContain('private-provider-message');
  expect(ui.busy()).toBe(false);
  await ui.prepare('Relato revisado');
  expect(ui.plan()?.items).toHaveLength(2);
  expect(Object.values(ui.status())).toEqual(['proposed', 'proposed']);
});
it('times out a hung simulator without replay and clears approvals after session expiry', async () => {
  const simulate = vi.fn(() => new Promise<unknown>(() => {}));
  const { ui, token, fixture } = boot({ ...fixtureAdapter, simulate });
  await prepare(ui);
  ui.approve('balance');
  vi.useFakeTimers();
  try {
    const pending = ui.simulate('balance');
    await vi.advanceTimersByTimeAsync(10001);
    await pending;
    expect(ui.busy()).toBe(false);
    expect(ui.error()).toContain('nova autorização');
    await ui.simulate('balance');
    expect(simulate).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
  token.set(null);
  fixture.detectChanges();
  expect(ui.stage()).toBe('idle');
  expect(ui.context()).toBeNull();
  expect(ui.references()).toEqual([]);
  expect(ui.plan()).toBeNull();
});
it.each([0, 1, 2])(
  'offline preserves unanswered question %s rather than skipping to the report',
  (question) => {
    const { ui, connection, fixture } = boot();
    ui.start();
    if (question > 0) ui.answer('Clareza');
    if (question > 1) ui.answer('3');
    connection.set('offline');
    fixture.detectChanges();
    expect(ui.question()).toBe(question);
    expect(ui.canAct()).toBe(false);
    connection.set('online');
    fixture.detectChanges();
    expect(ui.question()).toBe(question);
    expect(ui.plan()).toBeNull();
  },
);
