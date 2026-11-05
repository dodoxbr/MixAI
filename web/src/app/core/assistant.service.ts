import { Injectable, computed, inject, signal } from '@angular/core';
import { LiveService } from './live.service';
import type { ApplyReply, AssistantReply, ProposalCard } from './protocol';

export type CardState = 'open' | 'applying' | 'applied' | 'awaiting' | 'cancelled' | 'stale' | 'failed';

export interface ChatItem {
  id: number;
  from: 'user' | 'assistant';
  text?: string;
  cards?: ProposalCard[];
  options?: Array<{ label: string; text: string }>;
  /** Pergunta "Melhorou?" sobre esta proposta aplicada. */
  feedbackFor?: string;
  tone?: 'normal' | 'error' | 'ok';
  /** De onde veio (local = sem IA; ai = Claude). */
  source?: AssistantReply['source'];
}

const MAX_ITEMS = 10;

/**
 * Assistente na tela. Só conversa com o servidor: interpretar, aplicar e "melhorou?" são
 * decididos lá. Nada aqui altera a mesa sem o toque em "Aplicar".
 */
@Injectable({ providedIn: 'root' })
export class AssistantUiService {
  private readonly live = inject(LiveService);

  readonly items = signal<ChatItem[]>([]);
  readonly cardState = signal<Record<string, CardState>>({});
  readonly thinking = signal(false);
  readonly open = signal(false);
  readonly aiOn = computed(() => !!this.live.hello()?.assistant?.ai);
  private seq = 0;

  async send(text: string): Promise<void> {
    const t = text.trim();
    if (!t || this.thinking()) return;
    this.open.set(true);
    this.push({ from: 'user', text: t });
    this.thinking.set(true);
    try {
      const m = await this.live.assistant({ type: 'assistant', text: t });
      if (!m) return this.push({ from: 'assistant', tone: 'error', text: 'Sem resposta do servidor agora. A mesa continua funcionando; tente de novo.' });
      this.showReply(m['reply'] as AssistantReply);
    } finally {
      this.thinking.set(false);
    }
  }

  async apply(card: ProposalCard): Promise<void> {
    if (this.state(card.id) !== 'open') return;
    this.setState(card.id, 'applying');
    const m = (await this.live.assistant({ type: 'proposal_apply', proposalId: card.id })) as (ApplyReply & Record<string, unknown>) | null;
    if (!m) {
      // Sem resposta: NÃO repete. Pode ter sido aplicado.
      this.setState(card.id, 'failed');
      return this.push({ from: 'assistant', tone: 'error', text: 'A conexão caiu antes da resposta: o ajuste PODE ter sido aplicado. Confira os valores na tela antes de pedir de novo.' });
    }
    switch (m.status) {
      case 'applied':
        this.setState(card.id, 'applied');
        this.push({ from: 'assistant', tone: 'ok', text: `Aplicado: ${card.title} ${card.change} (agora ${card.result}).`, feedbackFor: m.askFeedback ? card.id : undefined });
        return;
      case 'awaiting_approval':
        this.setState(card.id, 'awaiting');
        this.push({ from: 'assistant', text: m.message });
        return;
      case 'recalculated':
        this.setState(card.id, 'stale');
        this.push({ from: 'assistant', text: m.message, cards: m.proposal ? [m.proposal] : undefined });
        return;
      default:
        this.setState(card.id, 'failed');
        this.push({ from: 'assistant', tone: 'error', text: m.message });
    }
  }

  cancel(card: ProposalCard): void {
    if (this.state(card.id) !== 'open') return;
    this.live.send({ type: 'proposal_cancel', proposalId: card.id });
    this.setState(card.id, 'cancelled');
  }

  async feedback(item: ChatItem, better: boolean): Promise<void> {
    const id = item.feedbackFor;
    if (!id) return;
    this.items.update((list) => list.map((x) => (x.id === item.id ? { ...x, feedbackFor: undefined } : x)));
    const m = await this.live.assistant({ type: 'assistant_feedback', proposalId: id, better });
    if (m) this.showReply(m['reply'] as AssistantReply);
  }

  state(id: string): CardState {
    return this.cardState()[id] ?? 'open';
  }

  clear(): void {
    this.items.set([]);
    this.cardState.set({});
  }

  private showReply(r: AssistantReply) {
    if (r.kind === 'proposals') {
      this.push({ from: 'assistant', source: r.source, text: r.text, cards: r.proposals });
    } else if (r.kind === 'clarify') {
      this.push({ from: 'assistant', source: r.source, text: r.question, options: r.options });
    } else {
      this.push({ from: 'assistant', source: r.source, tone: r.kind === 'error' ? 'error' : 'normal', text: r.text });
    }
  }

  private push(item: Omit<ChatItem, 'id'>) {
    this.items.update((list) => [...list, { ...item, id: ++this.seq }].slice(-MAX_ITEMS));
  }

  private setState(id: string, s: CardState) {
    this.cardState.update((m) => ({ ...m, [id]: s }));
  }
}
