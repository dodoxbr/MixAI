import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { formatDb } from '../core/db';
import type { StateValue } from '../core/protocol';
import { FaderComponent, type FaderMove } from './fader.component';
import { MeterComponent } from './meter.component';

/** Um canal: nome, medidor, fader, valor em dB e MUTE. */
@Component({
  selector: 'mx-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FaderComponent, MeterComponent],
  host: { class: 'mx-strip', '[class.is-master]': 'master()', '[class.is-muted]': 'muted()' },
  template: `
    <div class="strip-name" [title]="name()">{{ name() }}</div>
    <div class="strip-number">{{ master() ? 'PA' : 'CH ' + number() }}</div>
    <div class="strip-body">
      @if (showMeter()) {
        <mx-meter [level]="meter()" [simulated]="simulated()" />
      }
      <mx-fader [value]="db()" [disabled]="disabled()" [label]="name() + ' ' + where()" (moved)="moved.emit($event)" />
    </div>
    <div class="strip-value" [class.is-unknown]="db() === null">{{ valueText() }}</div>
    @if (!master()) {
      <button
        type="button"
        class="mute"
        [class.on]="muted()"
        [disabled]="disabled() || mute().status !== 'known' || busy()"
        [attr.aria-pressed]="muted()"
        (click)="toggleMute.emit()"
      >
        {{ busy() ? '…' : 'MUTE' }}
      </button>
    } @else {
      <div class="master-note">aprovação no cartão</div>
    }
  `,
})
export class StripComponent {
  readonly name = input.required<string>();
  readonly number = input(0);
  readonly where = input('no PA');
  readonly level = input<StateValue>({ status: 'unknown' });
  readonly mute = input<StateValue>({ status: 'unknown' });
  readonly meter = input<number | '-inf' | null>(null);
  readonly simulated = input(false);
  readonly showMeter = input(true);
  readonly disabled = input(false);
  readonly busy = input(false);
  readonly master = input(false);
  readonly moved = output<FaderMove>();
  readonly toggleMute = output<void>();

  readonly db = computed(() => {
    const l = this.level();
    return l.status === 'known' && typeof l.value === 'number' ? l.value : null;
  });
  readonly muted = computed(() => {
    const m = this.mute();
    return m.status === 'known' && m.value === true;
  });
  readonly valueText = computed(() => {
    const l = this.level();
    if (l.status === 'unavailable') return 'sem leitura';
    if (l.status === 'unknown') return '?';
    return `${formatDb(this.db())} dB`;
  });
}
