import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';
import { muteLabel, type ChannelMuteState, type MuteCause } from './mute-state.service';

const SERVER = (hello('operator') as { serverId: string }).serverId;
const ch = (channel: number, over: Partial<ChannelMuteState> = {}): ChannelMuteState => ({ channel, individual: false, muteAll: 'active', otherGroupsActive: false, forceUnmute: false, effective: 'muted', cause: 'mute_all', precedence: 'not_needed', reasons: [], ...over });
const view = (muteAll: 'active' | 'inactive' | 'unknown', channels: ChannelMuteState[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, targetMode: 'real', serverId: SERVER, link: 'READY', hardwareValidation: 'pending',
  groups: { state: muteAll === 'unknown' ? 'unknown' : 'confirmed', mask: muteAll === 'active' ? 8388608 : muteAll === 'inactive' ? 0 : null, muteAll, otherGroupsActive: muteAll === 'unknown' ? null : false, ...(muteAll === 'unknown' ? { reason: 'not_observed' } : {}) },
  channels, ...over,
});
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

async function boot(mode: 'real' | 'lab', respond: () => Response | Promise<Response> | never) {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (String(url).includes('/api/ui16/mute-state')) { calls.push(String(url)); return respond(); } return new Response('{}', { status: 200 }); }));
  const fixture = TestBed.createComponent(App);
  const session = TestBed.inject(SessionService);
  session.token.set('tok'); session.role.set('operator');
  fixture.detectChanges(); await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!; ws.open();
  ws.receive({ ...hello('operator'), mode });
  answerNames(ws); ws.receive(snapshot(0));
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); fixture.detectChanges(); };
  await settle(); await settle();
  return { fixture, ws, el: fixture.nativeElement as HTMLElement, calls, settle, session };
}
const eff = (el: HTMLElement) => [...el.querySelectorAll('.strips [data-testid=eff-mute]')] as HTMLElement[];
const banner = (el: HTMLElement) => el.querySelector('[data-testid=mute-all-banner]') as HTMLElement | null;

describe('rótulos do MUTE efetivo', () => {
  const causes: MuteCause[] = ['none', 'individual', 'mute_all', 'individual_and_mute_all', 'force_unmute_precedence_pending', 'other_mute_group_membership_unvalidated', 'group_state_unavailable', 'individual_unavailable', 'force_unmute_unavailable'];
  it.each(causes)('%s: texto e explicação não vazios', (cause) => { const l = muteLabel(ch(1, { cause })); expect(l.text.length).toBeGreaterThan(2); expect(l.title.length).toBeGreaterThan(20); });
  it('Mute All é diferente de MUTE individual; Force Unmute pendente nunca vira aberto ou mudo', () => {
    expect(muteLabel(ch(1, { cause: 'mute_all' }))).toMatchObject({ text: 'MUDO · Mute All', tone: 'muted' });
    expect(muteLabel(ch(1, { cause: 'individual', muteAll: 'inactive' }))).toMatchObject({ text: 'MUDO · individual', tone: 'muted' });
    expect(muteLabel(ch(1, { cause: 'force_unmute_precedence_pending', effective: 'unknown' })).tone).toBe('unknown');
    expect(muteLabel(ch(1, { cause: 'group_state_unavailable', effective: 'unknown' })).tone).toBe('unknown');
  });
});

