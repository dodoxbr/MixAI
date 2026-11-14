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
  styles: [':host.is-selected { outline:2px solid var(--brass); outline-offset:-2px; } .strip-select { min-height:48px; background:none; border:0; padding:0; color:inherit; cursor:pointer; border-radius:4px; }'],
  host: { class: 'mx-strip', '[class.is-master]': 'master()', '[class.is-muted]': 'muted()', '[class.is-selected]': 'selected()' },
  template: `
    @if (selectable()) {
      <button type="button" class="strip-name strip-select" [title]="name()" [attr.aria-label]="'Selecionar CH' + number() + ' — ' + name()" [attr.aria-pressed]="selected()" (click)="chosen.emit()">{{ name() }}</button>
    } @else { <div class="strip-name" [title]="name()">{{ name() }}</div> }
    <div class="strip-number">{{ master() ? 'PA' : 'CH ' + number() }}</div>
    <div class="strip-body">
      @if (showMeter()) {
        <mx-meter [level]="meter()" [simulated]="simulated()" />
      }
      <mx-fader [value]="db()" [disabled]="disabled()" [label]="name() + ' ' + where()" (moved)="moved.emit($event)" />
    </div>
    <div class="strip-value" [class.is-unknown]="db() === null">{{ valueText() }}</div>
    @if(sendView()){<small class="send-topology">PRE/POST: —</small>}
    @if (!master()) {
      <button
        type="button"
        class="mute"
        [class.on]="muted()"
        [disabled]="disabled() || mute().status !== 'known' || busy()"
        [attr.aria-pressed]="mute().status==='known'?muted():null"
        (click)="toggleMute.emit()"
      >
        {{ busy() ? '…' : mute().status!=='known' && sendView()?'MUTE — ?':'MUTE' }}
      </button>
    } @else {
      <div class="master-note">aprovação no cartão</div>
    }
  `,
})
export class StripComponent {
  readonly sendView=input(false);
  readonly name = input.required<string>();
  readonly selectable = input(false);
  readonly selected = input(false);
  readonly chosen = output<void>();
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
    if (l.status === 'unknown') return this.sendView()?'Desconhecido':'?';
    return `${formatDb(this.db())} dB`;
  });
}
