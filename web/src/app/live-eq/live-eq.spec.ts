import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LiveEqComponent } from './live-eq.component';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { processingFixture } from './processing-fixture';
async function boot(
  fetcher = vi.fn(async () => new Response(JSON.stringify(processingFixture()))),
) {
  vi.stubGlobal('fetch', fetcher);
  const live = {
    hello: signal({ mode: 'real', serverId: 'srv-1' }),
    connection: signal('online'),
    channels: signal([
      { number: 3, name: 'Voz Fred' },
      { number: 2, name: 'Violão' },
    ]),
  };
  TestBed.configureTestingModule({ providers: [{ provide: LiveService, useValue: live }] });
  const session = TestBed.inject(SessionService);
  session.token.set('fixture');
  session.role.set('operator');
  const fixture = TestBed.createComponent(LiveEqComponent);
  fixture.componentRef.setInput('channel', 3);
  const settle = async () => {
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  };
  await settle();
  await settle();
  return { fixture, session, live, settle, el: fixture.nativeElement as HTMLElement, fetcher };
}
afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('renders all observed fields read-only, with no editable parameters or write requests', async () => {
  const { el, fetcher, fixture } = await boot();
  expect(el.textContent).toContain('6.640 Hz');
  expect(el.textContent).toContain('-1,0 dB');
  expect(el.textContent).toContain('98 Hz');
  expect(el.querySelectorAll('[data-band]').length).toBe(4);
  expect(el.querySelector('svg path')).not.toBeNull();
  expect(el.querySelector('input')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith(
    '/api/ui16/processing/3',
    expect.objectContaining({ cache: 'no-store', credentials: 'omit' }),
  );
  expect(
    fetcher.mock.calls.every((call) => !('method' in ((call as unknown[])[1] as object))),
  ).toBe(true);
  fixture.destroy();
});
it('clears on channel change and discards delayed responses from the previous channel', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => new Promise<Response>((r) => (finish = r)))
    .mockResolvedValueOnce(new Response(JSON.stringify(processingFixture(2))));
  const { fixture, settle, el } = await boot(fetcher);
  fixture.componentRef.setInput('channel', 2);
  await settle();
  await settle();
  expect(el.textContent).toContain('CH2 — Violão');
  finish(new Response(JSON.stringify(processingFixture(3))));
  await settle();
  expect(el.textContent).toContain('CH2 — Violão');
  expect(fixture.componentInstance.service.view()?.parameters['ch.3.eq.b4.gain']).toBeUndefined();
});
it('clears private observations on disconnect and revocation; does not read for musician or LAB', async () => {
  const { fixture, live, session, el, settle, fetcher } = await boot();
  expect(el.textContent).toContain('6.640 Hz');
  live.connection.set('offline');
  await settle();
  expect(el.textContent).not.toContain('6.640 Hz');
  expect(el.querySelector('svg')).toBeNull();
  live.connection.set('online');
  session.role.set('musician');
  await settle();
  expect(el.textContent).toContain('requer operador');
  session.role.set('operator');
  live.hello.set({ mode: 'lab', serverId: 'srv-1' });
  await settle();
  const before = fetcher.mock.calls.length;
  session.token.set(null);
  await settle();
  expect(fetcher.mock.calls.length).toBe(before);
});
it('reports denied and slow requests without preserving old confirmation', async () => {
  const { el } = await boot(vi.fn(async () => new Response('{}', { status: 403 })));
  expect(el.textContent).toContain('Sessão sem autorização');
  expect(el.querySelector('svg')).toBeNull();
});
it('times out, clears observations and retries only GET; cancellation aborts pending read', async () => {
  vi.useFakeTimers();
  let aborted = false;
  const fetcher = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  );
  const { fixture, el, settle, session } = await boot(fetcher as any);
  await vi.advanceTimersByTimeAsync(6001);
  await settle();
  expect(el.textContent).toContain('Leitura demorou');
  expect(el.querySelector('svg')).toBeNull();
  expect(aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  await settle();
  expect(fetcher.mock.calls.length).toBe(2);
  aborted = false;
  session.token.set(null);
  await settle();
  expect(aborted).toBe(true);
  fixture.destroy();
});
it('displays communication errors and partial observations without a curve or fabricated fields', async () => {
  const partial = processingFixture();
  partial.parameters = Object.fromEntries(
    Object.entries(partial.parameters).filter(
      ([key]) => key.includes('.b4.') || key.includes('.hpf.') || key.endsWith('bypass'),
    ),
  );
  const { el, fixture, settle } = await boot(
    vi.fn(async () => new Response(JSON.stringify(partial))),
  );
  expect(el.textContent).toContain('6.640 Hz');
  expect(el.textContent).toContain('Desconhecido');
  expect(el.querySelector('svg')).toBeNull();
  fixture.destroy();
});
it('a delayed successful HTTP response cannot make an old observation fresh', async () => {
  vi.useFakeTimers();
  let resolve!: (r: Response) => void;
  const { fixture, settle, el } = await boot(
    vi.fn(() => new Promise<Response>((r) => (resolve = r))) as any,
  );
  await vi.advanceTimersByTimeAsync(4000);
  resolve(new Response(JSON.stringify(processingFixture())));
  await settle();
  await settle();
  expect(el.textContent).toContain('Última observação');
  expect(el.querySelector('[data-quality="confirmed"]')).toBeNull();
  fixture.destroy();
});
