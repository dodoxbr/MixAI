import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { StatusBarComponent } from '../ui/status-bar.component';
import { ToastsComponent } from '../ui/toasts.component';
import { FonesListComponent } from './fones-list.component';
import { AssistantInputComponent } from '../assistant/assistant-input.component';
import { AssistantPanelComponent } from '../assistant/assistant-panel.component';
import { AssistantUiService } from '../core/assistant.service';

/**
 * Tela do músico (celular). Sem master e sem aprovações.
 * - fones_only (padrão): só os FONES (AUX dos músicos).
 * - pa_without_master: abas FONES e PA, bem identificadas; no PA só passos discretos e mute de
 *   um canal (o servidor confere tudo de novo, inclusive o limite de 3 dB).
 */
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
    @if (paAllowed()) {
      <div class="toolbar musician-tabs">
        <div class="segmented" role="tablist" aria-label="Destino">
          <button type="button" role="tab" [attr.aria-selected]="target() === 'fones'" [class.on]="target() === 'fones'" (click)="tab.set('fones')">FONES</button>
          <button type="button" role="tab" [attr.aria-selected]="target() === 'pa'" [class.on]="target() === 'pa'" (click)="tab.set('pa')">PA</button>
        </div>
      </div>
    }
    <mx-fones-list [target]="target()">
      <!-- depois do aviso do destino, antes da lista -->
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
  /** O servidor diz qual política está em vigor; a tela só mostra o que ele permite. */
  readonly paAllowed = computed(() => this.live.hello()?.musicianAccess === 'pa_without_master');
  readonly tab = signal<'fones' | 'pa'>('fones');
  readonly target = computed(() => (this.paAllowed() ? this.tab() : 'fones'));
}
