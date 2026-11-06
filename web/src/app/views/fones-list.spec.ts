import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';

async function boot(access: 'fones_only' | 'pa_without_master' = 'fones_only') {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const fixture = TestBed.createComponent(App);
  const session = TestBed.inject(SessionService);
  session.token.set('tok');
  session.role.set('musician');
  fixture.detectChanges();
  await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  ws.receive({ ...hello('musician'), musicianAccess: access });
  answerNames(ws);
  ws.receive(snapshot(0));
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  await settle();
  const muteCommands = () => ws.sent.filter((m) => m['type'] === 'command' && (m['command'] as { type: string }).type === 'set_mute');
  return { ws, el, settle, muteCommands };
}

describe('MUTE rápido do músico', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('FONES: o comando leva o AUX autorizado; toques repetidos durante o pedido viram um só', async () => {
    const { el, settle, muteCommands } = await boot();
    const btn = el.querySelector('[data-testid="mute-fones-1"]') as HTMLButtonElement;
    expect(btn.textContent).toContain('MUTE');
    expect(btn.textContent).toContain('FONES');
    btn.click();
    btn.click();
    await settle();
    expect(btn.disabled).toBe(true); // pendente
    btn.click();
    expect(muteCommands()).toHaveLength(1);
    expect(muteCommands()[0]!['command']).toEqual({ type: 'set_mute', channels: [1], muted: true, aux: 1 });
    expect(el.textContent).toContain('o som do público (PA) não muda');
  });

  it('PA (pa_without_master): o comando vai sem AUX, um canal só', async () => {
    const { el, settle, muteCommands } = await boot('pa_without_master');
    const paTab = [...el.querySelectorAll('[role=tab]')].find((b) => b.textContent!.trim() === 'PA') as HTMLButtonElement;
    paTab.click();
    await settle();
    (el.querySelector('[data-testid="mute-pa-2"]') as HTMLButtonElement).click();
    await settle();
    expect(muteCommands()[0]!['command']).toEqual({ type: 'set_mute', channels: [2], muted: true, aux: undefined });
  });

  it('sem conexão: MUTE desabilitado e nada é enviado', async () => {
    const { ws, el, settle, muteCommands } = await boot();
    ws.close(1006);
    await settle();
    const btn = el.querySelector('[data-testid="mute-fones-1"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(muteCommands()).toHaveLength(0);
  });
});
