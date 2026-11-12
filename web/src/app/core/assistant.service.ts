import { operationView } from '../live-ux/operation-view';
import { diagnosticView, presentationChoices, type DiagnosticView } from '../assistant/diagnostic-view';
import { knowledgeView, type KnowledgeView } from '../knowledge/knowledge-view';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiveService, type AssistantOutcome } from './live.service';
import { SessionService } from './session.service';
import type { ApplyReply, AssistantReply, DiagnosticContext, ProposalCard } from './protocol';

export type CardState = 'open' | 'applying' | 'applied' | 'awaiting' | 'cancelled' | 'stale' | 'failed' | 'reported' | 'sent' | 'uncertain' | 'observed' | 'unconfirmed';

export interface ChatItem {
  id: number;
  from: 'user' | 'assistant';
  text?: string;
  cards?: ProposalCard[];
  diagnostic?: boolean;
  presentation?: DiagnosticView;
  knowledge?: KnowledgeView;
  diagnosticContext?: DiagnosticContext;
  references?: AssistantReply['references'];
  diagnosticOptions?: AssistantReply['diagnosticOptions'];
  options?: Array<{ label: string; text: string }>;
  /** Pergunta "Melhorou?" sobre esta proposta aplicada. */
  feedbackFor?: string;
  tone?: 'normal' | 'error' | 'ok';
  /** De onde veio (local = sem IA; ai = Claude). */
  source?: AssistantReply['source'];
  /** Código do servidor (ex.: REAL_READ_ONLY = recurso REAL bloqueado). */
  code?: string;
}

const MAX_ITEMS = 40;
const REAL_CONFIRM_TIMEOUT_MS = 12_000;

