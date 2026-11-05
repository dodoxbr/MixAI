import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LiveService } from '../core/live.service';
import { StatusBarComponent } from '../ui/status-bar.component';
import { ToastsComponent } from '../ui/toasts.component';
import { FonesListComponent } from './fones-list.component';

/** Tela do músico (celular): só os fones (AUX 1). Sem PA, sem master, sem aprovações. */
@Component({
  selector: 'mx-fones',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusBarComponent, FonesListComponent, ToastsComponent],
  host: { class: 'mx-view mx-fones' },
  template: `
    <mx-status-bar />
    @if (!live.writable()) {
      <div class="offline-banner" role="alert">
        {{ live.connection() === 'online' ? 'A mesa não está pronta para comandos.' : 'Sem conexão com o servidor. Reconectando…' }}
      </div>
    }
    <mx-fones-list />
    <mx-toasts />
  `,
})
export class FonesComponent {
  readonly live = inject(LiveService);
}
