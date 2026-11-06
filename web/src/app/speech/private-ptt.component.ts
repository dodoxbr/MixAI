import { ChangeDetectionStrategy, Component, InjectionToken, effect, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { BrowserPcmCapture, type PcmCapture } from './pcm-capture';
import { PrivatePttController, type PttView } from './private-ptt-controller';
export const PRIVATE_PTT_CAPTURE = new InjectionToken<() => PcmCapture>('private-ptt-capture', { providedIn: 'root', factory: () => () => new BrowserPcmCapture() });
@Component({
  selector: 'mx-private-ptt', changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:blur)': 'cancel()', '(window:pagehide)': 'cancel()', '(window:orientationchange)': 'cancel()', '(window:offline)': 'cancel()', '(document:visibilitychange)': 'visibility()' },
  template: `@if (view().visible) {
    <aside aria-label="Voz privada LAB" style="padding: 1rem">
      <strong>Prévia de voz — não é comando, nada será aplicado</strong>
      <p>LAB experimental. Segure para falar, até 10 segundos. Áudio processado apenas no Yoga.</p>
      @if (view().simulated) { <p>Reconhecimento simulado — não comprova STT real.</p> }
      <button type="button" [disabled]="!view().configured || view().state === 'transcribing'" style="touch-action: none; user-select: none"
        (contextmenu)="$event.preventDefault()" (pointerdown)="press($event)" (pointerup)="release($event)"
        (pointercancel)="cancel()" (lostpointercapture)="lost()"
        (keydown.space)="keyPress($event)" (keyup.space)="keyRelease($event)">Segure para falar (LAB)</button>
      <button type="button" (click)="cancel()">Cancelar e descartar</button>
      <p role="status" aria-live="polite">{{ view().state === 'recording' ? 'Microfone ativo — gravando enquanto segura' : view().state === 'permission' ? 'Preparando acesso ao microfone' : view().state === 'transcribing' ? 'Microfone parado — transcrevendo no Yoga' : view().state === 'done' ? 'Transcrição pronta para revisão' : 'Microfone parado' }}</p>
      @if (view().message) { <p role="alert">{{ view().message }}</p> }
      <textarea readonly autocomplete="off" [spellcheck]="false" aria-label="Transcrição para revisão" [value]="view().text"></textarea>
    </aside>
  }`,
})
export class PrivatePttComponent {
  private live = inject(LiveService); private session = inject(SessionService); private capture = inject(PRIVATE_PTT_CAPTURE);
  readonly view = signal<PttView>({ visible: false, configured: false, simulated: false, state: 'idle', text: '', message: '' });
  private pointer?: number;
  private allowed = () => this.live.hello()?.mode === 'lab' && this.live.hello()?.role === 'operator' && this.live.connection() === 'online' && !!this.session.token() && document.visibilityState !== 'hidden';
  readonly ptt = new PrivatePttController({ allowed: () => this.allowed(), secure: () => window.isSecureContext === true && location.protocol === 'https:', key: () => this.session.token(), capture: () => this.capture(),
    request: (path, key, signal, init) => fetch(path, { ...init, signal, mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { ...init?.headers, authorization: `Bearer ${key}` } }),
  }, () => this.view.set({ ...this.ptt.view }));
  constructor() { effect(() => { this.session.token(); this.live.hello(); this.live.connection(); this.ptt.reset(); if (this.allowed()) void this.ptt.load(); }); }
  press(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || this.pointer !== undefined || !document.hasFocus()) return;
    event.preventDefault(); this.pointer = event.pointerId;
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { this.cancel(); return; }
    void this.ptt.press();
  }
  release(event: PointerEvent): void { if (this.pointer === event.pointerId) { this.pointer = undefined; void this.ptt.release(); } }
  keyPress(event: Event): void { event.preventDefault(); if (!(event as KeyboardEvent).repeat) void this.ptt.press(); }
  keyRelease(event: Event): void { event.preventDefault(); void this.ptt.release(); }
  lost(): void { if (this.pointer !== undefined) this.cancel(); }
  cancel(): void { this.pointer = undefined; this.ptt.cancel(); }
  visibility(): void { if (document.visibilityState === 'hidden') this.cancel(); }
  ngOnDestroy(): void { this.ptt.reset(); }
}
