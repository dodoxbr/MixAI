import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { EqComponent } from './eq.component';
import { LiveService } from '../core/live.service';
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
  const run = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: LiveService, useValue: live },
      { provide: ActionsService, useValue: { run, isBusy: () => false } },
    ],
  });
  const f = TestBed.createComponent(EqComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, live, run };
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
