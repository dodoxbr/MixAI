import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AssistantUiService } from '../core/assistant.service';

/**
 * Campo de comando discreto: "O que você deseja ajustar?" + Enviar.
 * - O campo nunca fica bloqueado: dá para escrever mesmo sem conexão (o texto não se perde).
 * - O botão só fica desabilitado com o MOTIVO escrito ao lado (sem conexão, esperando resposta).
 * - O texto só sai do campo quando o pedido foi de fato enviado.
 */
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
        aria-describedby="assist-hint"
        [value]="text()"
        (input)="typed($any($event.target).value)"
      />
      <button type="submit" class="btn btn-primary" [disabled]="!!assistant.blockedReason()" [attr.aria-describedby]="hint() ? 'assist-hint' : null">
        {{ assistant.thinking() ? '…' : 'Enviar' }}
      </button>
      @if (hint(); as h) {
        <p id="assist-hint" class="assist-hint" role="status" data-testid="assist-hint">{{ h }}</p>
      }
    </form>
  `,
})
export class AssistantInputComponent {
  readonly assistant = inject(AssistantUiService);
  readonly text = signal('');
  /** "Escreva o que deseja ajustar" depois de tocar em Enviar com o campo vazio. */
  private readonly emptyTried = signal(false);
  readonly hint = computed(() => this.assistant.blockedReason() ?? (this.emptyTried() ? 'Escreva o que você deseja ajustar.' : null));

  typed(value: string): void {
    this.text.set(value);
    if (value.trim()) this.emptyTried.set(false);
  }

  submit(): void {
    const t = this.text();
    if (!t.trim()) {
      this.emptyTried.set(true);
      return;
    }
    if (this.assistant.blockedReason()) return; // motivo já está na tela; o texto fica
    this.text.set('');
    void this.assistant.send(t);
  }
}