/** Valor de uma amostra REAL no formato do cartão (unidade pela categoria). */
export function fmtReal(rc: NonNullable<ProposalCard['realControl']>, v: unknown): string {
  if (v === '-inf') return '−∞ dB';
  if (typeof v === 'boolean') return rc.category.endsWith('mute') ? (v ? 'mutado' : 'aberto') : (v ? 'bypass ligado' : 'bypass desligado');
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'não disponível';
  if (rc.unit === 'Hz') return `${v} Hz`;
  if (rc.unit === 'Q') return `Q ${v}`;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`;
}

const NOT_SENT = 'Sem conexão com o servidor: o pedido NÃO foi enviado e nada mudou na mesa. Quando a conexão voltar, envie de novo.';
const LOST_ASK = 'Sem resposta no prazo ou conexão interrompida. O pedido não será repetido automaticamente; confira a tela e, se precisar, envie de novo.';

/**
 * Assistente na tela. Só conversa com o servidor: interpretar, aplicar e "melhorou?" são
 * decididos lá. Nada aqui altera a mesa sem o toque em "Aplicar".
 */
@Injectable({ providedIn: 'root' })
export class AssistantUiService {
  private readonly live = inject(LiveService);
  private readonly session = inject(SessionService);

  readonly items = signal<ChatItem[]>([]);
  readonly cardState = signal<Record<string, CardState>>({});
  readonly thinking = signal(false);
  readonly diagnosticContext = signal<DiagnosticContext | undefined>(undefined);
  private contextTimer?: ReturnType<typeof setTimeout>;
  readonly open = signal(false);
  readonly aiOn = computed(() => !!this.live.hello()?.assistant?.ai);
  /**
   * Por que não dá para enviar agora (texto mostrado ao lado do botão desabilitado).
   * null = pode enviar.
   */
  readonly blockedReason = computed<string | null>(() => {
    const c = this.live.connection();
    if (c === 'offline') return 'Sem conexão com o servidor — reconectando. Nada é enviado enquanto isso.';
    if (c === 'connecting') return 'Conectando ao servidor…';
    if (c !== 'online') return 'Desconectado do servidor.';
    if (this.live.hello()?.assistant?.available === false) return 'Assistente indisponível neste servidor.';
    if (this.thinking()) return 'Esperando a resposta do pedido anterior…';
    return null;
  });
  private seq = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.contextTimer));
    // Nova sessão (ou volta ao PIN): a conversa e os cartões antigos não valem mais.
    effect(() => {
      this.session.token();
      untracked(() => {
        this.clear();
        this.thinking.set(false);
        this.open.set(false);
      });
    });
  }

  /**
   * Envia um pedido. Devolve false se NÃO enviou (sem conexão ou esperando outro pedido): o
   * motivo fica visível e o texto deve continuar no campo.
   */
  async send(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t || this.blockedReason()) return false;
    const sessionToken = this.session.token();
    const auxMentions = [...t.matchAll(/\baux(?=[\s:#-]|\d|$)\s*[:#-]?\s*(\d+)?/gi)];
    // Operador pode pedir um AUX explícito CADASTRADO (#98); o servidor revalida e nunca converte para o AUX compartilhado.
    // Músico, AUX não cadastrado, "AUX" sem número ou número ilegível continuam bloqueados aqui, sem enviar nada.
    const operator = this.live.hello()?.role === 'operator';
    const registered = (n: number) => this.live.auxes().some(a => a.number === n);
    if (auxMentions.some(m => !m[1] ? true : Number(m[1]) !== this.live.hello()?.musicianAux && !(operator && registered(Number(m[1]))))) {
      this.open.set(true); this.push({ from: 'user', text: t });
      this.push({ from: 'assistant', tone: 'error', text: 'Destino não disponível neste contrato do assistente. Ele usa PA ou FONES (AUX ' + (this.live.hello()?.musicianAux ?? 'não informado') + '). Nenhum pedido foi enviado. Para outro AUX, use os controles manuais LAB; não será convertido para o retorno compartilhado.' });
      return true;
    }
    this.open.set(true);
    this.push({ from: 'user', text: t });
    this.thinking.set(true);
    try {
      const r = await this.live.assistant({ type: 'assistant', text: t, ...this.contextStamp() });
      if (this.session.token() !== sessionToken) return true;
      if (!r.ok) this.push({ from: 'assistant', tone: 'error', text: r.why === 'offline' ? NOT_SENT : LOST_ASK });
      else this.showReply(r.msg['reply'] as AssistantReply | undefined);
      return true;
    } finally {
      if (this.session.token() === sessionToken) this.thinking.set(false);
    }
  }

  /** Opção contextual de consulta: não passa por proposal_apply nem por command. */
  async consult(option: NonNullable<AssistantReply['diagnosticOptions']>[number], context?: DiagnosticContext): Promise<void> {
    if (this.blockedReason() || (context && !this.isCurrentContext(context))) return;
    const sessionToken = this.session.token();
    this.open.set(true);
    this.push({ from: 'user', text: `Consulta técnica: ${option.label}` });
    this.thinking.set(true);
    try {
      const r = await this.live.assistant(context
        ? { type: 'assistant_conversation', input: { text: option.label, context: { id: context.id, revision: context.revision } } }
        : { type: 'assistant_diagnose', input: option.input });
      if (this.session.token() !== sessionToken) return;
      if (!r.ok) this.push({ from: 'assistant', tone: 'error', text: r.why === 'offline' ? NOT_SENT : LOST_ASK });
      else this.showReply(r.msg['reply'] as AssistantReply | undefined);
    } finally {
      if (this.session.token() === sessionToken) this.thinking.set(false);
    }
  }

  /**
   * REAL: o cartão só alcança o servidor por esta ação HUMANA, pelo endpoint de confirmação da própria proposta (nunca o
   * Aplicar legado/WS). Um requestId por clique; sem reenvio automático. Observação independente NÃO é ACK causal.
   */
  private async applyReal(card: ProposalCard): Promise<void> {
    const rc = card.realControl!, hello = this.live.hello(), token = this.session.token();
    if (!token || hello?.mode !== 'real' || hello.serverId !== rc.serverId || hello.role !== 'operator') {
      this.setState(card.id, 'failed');
      return this.push({ from: 'assistant', tone: 'error', text: 'A instância ou o modo mudou (ou a sessão não é de operador). Nada foi enviado; peça uma nova proposta.' });
    }
    this.setState(card.id, 'applying');
    const requestId = 'ui-' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    const r = await this.post(rc.confirmationPath, { targetMode: 'real', serverId: rc.serverId, requestId, humanConfirmed: true }, REAL_CONFIRM_TIMEOUT_MS);
    if (token !== this.session.token() || rc.serverId !== this.live.hello()?.serverId) return; // sessão/instância mudou: resposta tardia descartada
    if (r === 'offline' || r === 'timeout') {
      this.setState(card.id, 'uncertain');
      return this.push({ from: 'assistant', tone: 'error', text: 'Sem resposta do servidor: o envio PODE ter ocorrido. Confira o valor na mesa. Não reenvio automaticamente.' });
    }
    const confirmation = r.json['confirmation'] as { status?: string; previous?: unknown; requested?: unknown; observed?: unknown } | undefined;
    const code = String((r.json['result'] as { code?: string } | undefined)?.code ?? r.json['code'] ?? '');
    if (r.status === 401) {
      this.setState(card.id, 'uncertain');
      return this.push({ from: 'assistant', tone: 'error', text: 'A sessão terminou durante a operação. Se o envio já tinha começado, ele pode ter sido concluído: confira a mesa. Nada será repetido.' });
    }
    const shown = (v: unknown) => fmtReal(rc, v);
    if (confirmation?.status === 'observed_target') {
      this.setState(card.id, 'observed');
      return this.push({ from: 'assistant', tone: 'ok', text: `Enviado. Observação recebida da mesa: ${shown(confirmation.observed)} (antes: ${shown(confirmation.previous)}; pedido: ${shown(confirmation.requested)}). É uma amostra independente no valor pedido: não prova que o MixAI causou a mudança nem melhora de áudio.` });
    }
    if (confirmation?.status === 'unconfirmed' || code === 'INDETERMINATE') {
      this.setState(card.id, 'unconfirmed');
      return this.push({ from: 'assistant', tone: 'error', text: 'Enviado, mas a mesa NÃO confirmou o valor pedido (resultado incerto). Confira na mesa antes de qualquer nova operação. Nada foi repetido ou desfeito automaticamente.' });
    }
    this.setState(card.id, 'failed');
    this.push({ from: 'assistant', tone: 'error', text: ((r.json['result'] as { message?: string } | undefined)?.message ?? 'Confirmação recusada.') + ' Nada foi enviado à mesa.' });
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: Record<string, any> } | 'timeout' | 'offline'> {
    const token = this.session.token();
    if (!token || !path.startsWith('/api/ui16/')) return 'offline';
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(path, { method: 'POST', cache: 'no-store', credentials: 'omit', signal: ctl.signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json: json && typeof json === 'object' ? json : {} };
    } catch { return ctl.signal.aborted && ctl.signal.reason === 'timeout' ? 'timeout' : 'offline'; }
    finally { clearTimeout(timer); }
  }

  /** Desfazer supervisionado: pede ao servidor uma NOVA proposta de desfazer (nova confirmação humana). Não desfaz por conta própria. */
  async undo(card: ProposalCard): Promise<void> {
    if (!card.realControl || this.state(card.id) !== 'observed') return;
    await this.send('Desfaz o último ajuste');
  }

  async apply(card: ProposalCard): Promise<void> {
    if (this.state(card.id) !== 'open') return;
    if (card.realControl) return this.applyReal(card);
    const token = this.session.token(), serverId = this.live.hello()?.serverId;
    this.setState(card.id, 'applying');
    const r: AssistantOutcome = await this.live.assistant({ type: 'proposal_apply', proposalId: card.id });
    if (token !== this.session.token()) return;
    if (!r.ok && r.why === 'offline') {
      // Nem saiu: nada foi aplicado. O cartão continua disponível.
      this.setState(card.id, 'open');
      return this.push({ from: 'assistant', tone: 'error', text: 'Sem conexão com o servidor: nada foi enviado nem aplicado. Quando a conexão voltar, toque em Aplicar de novo.' });
    }
    if (!r.ok) {
      // Saiu e a resposta não voltou: NÃO repete. Pode ter sido aplicado.
      this.setState(card.id, 'uncertain');
      return this.push({ from: 'assistant', tone: 'error', text: 'A conexão caiu antes da resposta: o ajuste PODE ter sido aplicado. Confira os valores na tela antes de pedir de novo.' });
    }
    if (serverId !== this.live.hello()?.serverId) {
      this.setState(card.id, 'uncertain');
      return this.push({ from: 'assistant', tone: 'error', text: 'A instância do servidor mudou. Resultado não confirmado; nenhum ajuste será repetido automaticamente.' });
    }
    const m = r.msg as ApplyReply & Record<string, unknown>;
    switch (m.status) {
      case 'applied': {
        const view = operationView(m.result, this.live.hello()?.mode);
        const state: CardState = view.state === 'simulated' ? 'applied' : view.state === 'sent' ? 'sent' : view.state === 'reported' ? 'reported' : 'uncertain';
        this.setState(card.id, state);
        this.push({ from: 'assistant', tone: state === 'applied' ? 'ok' : state === 'uncertain' ? 'error' : 'normal', text: view.label + '. ' + (m.result?.message ?? m.message ?? 'Estado final não disponível.'), feedbackFor: m.askFeedback && state !== 'uncertain' ? card.id : undefined });
        return;
      }
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
    const rc = card.realControl;
    if (rc?.cancelPath) void this.post(rc.cancelPath, { targetMode: 'real', serverId: rc.serverId }, 6000); // descarta a prévia no servidor; nunca toca a mesa
    else if (!rc) this.live.send({ type: 'proposal_cancel', proposalId: card.id });
    this.setState(card.id, 'cancelled');
  }

  async feedback(item: ChatItem, better: boolean): Promise<void> {
    const id = item.feedbackFor;
    if (!id) return;
    this.items.update((list) => list.map((x) => (x.id === item.id ? { ...x, feedbackFor: undefined } : x)));
    const r = await this.live.assistant({ type: 'assistant_feedback', proposalId: id, better });
    if (r.ok) this.showReply(r.msg['reply'] as AssistantReply | undefined);
    else this.push({ from: 'assistant', tone: 'error', text: r.why === 'offline' ? NOT_SENT : LOST_ASK });
  }

  state(id: string): CardState {
    return this.cardState()[id] ?? 'open';
  }

  clear(): void {
    this.setContext(undefined);
    this.items.set([]);
    this.cardState.set({});
  }

  isCurrentContext(context: DiagnosticContext): boolean {
    const current = this.diagnosticContext();
    return current?.id === context.id && current.revision === context.revision;
  }
  private contextStamp(): { context?: { id: string; revision: number } } {
    const current = this.diagnosticContext();
    return current ? { context: { id: current.id, revision: current.revision } } : {};
  }
  private setContext(context: DiagnosticContext | undefined): void {
    clearTimeout(this.contextTimer);
    this.diagnosticContext.set(context);
    if (context) {
      const remaining = Date.parse(context.expiresAt) - Date.now();
      if (remaining <= 0) this.diagnosticContext.set(undefined);
      else this.contextTimer = setTimeout(() => this.diagnosticContext.set(undefined), remaining);
    }
  }

  private showReply(r: AssistantReply | undefined) {
    if (!r || typeof r !== 'object') {
      // Resposta fora do formato: avisa em vez de ficar em silêncio.
      return this.push({ from: 'assistant', tone: 'error', text: 'O servidor respondeu num formato que esta tela não entende. Recarregue a página (pode ser uma versão antiga em cache).' });
    }
    if (r.diagnosticContext !== undefined) this.setContext(r.diagnosticContext ?? undefined);
    if (r.kind === 'diagnosis') {
      return this.push({ from: 'assistant', source: 'local', diagnostic: true, presentation: diagnosticView(r), knowledge: knowledgeView(r.knowledge), text: r.text, references: r.references, diagnosticOptions: r.diagnosticOptions ?? presentationChoices(r.conversation), diagnosticContext: r.diagnosticContext ?? undefined });
    }
    if (r.kind === 'proposals' && !r.proposals?.length) {
      return this.push({ from: 'assistant', source: r.source, text: r.text || 'Nada a ajustar.' });
    }
    if (r.kind === 'proposals') {
      this.push({ from: 'assistant', source: r.source, text: r.text, cards: r.proposals });
    } else if (r.kind === 'clarify') {
      this.push({ from: 'assistant', source: r.source, text: r.question || 'Pode explicar melhor?', options: r.options });
    } else {
      const text = r.text || (r.kind === 'error' ? 'Não foi possível atender o pedido.' : 'Sem resposta.');
      this.push({ from: 'assistant', source: r.source, tone: r.kind === 'error' ? 'error' : 'normal', text, code: r.code });
    }
  }

  private push(item: Omit<ChatItem, 'id'>) {
    this.items.update((list) => [...list, { ...item, id: ++this.seq }].slice(-MAX_ITEMS));
  }

  private setState(id: string, s: CardState) {
    this.cardState.update((m) => ({ ...m, [id]: s }));
  }
}
