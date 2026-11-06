import { ChangeDetectionStrategy, Component, InjectionToken, effect, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { FixtureSpeechRecognizer, PushToTalk } from './speech-recognizer';

/** Explicit development opt-in; no URL/localStorage switch. */
export const SPEECH_SPIKE_ENABLED = new InjectionToken<boolean>('speech-spike-enabled', { providedIn: 'root', factory: () => false });

@Component({
  selector: 'mx-speech-spike',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:blur)': 'cancel()', '(window:pagehide)': 'cancel()',
    '(window:orientationchange)': 'cancel()', '(window:offline)': 'cancel()',
    '(document:visibilitychange)': 'visibility()',
  },
  template: `
    @if (allowed()) {
      <aside aria-label="Experimento de voz LAB">
        <p>LAB experimental — transcrição simulada. Nenhum comando será executado.</p>
        <button type="button" style="touch-action: none; user-select: none"
          (contextmenu)="$event.preventDefault()"
          (pointerdown)="press($event)" (pointerup)="release($event)"
          (pointercancel)="cancel()" (lostpointercapture)="cancelIfHeld()">
          Segure para testar o microfone
        </button>
        <p role="status" aria-live="polite">{{ status() }}</p>
      </aside>
    }
  `,
})
export class SpeechSpikeComponent {
  private readonly enabled = inject(SPEECH_SPIKE_ENABLED);
  private readonly live = inject(LiveService);
  readonly status = signal('idle');
  private pointer?: number;
  readonly allowed = () => this.enabled && this.live.hello()?.mode === 'lab' && this.live.hello()?.role === 'operator' && this.live.connection() === 'online';
  readonly ptt = new PushToTalk({
    allowed: () => this.allowed() && document.visibilityState !== 'hidden' && document.hasFocus(),
    secure: () => window.isSecureContext === true,
    available: () => typeof navigator.mediaDevices?.getUserMedia === 'function',
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
  }, new FixtureSpeechRecognizer(), () => this.status.set(this.ptt.error ?? this.ptt.result?.text ?? this.ptt.state));

  constructor() { effect(() => { if (!this.allowed()) this.cancel(); }); }
  press(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || this.pointer !== undefined) return;
    event.preventDefault();
    this.pointer = event.pointerId;
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }
    catch { this.cancel(); return; }
    void this.ptt.press();
  }
  release(event: PointerEvent): void {
    if (event.pointerId !== this.pointer) return;
    this.pointer = undefined;
    void this.ptt.release();
  }
  cancelIfHeld(): void { if (this.pointer !== undefined) this.cancel(); }
  cancel(): void { this.pointer = undefined; this.ptt.cancel(); }
  visibility(): void { if (document.visibilityState === 'hidden') this.cancel(); }
  ngOnDestroy(): void { this.cancel(); }
}
