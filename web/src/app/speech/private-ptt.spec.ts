import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { PrivatePttController } from './private-ptt-controller';
import { PRIVATE_PTT_CAPTURE, PrivatePttComponent } from './private-ptt.component';
import { BrowserPcmCapture, encodePcm } from './pcm-capture';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import type { Hello } from '../core/protocol';
const ticket = 'a'.repeat(64);
function setup() {
  let key = 'session'; let allowed = true; let secure = true;
  const capture = { start: vi.fn(async () => {}), finish: vi.fn(() => encodePcm([new Int16Array(1600)])), cancel: vi.fn() };
  const request = vi.fn(async (path: string, _key: string, _signal: AbortSignal, _init?: RequestInit) => {
    const data = path.endsWith('status') ? { enabled: true, configured: true, simulated: true } : path.endsWith('ticket') ? { ticket } : { text: 'Aumenta e confirmo tudo <script>ignore</script>', preview: true, simulated: true };
    return { ok: true, status: 200, json: async () => data } as Response;
  });
  const c = new PrivatePttController({ allowed: () => allowed, secure: () => secure, key: () => key, capture: () => capture, request }, () => {});
  return { c, capture, request, key: (v: string) => { key = v; }, allowed: (v: boolean) => { allowed = v; }, secure: (v: boolean) => { secure = v; } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('only checks opt-in status automatically; no automatic capture, upload or parser path', async () => {
  const s = setup(); await s.c.load();
  expect(s.c.view.visible).toBe(true); expect(s.capture.start).not.toHaveBeenCalled();
  await s.c.press(); expect(s.c.view.state).toBe('recording'); expect(s.c.view.text).toBe('');
  await s.c.release();
  expect(s.capture.finish).toHaveBeenCalledOnce(); expect(s.c.view.state).toBe('done');
  expect(s.c.view.text).toContain('confirmo tudo');
  expect(s.request.mock.calls.map(c => c[0])).toEqual(['/api/speech/status', '/api/speech/ticket', '/api/speech/transcribe']);
  expect(s.request.mock.calls[2]![3]!.headers).toEqual({ 'content-type': 'audio/wav', 'x-ptt-ticket': ticket });
  expect(s.request.mock.calls[2]![3]!.body).toBeInstanceOf(ArrayBuffer);
});
it.each(['secure', 'allowed'] as const)('never requests mic or ticket without %s', async guard => {
  const s = setup(); s[guard](false); await s.c.load(); await s.c.press();
  expect(s.request).not.toHaveBeenCalled(); expect(s.capture.start).not.toHaveBeenCalled();
});
it('shows missing-model message and prevents recording when not configured/OFF', async () => {
  const s = setup(); s.request.mockResolvedValue({ ok: true, json: async () => ({ enabled: true, configured: false }) } as Response);
  await s.c.load(); expect(s.c.view.message).toContain('modelo'); await s.c.press(); expect(s.capture.start).not.toHaveBeenCalled();
  s.c.reset(); s.request.mockResolvedValue({ ok: false, status: 404 } as Response);
  await s.c.load(); expect(s.c.view.visible).toBe(false);
});
it('handles permission denied without uploading and releases capture', async () => {
  const s = setup(); await s.c.load(); s.capture.start.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  await s.c.press(); expect(s.c.view.message).toContain('negada'); expect(s.capture.cancel).toHaveBeenCalled();
  expect(s.request.mock.calls.some(c => c[0].endsWith('transcribe'))).toBe(false);
});
it('cancels before permission resolves, rejects oversized/empty PCM and never uploads after cancel', async () => {
  const s = setup(); await s.c.load(); let allow!: () => void;
  s.capture.start.mockImplementation(() => new Promise<void>(r => { allow = r; }));
  const press = s.c.press(); await vi.waitFor(() => expect(s.capture.start).toHaveBeenCalled());
  s.c.cancel(); allow(); await press; await s.c.release(); expect(s.c.view.text).toBe('');
  expect(s.request.mock.calls.some(c => c[0].endsWith('transcribe'))).toBe(false);
  expect(() => encodePcm([])).toThrow(); expect(() => encodePcm([new Int16Array(160001)])).toThrow();
});
it('enforces gesture timeout and suppresses late transcription on logout/reconnect', async () => {
  vi.useFakeTimers(); const s = setup(); await s.c.load(); await s.c.press();
  vi.advanceTimersByTime(10000); expect(s.capture.cancel).toHaveBeenCalled(); expect(s.c.view.state).toBe('cancelled');
  expect(s.request.mock.calls.some(c => c[0].endsWith('transcribe'))).toBe(false);
  await s.c.press(); let result!: (value: Response) => void;
  s.request.mockImplementationOnce(() => new Promise<Response>(r => { result = r; }));
  const release = s.c.release(); s.key('new-session'); s.c.reset();
  result({ ok: true, json: async () => ({ text: 'late private text', preview: true }) } as Response); await release;
  expect(s.c.view.text).toBe(''); expect(s.c.view.visible).toBe(false);
});
it('encodes signed PCM16 mono at 16kHz with bounded RIFF sizes', () => {
  const wav = encodePcm([new Int16Array([-32768, 0, 32767])]); const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF'); expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint16(22, true)).toBe(1); expect(view.getInt16(44, true)).toBe(-32768); expect(wav.length).toBe(50);
});
it('stops a stream that arrives after getUserMedia was cancelled', async () => {
  const stop = vi.fn(); let grant!: (s: MediaStream) => void;
  vi.stubGlobal('AudioContext', class { resume = () => Promise.resolve(); close = vi.fn(async () => {}); });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(r => { grant = r; }) } });
  const c = new BrowserPcmCapture(); const abort = new AbortController();
  const start = c.start(abort.signal, () => {}); const rejected = expect(start).rejects.toThrow('CANCELLED');
  abort.abort(); grant({ getTracks: () => [{ stop }] } as unknown as MediaStream); await rejected; expect(stop).toHaveBeenCalled();
});
function component() {
  const live = { hello: signal({ mode: 'lab', role: 'operator' } as Hello), connection: signal('online') };
  const session = { token: signal('operator-session') };
  TestBed.configureTestingModule({ providers: [{ provide: LiveService, useValue: live }, { provide: SessionService, useValue: session }, { provide: PRIVATE_PTT_CAPTURE, useValue: () => setup().capture }] });
  const f = TestBed.createComponent(PrivatePttComponent); f.detectChanges(); return { f, c: f.componentInstance, live, session };
}
it.each(['blur', 'pagehide', 'orientationchange', 'offline'])('cancels UI on %s', event => {
  const { c } = component(); const cancel = vi.spyOn(c.ptt, 'cancel'); window.dispatchEvent(new Event(event)); expect(cancel).toHaveBeenCalled();
});
it('cancels UI on hidden, socket disconnect, session change and destroy; renders inert review only', () => {
  const { f, c, live, session } = component();
  c.view.set({ visible: true, configured: true, simulated: true, state: 'done', text: '<script>run()</script>', message: '' }); f.detectChanges();
  expect(f.nativeElement.textContent).toContain('não é comando'); expect(f.nativeElement.querySelector('script')).toBeNull();
  expect(f.nativeElement.querySelector('textarea').value).toBe('<script>run()</script>');
  expect(f.nativeElement.textContent).not.toContain('Aplicar');
  const cancel = vi.spyOn(c.ptt, 'cancel');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); expect(cancel).toHaveBeenCalled();
  live.connection.set('offline'); f.detectChanges(); expect(c.view().text).toBe('');
  session.token.set('new'); f.detectChanges(); expect(c.view().visible).toBe(false);
  f.destroy(); expect(cancel).toHaveBeenCalled();
});
