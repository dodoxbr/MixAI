import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { SessionService } from '../core/session.service';
import type { Hello } from '../core/protocol';

/** Tela de PIN com teclado numérico grande (toque) e entrada pelo teclado físico. */
@Component({
  selector: 'mx-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-login' },
  template: `
    <form class="login-box" (submit)="$event.preventDefault(); enter()">
      <div class="brand big">MixAI</div>
      @if (hello(); as h) {
        <div class="login-mode" [class.mode-real]="h.mode === 'real'">{{ h.mode === 'real' ? 'MESA REAL' : 'LABORATÓRIO' }}</div>
      }
      @if (session.notice(); as n) {
        <p class="login-notice" role="alert">{{ n }}</p>
      }
      <label for="pin">PIN</label>
      <input
        id="pin"
        name="pin"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        maxlength="8"
        [value]="pin()"
        (input)="typed($any($event.target).value)"
      />
      <div class="keypad" role="group" aria-label="Teclado numérico">
        @for (d of digits; track d) {
          <button type="button" class="key" (click)="press(d)">{{ d }}</button>
        }
        <button type="button" class="key key-muted" (click)="pin.set('')" aria-label="Limpar">C</button>
        <button type="button" class="key" (click)="press('0')">0</button>
        <button type="button" class="key key-muted" (click)="pin.set(pin().slice(0, -1))" aria-label="Apagar">⌫</button>
      </div>
      @if (error(); as e) {
        <p class="login-error" role="alert">{{ e }}</p>
      }
      <button type="submit" class="btn btn-primary btn-wide" [disabled]="pin().length < 4 || loading()">
        {{ loading() ? 'Entrando…' : 'Entrar' }}
      </button>
    </form>
  `,
})
export class LoginComponent {
  readonly session = inject(SessionService);
  readonly pin = signal('');
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly hello = signal<Hello | null>(null);
  readonly digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  constructor() {
    void this.session.hello().then((h) => this.hello.set(h));
  }

  typed(value: string): void {
    this.pin.set(value.replace(/\D/g, '').slice(0, 8));
  }

  press(d: string): void {
    if (this.pin().length < 8) this.pin.update((p) => p + d);
  }

  async enter(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const err = await this.session.login(this.pin());
    this.loading.set(false);
    if (err) {
      this.error.set(err);
      this.pin.set('');
    }
  }
}
