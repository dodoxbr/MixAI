import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { EqComponent } from './eq.component';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { ActionsService } from '../core/actions.service';
import type { Hello, Snapshot } from '../core/protocol';

function boot() {
  const params: Snapshot['params'] = {};
  for (const ch of [1, 2]) {
    for (const [i, freq] of [120, 500, 2000, 8000].entries()) {
      for (const [p, v] of Object.entries({ freq, q: 1, gain: 0 }))
        params[`ch.${ch}.eq.b${i + 1}.${p}`] = { value: { status: 'known', value: v }, revision: 0 };
    }
    for (const [p, v] of Object.entries({ 'hpf.freq': 20, 'hpf.slope': 12, bypass: false }))
      params[`ch.${ch}.eq.${p}`] = { value: { status: 'known', value: v }, revision: 0 };
  }
  const state = signal({ params } as Snapshot);
  const live = {
    state,
    writable: signal(true),
    channels: signal([
      { number: 1, name: 'Voz' },
      { number: 2, name: 'Surdo' },
    ]),
    hello: signal({ mode: 'lab', role: 'operator' } as Hello),
  };
  const busy = signal(new Set<string>());
  const run = vi.fn().mockResolvedValue({ ok: true, code: 'OK', message: 'Aplicado' });
  const session = { token: signal<string | null>('operator-session') };
  TestBed.configureTestingModule({
    providers: [
      { provide: SessionService, useValue: session },
      { provide: LiveService, useValue: live },
      { provide: ActionsService, useValue: { run, isBusy: (key: string) => busy().has(key) } },
    ],
  });
  const f = TestBed.createComponent(EqComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, live, run, session, busy };
}

it('reads canonical channel parameters and sends only a LAB EQ command, without optimistic state', () => {
  const { c, live, run } = boot();
  c.channel.set(2);
  c.set('b1.gain', 6);
  expect(run).toHaveBeenCalledWith('eq', { type: 'set_lab_eq', channel: 2, values: { 'ch.2.eq.b1.gain': 6 } });
  expect(c.eq()!.bands[0]!.gain).toBe(0);
  live.state.update((s) => ({ ...s, params: { ...s.params, 'ch.2.eq.b1.gain': { value: { status: 'known', value: 6 }, revision: 1 } } }));
  expect(c.eq()!.bands[0]!.gain).toBe(6);
});

it('unknown parameters do not invent a curve or defaults', () => {
  const { c, live, f } = boot();
  live.state.update((s) => ({ ...s, params: {} }));
  f.detectChanges();
  expect(c.eq()).toBeNull();
  expect(f.nativeElement.textContent).toContain('Aguardando parâmetros');
});

it('disables writes outside LAB, for musician and while offline', () => {
  const { c, live, run } = boot();
  live.hello.set({ mode: 'real', role: 'operator' } as Hello);
  c.set('b1.gain', 6);
  c.reset();
  live.hello.set({ mode: 'lab', role: 'musician' } as Hello);
  c.set('b1.gain', 6);
  live.hello.set({ mode: 'lab', role: 'operator' } as Hello);
  live.writable.set(false);
  c.reset();
  expect(run).not.toHaveBeenCalled();
});

it('keyboard edits clamp to registry limits and reset is per-channel', () => {
  const { c, run } = boot();
  c.key(new KeyboardEvent('keydown', { key: 'ArrowUp' }), 0);
  expect(run.mock.calls[0]![1].values).toEqual({ 'ch.1.eq.b1.gain': 0.5 });
  c.channel.set(2);
  c.reset();
  expect(run).toHaveBeenLastCalledWith('eq', { type: 'reset_lab_eq', channel: 2 });
});


it('selecting and cancelling a guide only previews; explicit apply sends the whole EQ once with no optimistic state', async () => {
  const { c, f, run } = boot();
  c.selectGuide('cavaco');
  f.detectChanges();
  expect(run).not.toHaveBeenCalled();
  expect(c.diff()).toHaveLength(15);
  expect(c.guidePath()).not.toBe(c.path());
  expect(f.nativeElement.querySelectorAll('.eq-diff tbody tr')).toHaveLength(15);
  expect(f.nativeElement.textContent).toContain('Contraindicações');
  expect(f.nativeElement.textContent).toContain('não medida na Ui16');
  c.cancelGuide();
  await c.applyGuide();
  expect(run).not.toHaveBeenCalled();
  c.selectGuide('cavaco');
  await c.applyGuide();
  await c.applyGuide();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![1]).toMatchObject({ type: 'set_lab_eq', channel: 1, values: { 'ch.1.eq.b2.gain': -2, 'ch.1.eq.hpf.freq': 80, 'ch.1.eq.bypass': false } });
  expect(Object.keys(run.mock.calls[0]![1].values)).toHaveLength(15);
  expect(c.eq()!.hpf.freq).toBe(20);
  expect(c.guideNotice()).toContain('somente no LAB');
});

it.each(['channel', 'revision', 'session', 'server', 'offline', 'musician', 'real', 'unknown'] as const)('invalidates preview on %s before a command can be sent', async change => {
  const { c, live, f, run, session } = boot();
  c.selectGuide('pandeiro');
  expect(c.reviewed()).not.toBeNull();
  if (change === 'channel') c.selectChannel(2);
  if (change === 'revision') live.state.update(s => ({ ...s, params: { ...s.params, 'ch.1.eq.b1.gain': { value: { status: 'known', value: 0 }, revision: 1 } } }));
  if (change === 'session') session.token.set('new-operator-session');
  if (change === 'server') live.hello.update(h => ({ ...h!, serverId: 'new-server' }));
  if (change === 'offline') live.writable.set(false);
  if (change === 'musician') live.hello.update(h => ({ ...h!, role: 'musician' }));
  if (change === 'real') live.hello.update(h => ({ ...h!, mode: 'real' }));
  if (change === 'unknown') live.state.update(s => ({ ...s, params: {} }));
  await c.applyGuide(); // even before Angular's effect/render cycle
  f.detectChanges();
  expect(c.reviewed()).toBeNull();
  expect(run).not.toHaveBeenCalled();
  live.writable.set(true);
  c.channel.set(1);
  f.detectChanges();
  expect(c.reviewed()).toBeNull();
});

it('manual EQ edits dismiss guide preview; undo uses the existing action and failed apply reports the server result', async () => {
  const { c, run } = boot();
  c.selectGuide('surdo');
  c.set('b1.gain', 2);
  expect(c.reviewed()).toBeNull();
  c.undo();
  expect(run).toHaveBeenLastCalledWith('undo', { type: 'undo' }, expect.any(Function));
  c.selectGuide('vozes');
  run.mockResolvedValueOnce({ ok: false, code: 'INDETERMINATE', message: 'Confira os valores antes de repetir.' });
  await c.applyGuide();
  expect(c.guideNotice()).toBe('Confira os valores antes de repetir.');
  expect(c.reviewed()).toBeNull();
});


it('does not open a guide while undo is awaiting the canonical state and result', () => {
  const { c, busy, run } = boot();
  busy.set(new Set(['undo']));
  c.selectGuide('cavaco');
  expect(c.reviewed()).toBeNull();
  c.set('b1.gain', 1);
  expect(run).not.toHaveBeenCalled();
  busy.set(new Set());
  c.selectGuide('cavaco');
  expect(c.reviewed()?.id).toBe('cavaco');
});
