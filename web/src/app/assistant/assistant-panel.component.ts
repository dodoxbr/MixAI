import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, inject, viewChild } from '@angular/core';
import { AssistantUiService, type CardState } from '../core/assistant.service';

const STATE_TEXT: Record<CardState, string> = {
  open: '',
  applying: 'Aplicando…',
  applied: 'Aplicado',
  awaiting: 'Aguardando aprovação',
  cancelled: 'Cancelado',
  stale: 'Valor mudou — veja a nova proposta',
  failed: 'Não aplicado',
};

/**
 * Conversa curta do assistente: pedidos, propostas (Aplicar/Cancelar), perguntas com opções e
 * "Melhorou?". Recolhível, para não tomar o espaço dos faders.
 */
@Component({
  selector: 'mx-assistant-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-assistant-panel', role: 'region', 'aria-label': 'Assistente' },
  template: `
    <header class="assist-head">
      <h2>Assistente</h2>
      <span class="assist-mode" [class.on]="assistant.aiOn()" [title]="assistant.aiOn() ? 'Pedidos que o modo local não entende vão para o Claude' : 'Só comandos diretos (sem IA)'">{{ assistant.aiOn() ? 'IA ligada' : 'sem IA' }}</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost btn-small" (click)="assistant.open.set(false)" aria-label="Recolher o assistente">Recolher</button>
    </header>
    <ol class="assist-log" aria-live="polite" #log>
      @for (item of assistant.items(); track item.id) {
        <li class="assist-item" [class.from-user]="item.from === 'user'" [class.tone-error]="item.tone === 'error'" [class.tone-ok]="item.tone === 'ok'">
          @if (item.text) {
            <p class="assist-text">
              @if (item.source === 'ai') {
                <span class="assist-src">IA</span>
              }
              {{ item.text }}
            </p>
          }
          @for (card of item.cards ?? []; track card.id) {
            <article class="proposal" [class.is-done]="assistant.state(card.id) !== 'open' && assistant.state(card.id) !== 'applying'">
              <h3>
                @if (card.source === 'ai') {
                  <span class="assist-src" title="Sugestão do Claude (IA)">IA</span>
                }
                {{ card.title }}
              </h3>
              <dl>
                <dt>Canal</dt>
                <dd>{{ card.channel }}</dd>
                <dt>Destino</dt>
                <dd><span class="dest" [class]="'dest dest-' + card.destination">{{ card.destination }}</span></dd>
                <dt>Agora</dt>
                <dd>{{ card.current }}</dd>
                <dt>Mudança</dt>
                <dd>{{ card.change }}</dd>
                <dt>Fica</dt>
                <dd class="proposal-result">{{ card.result }}</dd>
              </dl>
              @if (card.reason) {
                <p class="proposal-reason">Motivo: {{ card.reason }}</p>
              }
              @if (card.needsApproval) {
                <p class="proposal-approval">Operação crítica: depois de Aplicar, precisa da aprovação do operador.</p>
              }
              @if (assistant.state(card.id) === 'open' || assistant.state(card.id) === 'applying') {
                <div class="card-actions">
                  <button type="button" class="btn btn-reject" [disabled]="assistant.state(card.id) === 'applying'" (click)="assistant.cancel(card)">Cancelar</button>
                  <button type="button" class="btn btn-approve" [disabled]="assistant.state(card.id) === 'applying'" (click)="assistant.apply(card)">
                    {{ assistant.state(card.id) === 'applying' ? 'Aplicando…' : 'Aplicar' }}
                  </button>
                </div>
              } @else {
                <p class="proposal-state">{{ stateText(assistant.state(card.id)) }}</p>
              }
            </article>
          }
          @if (item.options?.length) {
            <div class="assist-options">
              @for (o of item.options; track o.text) {
                <button type="button" class="btn chip" (click)="assistant.send(o.text)">{{ o.label }}</button>
              }
            </div>
          }
          @if (item.feedbackFor) {
            <div class="assist-feedback">
              <span>Melhorou?</span>
              <button type="button" class="btn chip" (click)="assistant.feedback(item, true)">Sim</button>
              <button type="button" class="btn chip" (click)="assistant.feedback(item, false)">Não, voltar</button>
            </div>
          }
        </li>
      } @empty {
        <li class="assist-empty">Escreva um pedido, por exemplo: "aumenta um pouco o surdo no PA" ou "sobe o cavaco nos fones".</li>
      }
      @if (assistant.thinking()) {
        <li class="assist-item assist-thinking">Pensando… a mesa continua funcionando.</li>
      }
    </ol>
  `,
})
export class AssistantPanelComponent {
  readonly assistant = inject(AssistantUiService);
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');

  constructor() {
    // Sempre mostra a mensagem mais recente (cartão, pergunta ou "Melhorou?") — dentro da
    // conversa E na página: o painel pode estar abaixo dos faders (tela estreita) ou abaixo dos
    // cartões de aprovação. Sem isso a resposta chegava, mas ficava fora da área visível.
    let lastSeen = -1;
    afterRenderEffect(() => {
      const items = this.assistant.items();
      this.assistant.cardState();
      const thinking = this.assistant.thinking();
      const log = this.log()?.nativeElement;
      if (!log) return;
      const newest = items.at(-1)?.id ?? 0;
      const changed = newest !== lastSeen;
      lastSeen = newest;
      const reveal = () => {
        const target = log.lastElementChild as HTMLElement | null;
        if (!target) return;
        // Dentro da conversa: mostra o COMEÇO da mensagem nova se ela não couber inteira.
        const tall = target.offsetHeight > log.clientHeight;
        log.scrollTop = tall ? target.offsetTop : log.scrollHeight; // .assist-log é position: relative
        // Na página (painel abaixo dos faders ou das aprovações): traz a mensagem para a tela.
        if (changed || thinking) target.scrollIntoView?.({ block: tall ? 'start' : 'nearest', inline: 'nearest' });
      };
      reveal();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
    });
  }
  stateText(s: CardState): string {
    return STATE_TEXT[s];
  }
}
