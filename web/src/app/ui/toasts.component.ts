import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LiveService } from '../core/live.service';

/** Retorno imediato das operações (resultado, recusa, aprovação). */
@Component({
  selector: 'mx-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-toasts', 'aria-live': 'polite' },
  template: `
    @for (t of live.toasts(); track t.id) {
      <div class="toast" [class]="'toast toast-' + t.kind">{{ t.text }}</div>
    }
  `,
})
export class ToastsComponent {
  readonly live = inject(LiveService);
}