describe('MUTE efetivo na mesa', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('REAL com Mute All: selo por canal (individual, Mute All, Force Unmute) e aviso; o botão MUTE continua individual', async () => {
    const channels = [ch(1, { individual: true, cause: 'individual_and_mute_all' }), ch(2, { individual: true, forceUnmute: true, effective: 'unknown', cause: 'force_unmute_precedence_pending', precedence: 'pending' }), ch(3, { forceUnmute: true, effective: 'unknown', cause: 'force_unmute_precedence_pending', precedence: 'pending' })];
    const { el } = await boot('real', () => json(view('active', channels)));
    const badges = eff(el);
    expect(badges.length).toBe(3);
    expect(badges.map((b) => b.dataset['cause'])).toEqual(['individual_and_mute_all', 'force_unmute_precedence_pending', 'force_unmute_precedence_pending']);
    expect(badges[0]!.textContent).toContain('Mute All');
    expect(badges[1]!.dataset['tone']).toBe('unknown');
    expect(banner(el)!.dataset['kind']).toBe('active');
    expect(banner(el)!.textContent).toContain('MUTE ALL ATIVO');
    // MUTE individual preservado: vem do estado da mesa (snapshot), não do efetivo
    const mutes = [...el.querySelectorAll('.strips .mute')] as HTMLButtonElement[];
    expect(mutes.every((b) => b.disabled)).toBe(true);
  });
  it('sem Mute All: aberto aparece só com evidência; sem aviso', async () => {
    const { el } = await boot('real', () => json(view('inactive', [ch(1, { muteAll: 'inactive', cause: 'none', effective: 'open' }), ch(2, { muteAll: 'inactive', individual: true, cause: 'individual' })])));
    expect(eff(el).map((b) => b.textContent!.trim())).toEqual(['ABERTO', 'MUDO · individual']);
    expect(banner(el)).toBeNull();
  });
  it('grupos desconhecidos: aviso de indisponível e selos desconhecidos (nunca "aberto" por padrão)', async () => {
    const { el } = await boot('real', () => json(view('unknown', [ch(1, { muteAll: 'unknown', effective: 'unknown', cause: 'group_state_unavailable' })])));
    expect(banner(el)!.dataset['kind']).toBe('unknown');
    expect(eff(el)[0]!.dataset['tone']).toBe('unknown');
    expect(eff(el)[0]!.textContent).not.toContain('ABERTO');
  });
  it.each([['falha de rede', () => { throw new TypeError('net'); }], ['401', () => json({ code: 'UNAUTHORIZED' }, 401)], ['instância diferente', () => json(view('active', [ch(1)], { serverId: '00000000-0000-4000-8000-000000000000' }))]] as Array<[string, () => Response]>)('%s: sem selos e sem aviso (desconhecido, não aberto)', async (_n, respond) => {
    const { el } = await boot('real', respond);
    expect(eff(el).length).toBe(0); expect(banner(el)).toBeNull();
  });
  it('LAB/MOCK: nenhuma consulta, nenhum selo e nenhum aviso', async () => {
    const { el, calls } = await boot('lab', () => json(view('active', [ch(1)])));
    expect(calls).toEqual([]); expect(eff(el).length).toBe(0); expect(banner(el)).toBeNull();
  });
  it('AUX SENDS mantém o MUTE individual: sem selo efetivo e sem aviso do Mute All', async () => {
    const { el, fixture, settle } = await boot('real', () => json(view('active', [ch(1), ch(2)])));
    expect(eff(el).length).toBe(2);
    (el.querySelector('.console-nav [data-view=aux]') as HTMLButtonElement).click(); fixture.detectChanges(); await settle();
    expect(eff(el).length).toBe(0); expect(banner(el)).toBeNull();
    expect(el.querySelectorAll('.strips .mute').length).toBeGreaterThan(0);
  });
  it('troca de sessão descarta o estado antigo e consulta de novo com a nova sessão', async () => {
    let revoked = false;
    const { el, session, settle, calls } = await boot('real', () => (revoked ? json({ code: 'UNAUTHORIZED' }, 401) : json(view('active', [ch(1)]))));
    expect(eff(el).length).toBe(1);
    revoked = true; const before = calls.length;
    session.token.set('outra-sessao'); await settle(); await settle();
    expect(calls.length).toBeGreaterThan(before);
    expect(banner(el)).toBeNull(); expect(eff(el).length).toBe(0);
  });
  it('só faz GET (nenhum comando) e usa o endpoint de leitura', async () => {
    const { calls, ws } = await boot('real', () => json(view('active', [ch(1)])));
    expect(calls.length).toBeGreaterThan(0); expect(calls.every((u) => u === '/api/ui16/mute-state')).toBe(true);
    const writes = ws.sent.filter((m) => m['type'] === 'proposal_apply' || (m['type'] === 'command' && /^(set_|undo|musician_|scene|load)/.test(String((m['command'] as { type?: string } | undefined)?.type))));
    expect(writes).toEqual([]);
    const f = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter((c) => String(c[0]).includes('mute-state'));
    expect(f.every((c) => !c[1]?.method || c[1].method === 'GET')).toBe(true);
  });
});
