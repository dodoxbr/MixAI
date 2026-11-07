import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { LiveService } from './core/live.service';
import { SessionService } from './core/session.service';
import { answerNames, FakeSocket, hello, levelEvent, snapshot } from '../testing/fake-socket';

/** Monta o app com sessão já aberta e o WebSocket falso. */
async function boot(role: 'operator' | 'musician' | null) {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'lab' }), { status: 200 })));
  const fixture = TestBed.createComponent(App);
  const session = TestBed.inject(SessionService);
  if (role) {
    session.token.set('tok');
    session.role.set(role);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  const ws = FakeSocket.all.at(-1);
  if (ws) {
    ws.open();
    ws.receive(hello(role === 'musician' ? 'musician' : 'operator'));
    answerNames(ws);
    ws.receive(snapshot(0));
    await Promise.resolve();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  return { fixture, ws, session, el: fixture.nativeElement as HTMLElement, live: TestBed.inject(LiveService) };
}

describe('aplicação', () => {
  beforeEach(() => {
    try {
      sessionStorage.clear();
    } catch {
      /* ignora */
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sem sessão: tela de PIN com teclado numérico', async () => {
    const { el } = await boot(null);
    expect(el.querySelector('mx-login')).not.toBeNull();
    expect(el.querySelectorAll('.keypad .key').length).toBe(12);
  });

  it('autentica no WebSocket com o token (nunca na URL)', async () => {
    const { ws } = await boot('operator');
    expect(ws!.url).toMatch(/\/ws$/);
    expect(ws!.sent[0]).toEqual({ type: 'auth', token: 'tok' });
  });

  it('operador: Mesa com os nomes reais, master separado e medidores simulados pedidos', async () => {
    const { el, ws } = await boot('operator');
    const names = [...el.querySelectorAll('.strips .strip-name')].map((n) => n.textContent!.trim());
    expect(names).toEqual(['Cavaco', 'Violão', 'Voz Fred']);
    expect(el.querySelector('.master-area .strip-name')!.textContent!.trim()).toBe('MASTER');
    expect(ws!.last('meters')).toEqual({ type: 'meters', on: true, hz: 12 });
  });

  it('EQ LAB é uma ação da faixa de estado; o seletor contém somente PA e FONES', async () => {
    const { el, fixture } = await boot('operator');
    expect([...el.querySelectorAll('.segmented button')].map(b => b.textContent!.trim())).toEqual(['PA', 'FONES']);
    expect(el.querySelector('.toolbar [status-action]')).toBeNull();
    const eq = el.querySelector('mx-status-bar [status-action]') as HTMLButtonElement;
    expect(eq.textContent!.trim()).toBe('EQ LAB');
    eq.click(); fixture.detectChanges();
    expect(el.querySelector('mx-eq')).not.toBeNull();
  });

  it('a faixa de estado do operador não oferece EQ fora do LAB', async () => {
    const { el, live, fixture } = await boot('operator');
    expect(el.querySelector('[status-action]')).not.toBeNull();
    live.hello.update(h => h ? { ...h, mode: 'real', role: 'operator' } : h);
    fixture.detectChanges();
    expect(el.querySelector('[status-action]')).toBeNull();
  });

  it('PA ↔ FONES troca o que é mostrado sem mandar nenhum comando', async () => {
    const { el, ws, fixture } = await boot('operator');
    const sentBefore = ws!.sent.length;
    const values = () => [...el.querySelectorAll('.strips .strip-value')].map((v) => v.textContent!.trim());
    expect(values()).toEqual(['−10.0 dB', '−10.0 dB', '−10.0 dB']);
    (el.querySelectorAll('.segmented button')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(values()).toEqual(['−20.0 dB', '−20.0 dB', '−20.0 dB']);
    expect(el.querySelector('.shared-warning')!.textContent).toContain('TODOS');
    (el.querySelectorAll('.segmented button')[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(values()).toEqual(['−10.0 dB', '−10.0 dB', '−10.0 dB']);
    expect(ws!.sent.length).toBe(sentBefore); // só trocou a vista
  });

  it('músico: só a tela de Fones, com aviso de retorno compartilhado e sem master', async () => {
    const { el } = await boot('musician');
    expect(el.querySelector('[status-action]')).toBeNull();
    expect(el.querySelector('mx-fones')).not.toBeNull();
    expect(el.querySelector('mx-mesa')).toBeNull();
    expect(el.textContent).not.toContain('MASTER');
    expect(el.querySelector('.shared-warning')!.textContent).toContain('Isto muda o fone de TODOS');
  });

  it('músico: + manda set_level relativo de 2 dB no AUX 1', async () => {
    const { el, ws } = await boot('musician');
    (el.querySelector('.step-up') as HTMLButtonElement).click();
    expect(ws!.last('command')!['command']).toEqual({ type: 'set_level', channel: 1, aux: 1, deltaDB: 2 });
  });

  it('atualização vinda de outro aparelho aparece na tela', async () => {
    const { el, ws, fixture } = await boot('operator');
    ws!.receive(levelEvent(0, 'ch.2.main.level', -3));
    fixture.detectChanges();
    expect(el.querySelectorAll('.strips .strip-value')[1]!.textContent!.trim()).toBe('−3.0 dB');
  });

  it('cartão de operação crítica: Aprovar manda approve com o pendingId', async () => {
    const { el, ws, fixture } = await boot('operator');
    ws!.receive({
      type: 'pending',
      card: {
        pendingId: 'p1',
        status: 'open',
        title: 'volume do master',
        summary: 'Mudar o MASTER (som geral) de −6 dB para −12 dB.',
        command: { type: 'set_master', db: -12 },
        requestedBy: { role: 'agent', label: 'assistente (MCP)' },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    fixture.detectChanges();
    expect(el.querySelector('.card h3')!.textContent).toContain('master');
    expect(el.querySelector('.card-summary')!.textContent).toContain('−12 dB');
    (el.querySelector('.btn-approve') as HTMLButtonElement).click();
    expect(ws!.last('approve')).toMatchObject({ type: 'approve', pendingId: 'p1' });
    ws!.receive({ type: 'pending_resolved', pendingId: 'p1', status: 'invalidated' });
    fixture.detectChanges();
    expect(el.querySelector('.card')).toBeNull();
    expect(el.querySelector('.toast-error')!.textContent).toContain('invalidada');
  });

  it('servidor fora: controles desabilitados e aviso; ao voltar, novo snapshot', async () => {
    vi.useFakeTimers();
    const { el, ws, fixture } = await boot('operator');
    ws!.close(1006);
    fixture.detectChanges();
    expect(el.querySelector('.offline-banner')).not.toBeNull();
    expect((el.querySelector('.mute') as HTMLButtonElement).disabled).toBe(true);
    vi.advanceTimersByTime(600); // reconexão automática
    const again = FakeSocket.all.at(-1)!;
    expect(again).not.toBe(ws);
    again.open();
    again.receive(hello());
    answerNames(again);
    again.receive(snapshot(4, 'srv-1', { 'ch.1.main.level': { value: { status: 'known', value: -1 }, revision: 4 } }));
    fixture.detectChanges();
    expect(el.querySelector('.offline-banner')).toBeNull();
    expect(el.querySelector('.strips .strip-value')!.textContent!.trim()).toBe('−1.0 dB');
    vi.useRealTimers();
  });

  it('sessão vencida (4401 com motivo): volta para o PIN explicando que venceu', async () => {
    const { el, ws, fixture } = await boot('operator');
    ws!.receive({ type: 'error', code: 'UNAUTHORIZED', reason: 'expired', message: 'Sessão vencida.' });
    ws!.close(4401);
    await Promise.resolve();
    fixture.detectChanges();
    expect(el.querySelector('mx-login')).not.toBeNull();
    expect(el.querySelector('.login-notice')!.textContent).toContain('venceu');
  });

  it('servidor reiniciado (sessão desconhecida, outra instância): volta para o PIN dizendo que reiniciou', async () => {
    const { el, ws, fixture } = await boot('operator');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ serverId: 'srv-novo', mode: 'lab' }), { status: 200 })));
    ws!.receive({ type: 'error', code: 'UNAUTHORIZED', reason: 'unknown_session', message: 'Sessão inválida.' });
    ws!.close(4401);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.login-notice')!.textContent).toContain('reiniciado');
  });

  it('sessão encerrada por Sair em outra tela: aviso próprio', async () => {
    const { el, ws, fixture } = await boot('operator');
    ws!.receive({ type: 'error', code: 'UNAUTHORIZED', reason: 'logout', message: 'Sessão encerrada.' });
    ws!.close(4401);
    await Promise.resolve();
    fixture.detectChanges();
    expect(el.querySelector('.login-notice')!.textContent).toContain('encerrada');
  });
});


it('shared musician login without operator binding shows no channel controls; revocation removes them', async () => {
  const { live, fixture, el } = await boot('musician');
  live.musicianBinding.set(null);
  fixture.detectChanges();
  expect(el.querySelectorAll('.fones-row')).toHaveLength(0);
  expect(el.textContent).toContain('Peça ao operador');
  live.musicianBinding.set({ schemaVersion: 1, sessionId: 'test-session', musicianId: 'fred', name: 'Fred', channels: [3], mute: false, revision: 1 });
  fixture.detectChanges();
  expect(el.querySelectorAll('.fones-row')).toHaveLength(1);
  expect(el.textContent).toContain('Meus canais — Fred');
  expect((el.querySelector('.mute-toggle') as HTMLButtonElement).disabled).toBe(true);
  live.musicianBinding.set(null);
  fixture.detectChanges();
  expect(el.querySelectorAll('.step-up')).toHaveLength(0);
});
