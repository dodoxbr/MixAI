import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AssistantUiService } from '../core/assistant.service';
import { LiveService } from '../core/live.service';

/** Campo de comando discreto: "O que você deseja ajustar?" + Enviar. */
@Component({
  selector: 'mx-assistant-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-assistant-input' },
  template: `
    <form (submit)="$event.preventDefault(); submit()" role="search" aria-label="Assistente">
      <input
        type="text"
        name="pedido"
        autocomplete="off"
        enterkeyhint="send"
        maxlength="400"
        placeholder="O que você deseja ajustar?"
        aria-label="O que você deseja ajustar?"
        [value]="text()"
        (input)="text.set($any($event.target).value)"
        [disabled]="live.connection() !== 'online'"
      />
      <button type="submit" class="btn btn-primary" [disabled]="!text().trim() || assistant.thinking() || live.connection() !== 'online'">
        {{ assistant.thinking() ? '…' : 'Enviar' }}
      </button>
    </form>
  `,
})
export class AssistantInputComponent {
  readonly assistant = inject(AssistantUiService);
  readonly live = inject(LiveService);
  readonly text = signal('');

  submit(): void {
    const t = this.text();
    if (!t.trim()) return;
    this.text.set('');
    void this.assistant.send(t);
  }
}
