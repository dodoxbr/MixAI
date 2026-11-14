import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { FakeSocket, hello, snapshot, answerNames } from '../../testing/fake-socket';
afterEach(() => vi.unstubAllGlobals());
it('six selections use independent observed keys, keep PA intact and never send a command', async () => {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
  const fixture = TestBed.createComponent(App),
    session = TestBed.inject(SessionService);
  session.token.set('operator');
  session.role.set('operator');
  fixture.detectChanges();
  await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  ws.receive({ ...hello(), mode: 'real', model: 'ui16' });
  answerNames(ws);
  ws.receive(snapshot());
  const live = TestBed.inject(LiveService);
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  };
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const tab = Array.from(el.querySelectorAll<HTMLElement>('[role=tab]')).find(
    (b) => b.textContent?.trim() === 'AUX SENDS',
  )!;
  tab.click();
  await settle();
  expect(el.querySelectorAll('.aux-selector button')).toHaveLength(6);
  const before = ws.sent.length,
    pa = live.state()!.params['ch.1.main.level'];
  (el.querySelectorAll('.aux-selector button')[5] as HTMLButtonElement).click();
  await settle();
  expect(el.querySelector('.aux-selector button.on')?.textContent).toContain('AUX 6');
  expect(el.textContent).toContain('PRE/POST: indisponível');
  expect(el.textContent).toContain('MASTER AUX 6');
  expect(el.textContent).not.toContain('muda o fone de TODOS');
  expect(live.state()!.params['ch.1.main.level']).toEqual(pa);
  expect(ws.sent.length).toBe(before);expect(el.querySelectorAll('.strips mx-fader .thumb')).toHaveLength(0);
  expect(
    Array.from(el.querySelectorAll('.strips .mute')).every(
      (b) => (b as HTMLButtonElement).disabled,
    ),
  ).toBe(true);
});
