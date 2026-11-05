import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LiveService } from '../core/live.service';
import { StatusBarComponent } from '../ui/status-bar.component';
import { ToastsComponent } from '../ui/toasts.component';
import { FonesListComponent } from './fones-list.component';
import { AssistantInputComponent } from '../assistant/assistant-input.component';
import { AssistantPanelComponent } from '../assistant/assistant-panel.component';
import { AssistantUiService } from '../core/assistant.service';

/** Tela do músico (celular): só os fones (AUX 1). Sem PA, sem master, sem aprovações. */
@Component({
  selector: 'mx-fones',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusBarComponent, FonesListComponent, ToastsComponent, AssistantInputComponent, AssistantPanelComponent],
  host: { class: 'mx-view mx-fones' },
  template: `
    <mx-status-bar />
    @if (!live.writable()) {
      <div class="offline-banner" role="alert">
        {{ live.connection() === 'online' ? 'A mesa não está pronta para comandos.' : 'Sem conexão com o servidor. Reconectando…' }}
      </div>
    }
    <mx-fones-list>
      <!-- depois do aviso de retorno compartilhado, antes da lista -->
      <div class="fones-assist">
        <mx-assistant-input />
        @if (assistant.open()) {
          <mx-assistant-panel />
        } @else if (assistant.items().length) {
          <button type="button" class="btn btn-ghost btn-small" (click)="assistant.open.set(true)">Mostrar conversa</button>
        }
      </div>
    </mx-fones-list>
    <mx-toasts />
  `,
})
export class FonesComponent {
  readonly live = inject(LiveService);
  readonly assistant = inject(AssistantUiService);
}
