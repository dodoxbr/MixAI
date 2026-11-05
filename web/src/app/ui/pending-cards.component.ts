import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import type { PendingCard } from '../core/protocol';

/**
 * Cartões de operações críticas: o que vai mudar, quem pediu e quanto tempo falta.
 * Só operadores veem Aprovar/Recusar (e o servidor confere de novo).
 */
@Component({
  selector: 'mx-pending-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-pending-cards', role: 'region', 'aria-label': 'Aprovações pendentes' },
  template: `
    @for (card of cards(); track card.pendingId) {
      <article class="card" [class.is-urgent]="secondsLeft(card) <= 15">
        <header>
          <span class="card-kind">{{ kind(card) }}</span>
          <span class="card-time">{{ secondsLeft(card) }} s</span>
        </header>
        <h3>{{ card.title }}</h3>
        <p class="card-summary">{{ card.summary }}</p>
        <p class="card-who">Pedido por: {{ card.requestedBy.label }}</p>
        @if (canDecide()) {
          <div class="card-actions">
            <button type="button" class="btn btn-reject" [disabled]="busy() === card.pendingId" (click)="reject.emit(card.pendingId)">Recusar</button>
            <button type="button" class="btn btn-approve" [disabled]="busy() === card.pendingId" (click)="approve.emit(card.pendingId)">
              {{ busy() === card.pendingId ? 'Aplicando…' : 'Aprovar' }}
            </button>
          </div>
        }
      </article>
    }
  `,
})
export class PendingCardsComponent {
  readonly cards = input<PendingCard[]>([]);
  readonly canDecide = input(false);
  readonly busy = input<string | null>(null);
  readonly approve = output<string>();
  readonly reject = output<string>();

  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  secondsLeft(card: PendingCard): number {
    return Math.max(0, Math.round((Date.parse(card.expiresAt) - this.now()) / 1000));
  }

  kind(card: PendingCard): string {
    const t = card.command.type;
    if (t === 'set_master') return 'MASTER';
    if (t === 'load_snapshot') return 'SNAPSHOT';
    if (t === 'undo') return 'DESFAZER';
    if (t === 'set_mute') return 'MUTE EM GRUPO';
    return 'MUDANÇA GRANDE';
  }
}
