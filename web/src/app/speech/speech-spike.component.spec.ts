import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import type { Hello } from '../core/protocol';
import { SPEECH_SPIKE_ENABLED, SpeechSpikeComponent } from './speech-spike.component';

function boot(enabled?: boolean) {
  const live = { hello: signal({ mode: 'lab', role: 'operator' } as Hello), connection: signal('online') };
  TestBed.configureTestingModule({ providers: [
    { provide: LiveService, useValue: live },
    ...(enabled === undefined ? [] : [{ provide: SPEECH_SPIKE_ENABLED, useValue: enabled }]),
  ] });
  const f = TestBed.createComponent(SpeechSpikeComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, live };
}

it('is OFF by default, including for a LAB operator', () => {
  const { f, c } = boot();
  expect(f.nativeElement.querySelector('button')).toBeNull();
  expect(c.allowed()).toBe(false);
});

it('requires an online operator in LAB despite opt-in', () => {
  const { f, c, live } = boot(true);
  expect(f.nativeElement.querySelector('button')).not.toBeNull();
  for (const hello of [{ mode: 'real', role: 'operator' }, { mode: 'mock', role: 'operator' }, { mode: 'lab', role: 'musician' }]) {
    live.hello.set(hello as Hello);
    f.detectChanges();
    expect(c.allowed()).toBe(false);
    expect(f.nativeElement.querySelector('button')).toBeNull();
  }
  live.hello.set({ mode: 'lab', role: 'operator' } as Hello);
  live.connection.set('offline');
  f.detectChanges();
  expect(c.allowed()).toBe(false);
});

it.each(['pointercancel', 'lostpointercapture'])('cancels on %s', event => {
  const { f, c } = boot(true);
  const cancel = vi.spyOn(c.ptt, 'cancel');
  // Emulate an already captured primary pointer without requiring a real device.
  const button = f.nativeElement.querySelector('button');
  button.setPointerCapture = vi.fn();
  vi.spyOn(c.ptt, 'press').mockResolvedValue();
  c.press({ isPrimary: true, button: 0, pointerId: 1, currentTarget: button, preventDefault() {} } as unknown as PointerEvent);
  button.dispatchEvent(new Event(event));
  expect(cancel).toHaveBeenCalled();
});

it.each(['blur', 'pagehide', 'orientationchange', 'offline'])('cancels on window %s', event => {
  const { c } = boot(true);
  const cancel = vi.spyOn(c.ptt, 'cancel');
  window.dispatchEvent(new Event(event));
  expect(cancel).toHaveBeenCalled();
});

it('cancels when hidden, disconnected, or destroyed', () => {
  const { f, c, live } = boot(true);
  const cancel = vi.spyOn(c.ptt, 'cancel');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(cancel).toHaveBeenCalled();
  cancel.mockClear();
  live.connection.set('offline');
  f.detectChanges();
  expect(cancel).toHaveBeenCalled();
  cancel.mockClear();
  f.destroy();
  expect(cancel).toHaveBeenCalled();
  vi.restoreAllMocks();
});

it.each(['insecure', 'unavailable', 'denied'])('renders %s access failure without a transcript', async failure => {
  const { f, c } = boot(true);
  vi.stubGlobal('isSecureContext', failure !== 'insecure');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const getUserMedia = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
  vi.stubGlobal('navigator', { mediaDevices: failure === 'unavailable' ? undefined : { getUserMedia } });
  try {
    await c.ptt.press();
    f.detectChanges();
    const text = f.nativeElement.querySelector('[role=status]').textContent;
    expect(text).toContain(failure === 'insecure' ? 'HTTPS' : failure === 'unavailable' ? 'indisponível' : 'negada');
    expect(c.ptt.result).toBeUndefined();
    if (failure !== 'denied') expect(getUserMedia).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
