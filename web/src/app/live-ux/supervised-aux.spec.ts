import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';
import { SupervisedAuxComponent } from './supervised-aux.component';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | 'hang';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STATUS = (state: 'enabled' | 'disabled' | 'blocked', observed: number | null = -20) => ({
  serverId: 'srv-1', mode: 'real', model: 'ui16', link: 'READY',
  feature: { gate: state !== 'disabled', validation: state === 'disabled' ? null : 'simulated_transport', available: state === 'enabled', state },
  stepDB: 0.5, maxStepDB: 1, channels: [{ number: 2, name: 'Violão' }, { number: 3, name: 'Fred' }], aux: [{ number: 1, name: 'Fones' }], observed,
});
const PREVIEW = { proposal: { id: 'abcdef012345' }, previous: -20, requested: -19.5, observed: -20, source: 'independent_socket_input', validation: 'simulated_transport' };
const CONFIRMED = (status: string, observed: number | null) => ({ requestId: 'x', duplicate: false, result: { ok: status === 'observed_target', code: 'OK', message: 'm' },
  confirmation: { status, previous: -20, requested: -19.5, observed, source: 'independent_socket_input', validation: 'simulated_transport', causalAcknowledgement: false } });

async function boot(opts: { mode?: 'lab' | 'real'; role?: 'operator' | 'musician'; handler?: Handler } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  FakeSocket.all = []; LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = opts.handler?.(url, init);
    if (r === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort'))));
    return r ?? json({});
  }));
  const role = opts.role ?? 'operator';
  const fixture = TestBed.createComponent(App), session = TestBed.inject(SessionService);
  session.token.set('tok-' + role); session.role.set(role); fixture.detectChanges(); await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!; ws.open(); ws.receive({ ...hello(role), mode: opts.mode ?? 'lab' }); answerNames(ws); ws.receive(snapshot());
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); fixture.detectChanges(); };
  await settle(); await settle();
  const el = fixture.nativeElement as HTMLElement;
  (el.querySelector('[aria-label^="Selecionar CH"]') as HTMLButtonElement | null)?.click(); await settle(); await settle();
  const svc = () => fixture.debugElement.query(By.directive(SupervisedAuxComponent))?.componentInstance?.svc;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (id: string) => { (q(id) as HTMLButtonElement).click(); await settle(); await settle(); };
  const real = () => calls.filter(c => c.url.startsWith('/api/ui16'));
  const choose = async () => { svc().selectChannel(2); svc().selectAux(1); await settle(); await settle(); };
  return { choose, fixture, session, ws, el, settle, svc, q, click, calls, real };
}
afterEach(() => vi.unstubAllGlobals());

