import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ReferenceWorkspaceComponent } from './reference.component';
import { ReferenceUiService } from './reference.service';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
const reference = { id: 'reference-test', eventId: 'event-test', eventName: 'Show LAB', eventDate: '2026-11-07', version: 1, scope: 'PA', operatorApprovedAt: '2026-11-07T00:00:00Z', validationStatus: 'UNVERIFIED' };
const workspace = { serverId: 'server-test', revision: 1, references: [reference], channels: [{ number: 3, name: 'Voz Fred' }], requests: [], integrations: { identity: false, recommendations: false }, identity: { verified: false } };
const comparison = { referenceId: reference.id, reference: { channels: workspace.channels, history: [{ version: 1, at: '2026-11-07', action: 'reference_approved', role: 'operator' }] }, rows: [{ key: 'ch.3.main.level', reference: { status: 'known', value: -8 } }] };
function boot(role = 'operator', mode = 'lab') {
  const live = { hello: signal({ serverId: 'server-test', role, mode }), connection: signal('online'), state: signal<any>({ available: true, revision: 7, params: { 'ch.3.main.level': { value: { status: 'known', value: -12 }, actor: 'external' } } }) };
  const session = { token: signal('token-test') };
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => String(input).endsWith('/compare') ? comparison : String(input).includes('reference-workspace') ? workspace : { id: reference.id } } as Response));
  vi.stubGlobal('fetch', fetch);
  TestBed.configureTestingModule({ providers: [{ provide: LiveService, useValue: live }, { provide: SessionService, useValue: session }] });
  const f = TestBed.createComponent(ReferenceWorkspaceComponent); const ui = TestBed.inject(ReferenceUiService); f.detectChanges();
  return { f, c: f.componentInstance, ui, live, session, fetch };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('compares observed state read-only, flags relevant changes and never restores when values change or become unknown', async () => {
  const { f, c, ui, live, fetch } = boot(); await ui.refresh(); ui.data.set(workspace as any); ui.open.set(true); ui.compared.set(comparison); f.detectChanges();
  expect(c.rows()[0]).toMatchObject({ label: 'CH3 — Voz Fred (volume)', saved: '-8.0 dB', now: '-12.0 dB', delta: '-4.0 dB', relevant: true, actor: 'externa observada (LAB)' });
  live.state.update(s => ({ ...s, params: { 'ch.3.main.level': { value: { status: 'unknown' } } } })); f.detectChanges();
  expect(c.rows()[0]!.now).toBe('unknown'); expect(c.rows()[0]!.delta).toBe('—');
  live.state.set({ available: false, revision: 8, params: {} }); f.detectChanges(); expect(c.rows()[0]!.now).toContain('indisponível');
  expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  expect(f.nativeElement.textContent).toContain('não é snapshot nativo'); expect(f.nativeElement.querySelector('[class=relevant]')).toBeNull();
});
it('requires explicit operator approval and current revisions when saving, without command API', async () => {
  const { f, c, ui, fetch } = boot(); await ui.refresh(); ui.data.set(workspace as any); ui.open.set(true); c.eventName = 'Show LAB'; f.detectChanges();
  const save = Array.from(f.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(b => b.textContent!.includes('Salvar referência'))!;
  expect(save.disabled).toBe(true); (f.nativeElement.querySelector('input[type=checkbox]') as HTMLInputElement).click(); f.detectChanges(); await f.whenStable(); f.detectChanges(); expect(save.disabled).toBe(false);
  await c.capture(); const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/mix-references'); expect(JSON.parse(post[1]!.body as string)).toMatchObject({ serverId: 'server-test', expectedStateRevision: 7, operatorApproved: true });
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/api/command'))).toBe(false);
});
it('musician sends an unverified report, not identity, authorization, diagnosis or action payload', async () => {
  const { f, c, ui, fetch } = boot('musician'); await ui.refresh(); ui.data.set({ ...workspace, references: [] } as any); ui.open.set(true); f.detectChanges();
  expect(f.nativeElement.textContent).toContain('sem identidade vinculada'); expect(f.nativeElement.textContent).not.toContain('Salvar referência LAB');
  c.report = 'Minha voz está baixa'; c.channel = '3'; c.type = 'meu_canal'; await c.send();
  const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  const body = JSON.parse(post[1]!.body as string); expect(post[0]).toBe('/api/mix-requests');
  expect(body).toMatchObject({ type: 'meu_canal', report: 'Minha voz está baixa', channel: 3, destination: 'AUX1' });
  expect(body.requestedBy).toBeUndefined(); expect(body.command).toBeUndefined(); expect(body.musicianId).toBeUndefined();
});
it('escapes reports and advice, keeps diagnosis unavailable and approval explicitly non-applying', async () => {
  const { f, ui } = boot(); await ui.refresh(); ui.open.set(true);
  ui.data.set({ ...workspace, requests: [{ id: 'request-test', version: 1, type: 'mix_geral', report: '<script>bad()</script>', destination: 'AUX1', createdAt: '', expiresAt: '', state: 'received', response: 'Avaliar manualmente', requestedBy: { verified: false, sourceSessionId: 'session' }, historyCount: 1 }] } as any); f.detectChanges();
  expect(f.nativeElement.querySelector('script')).toBeNull(); expect(f.nativeElement.textContent).toContain('<script>bad()</script>');
  const buttons = Array.from(f.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>);
  expect(buttons.find(b => b.textContent === 'Consultar mesário IA (somente leitura)')!.disabled).toBe(true);
  expect(buttons.some(b => b.textContent!.includes('Aprovar orientação (não aplica)'))).toBe(true);
  expect(f.nativeElement.textContent).toContain('AUX1 compartilhado');
});
it('clears reference/history/request data on logout or role/mode switch and rejects late responses', async () => {
  const { f, ui, session, fetch } = boot(); await ui.refresh(); ui.data.set(workspace as any); ui.compared.set(comparison);
  let resolve!: (value: Response) => void; fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = ui.compare(reference.id); session.token.set('another-token'); f.detectChanges(); resolve({ ok: true, json: async () => comparison } as Response); await pending;
  expect(ui.compared()).toBeNull();
  session.token.set(''); f.detectChanges(); expect(ui.data()).toBeNull(); expect(ui.history()).toEqual({});
});
it('does not create this workspace in REAL/MOCK', async () => {
  const { ui, fetch } = boot('operator', 'real'); expect(ui.data()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it('rejects incomplete/unrelated HTTP responses without crashing existing views or inventing an empty workspace', async () => {
  const { f, ui, fetch } = boot(); await vi.waitFor(() => expect(ui.data()).not.toBeNull());
  fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response); ui.data.set(null);
  await ui.refresh(); ui.open.set(true); f.detectChanges();
  expect(ui.data()).toBeNull(); expect(ui.error()).toContain('Dados inválidos'); expect(f.nativeElement.querySelector('[role=alert]').textContent).toContain('Dados inválidos');
});
