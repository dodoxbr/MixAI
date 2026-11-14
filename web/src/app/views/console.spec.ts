import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';

/** Redesign do console (navegação MIX/GAIN · EDIT · AUX SENDS · FX SENDS). Só apresentação: nada é enviado à mesa. */
async function boot(mode: 'lab' | 'real' = 'lab') {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const fixture = TestBed.createComponent(App);
  const session = TestBed.inject(SessionService);
  session.token.set('tok'); session.role.set('operator');
  fixture.detectChanges(); await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!; ws.open();
  ws.receive({ ...hello('operator'), mode });
  answerNames(ws); ws.receive(snapshot(0));
  await Promise.resolve(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, ws, el, live: TestBed.inject(LiveService), tab: (id: string) => el.querySelector(`[role=tab][data-view=${id}]`) as HTMLButtonElement };
}
const tabsText = (el: HTMLElement) => [...el.querySelectorAll('.console-nav [role=tab]')].map(b => b.textContent!.trim());

describe('console da mesa', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('navegação principal na ordem MIX / GAIN, EDIT, AUX SENDS, FX SENDS, com MIX / GAIN inicial', async () => {
    const { el, tab } = await boot();
    expect(tabsText(el)).toEqual(['MIX / GAIN', 'EDIT', 'AUX SENDS', 'FX SENDS']);
    expect(tab('mix').getAttribute('aria-selected')).toBe('true');
    expect(tab('edit').getAttribute('aria-selected')).toBe('false');
  });

  it('MIX / GAIN: valor em dB, MUTE e SOLO desabilitado, nome e CH n, master separado', async () => {
    const { el } = await boot();
    const strip = el.querySelector('.strips mx-strip') as HTMLElement;
    expect(strip.querySelector('.strip-value')!.textContent).toContain('dB');
    expect(strip.querySelector('.mute')!.textContent!.trim()).toBe('MUTE');
    const solo = strip.querySelector('.solo') as HTMLButtonElement;
    expect(solo.disabled).toBe(true); expect(solo.getAttribute('aria-disabled')).toBe('true');
    expect(strip.querySelector('.strip-number')!.textContent).toMatch(/^CH \d+$/);
    expect(el.querySelector('.master-area .strip-name')!.textContent!.trim()).toBe('MASTER');
    expect(el.querySelector('.strips .strip-name')).not.toBeNull();
  });

  it('SOLO nunca emite comando nem altera estado', async () => {
    const { el, ws, fixture } = await boot();
    const before = ws.sent.length;
    (el.querySelector('.strips .solo') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(ws.sent.length).toBe(before);
  });

  it('AUX SENDS mostra os barramentos AUX e as mesmas strips; MIX / GAIN volta ao PA sem comandos', async () => {
    const { el, ws, fixture, tab } = await boot();
    const before = ws.sent.length;
    tab('aux').click(); fixture.detectChanges();
    expect(el.querySelector('.aux-selector')).not.toBeNull();
    expect(el.querySelectorAll('.strips mx-strip').length).toBeGreaterThan(0);
    expect(el.querySelector('.strips .solo')).not.toBeNull();
    tab('mix').click(); fixture.detectChanges();
    expect(el.querySelector('.aux-selector')).toBeNull();
    expect(ws.sent.length).toBe(before);
  });

  it('EDIT: aba EQ selecionada; DYN, FX SENDS e AUX SENDS aparecem como indisponíveis e desabilitados', async () => {
    const { el, tab, fixture } = await boot();
    tab('edit').click(); fixture.detectChanges();
    expect(el.querySelector('.edit-main')).not.toBeNull();
    const eq = el.querySelector('[data-testid=edit-tab-eq]') as HTMLElement;
    expect(eq.getAttribute('aria-selected')).toBe('true');
    const others = [...el.querySelectorAll('.edit-tabs [role=tab]')].filter(b => b !== eq) as HTMLButtonElement[];
    expect(others.map(b => b.textContent!.replace('indisponível', '').trim())).toEqual(['DYN', 'FX SENDS', 'AUX SENDS']);
    expect(others.every(b => b.disabled && b.getAttribute('aria-disabled') === 'true')).toBe(true);
    // LAB: o EQ físico só existe no REAL; a tela explica em vez de mostrar controles que parecem funcionar
    expect(el.querySelector('[data-testid=edit-unavailable]')!.textContent).toContain('REAL');
    expect(el.querySelector('mx-live-eq')).toBeNull();
  });

  it('FX SENDS: estrutura visual apenas, sem valores nem controles ativos', async () => {
    const { el, ws, tab, fixture } = await boot();
    const before = ws.sent.length;
    tab('fx').click(); fixture.detectChanges();
    expect(el.querySelector('[data-testid=fx-unavailable]')!.textContent).toContain('indisponível');
    const buttons = [...el.querySelectorAll('.fx-main [role=tab]')] as HTMLButtonElement[];
    expect(buttons.length).toBe(4); expect(buttons.every(b => b.disabled)).toBe(true);
    expect(el.querySelector('.fx-main .strip-value')).toBeNull();
    expect(el.querySelector('.fx-main mx-fader')).toBeNull();
    expect(ws.sent.length).toBe(before);
  });

  it('ferramentas: menu com assistente, diagnóstico, cenas, histórico, base de conhecimento e configurações; assistente abre sem sair da mesa', async () => {
    const { el, fixture, tab } = await boot();
    (el.querySelector('[data-testid=tools-trigger]') as HTMLButtonElement).click(); fixture.detectChanges();
    const items = [...el.querySelectorAll('[data-testid=tools-menu] [role=menuitem]')].map(b => b.textContent!.replace(/\s+/g, ' ').trim());
    expect(items.map(t => t.split(' (')[0])).toEqual(['Assistente de IA', 'Diagnóstico', 'Cenas', 'Histórico', 'Base de conhecimento', 'Configurações e administração']);
    (el.querySelectorAll('[data-testid=tools-menu] [role=menuitem]')[0] as HTMLButtonElement).click(); fixture.detectChanges();
    expect(el.querySelector('mx-assistant-panel')).not.toBeNull();
    expect(el.querySelector('[data-testid=tools-menu]')).toBeNull();
    expect(tab('mix').getAttribute('aria-selected')).toBe('true'); // continua na mesa
    expect(el.querySelector('.strips mx-strip')).not.toBeNull();
  });

  it('REAL: EDIT embute o painel EQ/HPF (sem modal), somente leitura', async () => {
    const { el, tab, fixture } = await boot('real');
    tab('edit').click(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const panel = el.querySelector('mx-live-eq') as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('role')).toBe('region'); expect(panel!.getAttribute('aria-modal')).toBeNull();
    expect(panel!.classList.contains('embedded')).toBe(true);
    expect(panel!.querySelector('.channel-tabs')).not.toBeNull();
    expect(panel!.querySelector('input[type=range], [role=slider]')).toBeNull(); // nada editável
  });
});