describe('teste supervisionado AUX (#101)', () => {
  it('LAB/MOCK: mostra bloqueado, não chama rota REAL e não oferece envio', async () => {
    const t = await boot({ mode: 'lab' });
    expect(t.q('sup-lab')?.textContent).toContain('Bloqueado');
    expect(t.q('sup-feature')?.textContent).toContain('Bloqueado');
    expect((t.q('sup-minus') as HTMLButtonElement).disabled).toBe(true);
    expect((t.q('sup-plus') as HTMLButtonElement).disabled).toBe(true);
    expect(t.real()).toEqual([]);
  });
  it('músico não vê a tela nem chama o servidor', async () => {
    const t = await boot({ mode: 'real', role: 'musician' });
    expect(t.q('sup-feature')).toBeNull(); expect(t.real()).toEqual([]);
  });
  it('REAL com gate fechado (padrão): bloqueado, sem prévia possível', async () => {
    const t = await boot({ mode: 'real', handler: (u) => json(STATUS('disabled', null)) });
    expect(t.q('sup-disabled')?.textContent).toContain('validação física');
    expect(t.q('sup-feature')?.textContent).toContain('Desabilitado');
    expect((t.q('sup-plus') as HTMLButtonElement).disabled).toBe(true);
    await t.svc().prepare(1);
    expect(t.real().filter(c => c.method === 'POST')).toEqual([]);
  });
  it('estado do recurso desconhecido (falha de rede) é tratado como bloqueado', async () => {
    const t = await boot({ mode: 'real', handler: () => { throw new Error('offline'); } });
    expect(t.q('sup-error')?.textContent).toContain('bloqueado');
    expect((t.q('sup-plus') as HTMLButtonElement).disabled).toBe(true);
  });
  it('prévia e cancelamento: mostra anterior/solicitado, não confirma e não envia nada', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : json(STATUS('enabled')) });
    expect((t.q('sup-plus') as HTMLButtonElement).disabled).toBe(true); // sem canal/AUX escolhidos
    await t.choose();
    expect(t.q('sup-observed')?.textContent).toContain('−20.0');
    await t.click('sup-plus');
    const preview = t.real().find(c => c.url.endsWith('/preview'))!;
    expect(preview.body).toEqual({ targetMode: 'real', serverId: 'srv-1', channel: 2, aux: 1, deltaDB: 0.5 });
    expect(t.q('sup-previous')?.textContent).toContain('−20.0'); expect(t.q('sup-requested')?.textContent).toContain('−19.5');
    await t.click('sup-cancel');
    expect(t.q('sup-preview')).toBeNull();
    expect(t.real().some(c => c.url.endsWith('/confirm'))).toBe(false);
  });
  it('−0,5 dB usa deltaDB negativo e só canais/AUX cadastrados aparecem', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : json(STATUS('enabled')) });
    expect([...t.el.querySelectorAll('select[aria-label="Canal do teste"] option')].map(o => o.textContent)).toEqual(['Selecione um canal…', 'CH2 — Violão', 'CH3 — Fred']);
    expect([...t.el.querySelectorAll('select[aria-label="AUX do teste"] option')].map(o => o.textContent)).toEqual(['Selecione um AUX…', 'AUX 1 — Fones']);
    await t.choose(); await t.click('sup-minus');
    expect(t.real().find(c => c.url.endsWith('/preview'))!.body.deltaDB).toBe(-0.5);
  });
  it('confirmação explícita: uma única chamada com humanConfirmed e resultado observed_target sem ACK causal', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : u.includes('/confirm') ? json(CONFIRMED('observed_target', -19.5)) : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus'); await t.click('sup-confirm');
    const confirms = t.real().filter(c => c.url.endsWith('/confirm'));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.url).toBe('/api/ui16/aux/abcdef012345/confirm');
    expect(confirms[0]!.body).toMatchObject({ targetMode: 'real', serverId: 'srv-1', humanConfirmed: true });
    expect(confirms[0]!.body.requestId).toMatch(/^ui-[A-Za-z0-9]+$/);
    expect(t.q('sup-status')?.textContent).toContain('observed_target');
    expect(t.q('sup-outcome')?.textContent).toContain('não prova que o MixAI causou');
    expect(t.q('sup-result-observed')?.textContent).toContain('−19.5');
    expect(t.q('sup-confirm')).toBeNull();
  });
  it.each([['unconfirmed', null, 'unconfirmed'], ['not_sent', -20, 'not_sent']])('%s não é tratado como sucesso', async (status, observed, label) => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : u.includes('/confirm') ? json(CONFIRMED(status, observed)) : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus'); await t.click('sup-confirm');
    expect(t.q('sup-status')?.textContent).toContain(label);
    expect(t.q('sup-outcome')?.getAttribute('data-status')).toBe(label);
    expect(t.real().filter(c => c.url.endsWith('/confirm'))).toHaveLength(1);
    if (status === 'unconfirmed') expect(t.q('sup-result-observed')?.textContent).toContain('Não disponível');
  });
  it('timeout/conexão perdida na confirmação: resultado indeterminado, sem reenvio automático', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : u.includes('/confirm') ? 'hang' : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus');
    const done = t.svc().confirm(); await t.settle();
    t.svc().ctl.abort('timeout'); await done; await t.settle();
    expect(t.q('sup-status')?.textContent).toContain('indeterminado');
    expect(t.q('sup-outcome')?.textContent).toContain('Não reenvie');
    expect(t.real().filter(c => c.url.endsWith('/confirm'))).toHaveLength(1);
  });
  it('sessão expirada na prévia (401) não deixa prévia nem envio', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json({ code: 'UNAUTHORIZED' }, 401) : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus');
    expect(t.q('sup-error')?.textContent).toContain('Sessão encerrada'); expect(t.q('sup-preview')).toBeNull();
  });
  it('sessão expirada na confirmação (401) mostra erro e nenhum resultado de sucesso', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : u.includes('/confirm') ? json({ code: 'UNAUTHORIZED' }, 401) : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus'); await t.click('sup-confirm');
    expect(t.q('sup-error')?.textContent).toContain('Sessão encerrada'); expect(t.q('sup-outcome')).toBeNull();
  });
  it('prévia expirada desabilita a confirmação e nada é enviado', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus');
    t.svc().now.set(Date.now() + 20_000); await t.settle();
    expect((t.q('sup-confirm') as HTMLButtonElement).disabled).toBe(true);
    await t.svc().confirm();
    expect(t.real().some(c => c.url.endsWith('/confirm'))).toBe(false);
  });
  it('recusa do servidor na prévia (canal/AUX inválido) mostra mensagem e não cria prévia', async () => {
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json({ result: { ok: false, code: 'INVALID', message: 'x' } }) : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus');
    expect(t.q('sup-error')?.textContent).toContain('Nada foi enviado'); expect(t.q('sup-preview')).toBeNull();
  });
  it('trocar a sessão descarta prévia e ignora resposta tardia da confirmação', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await boot({ mode: 'real', handler: (u) => u.includes('/preview') ? json(PREVIEW) : u.includes('/confirm') ? new Promise<Response>(r => { release = r; }) as unknown as Response : json(STATUS('enabled')) });
    await t.choose(); await t.click('sup-plus');
    const pending = t.svc().confirm(); await t.settle();
    t.session.token.set('outra-sessao'); await t.settle();
    release(json(CONFIRMED('observed_target', -19.5))); await pending; await t.settle();
    expect(t.q('sup-outcome')).toBeNull(); expect(t.q('sup-preview')).toBeNull();
  });
});
