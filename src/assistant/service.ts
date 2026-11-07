import { DiagnosticContexts, conversationSchema, contextStampSchema, type DiagnosticContextView } from './diagnostic-context.js';
import { consult, isShortConsultationAnswer, consultationSchema, parseConsultation, type ConsultationReply } from './sound-engineer.js';
import type { AiContext, AiTurn, AiUsage, ClaudeClient } from '../ai/claude.js';
import type { NamedEntry } from '../core/config.js';
import type { Result } from '../core/controller.js';
import type { ActionLog } from '../core/log.js';
import { paramKey } from '../core/revisions.js';
import { auxBus, MASTER } from '../mixer/types.js';
import type { Principal } from '../server/auth.js';
import type { KnowledgeContext, LocalKnowledge } from '../knowledge/local/index.js';
import { musicianHasPA } from '../server/policy.js';
import type { ServerCore } from '../server/core.js';
import type { ClarifyOption, ParseOutcome } from './intent.js';
import { isExplicitMixRequest, parseRequest, type StepSizes } from './nl-parser.js';
import { fmtDb, ProposalBuilder, type Proposal, type ProposalCard } from './proposals.js';

export interface AssistantReply {
  kind: 'proposals' | 'clarify' | 'answer' | 'error' | 'diagnosis';
  diagnosis?: ConsultationReply['diagnosis'];
  diagnosticSession?: ConsultationReply['diagnosticSession'] | null;
  technicalDetails?: ConsultationReply['technicalDetails'];
  diagnosticContext?: DiagnosticContextView | null;
  /** Referências, ficha do microfone e texto de apoio da base local. Só acrescenta; nunca é comando. */
  knowledge?: KnowledgeContext;
  references?: ConsultationReply['references'];
  diagnosticOptions?: ConsultationReply['diagnosticOptions'];
  source: 'local' | 'ai' | 'feedback';
  text?: string;
  proposals?: ProposalCard[];
  question?: string;
  options?: ClarifyOption[];
  code?: string;
  ai?: AiUsage;
}

export type ApplyStatus = 'applied' | 'awaiting_approval' | 'recalculated' | 'expired' | 'not_found' | 'nothing' | 'failed';

export interface ApplyReply {
  status: ApplyStatus;
  message: string;
  result?: Result;
  /** Proposta nova (quando o valor mudou e foi preciso recalcular). */
  proposal?: ProposalCard;
  /** Depois de aplicar: perguntar "Melhorou?". */
  askFeedback?: boolean;
}

const MAX_TEXT = 500;

/**
 * Assistente de texto. Interpreta (parser local primeiro; Claude só se o local não entender e
 * se estiver ligado) e devolve PROPOSTAS. Nada é alterado até a pessoa tocar em "Aplicar", e
 * aí o comando passa pela mesma validação, autorização, travas e fila da E2 (inclusive a
 * aprovação do operador para operações críticas).
 */
export class AssistantService {
  private proposals = new Map<string, Proposal>();
  private applied = new Map<string, Proposal>();
  private history = new Map<string, AiTurn[]>();
  private aiBusy = new Set<string>();
  readonly builder: ProposalBuilder;
  readonly diagnosticContexts: DiagnosticContexts;
  private removeRevokeListener: () => void;

  constructor(
    private core: ServerCore,
    private opts: {
      steps: StepSizes;
      ttlMs: number;
      channels: NamedEntry[];
      ai?: ClaudeClient;
      knowledge?: LocalKnowledge;
      log: ActionLog;
      clock?: () => number;
    },
  ) {
    this.builder = new ProposalBuilder(core.controller, core.policy, opts.ttlMs, opts.clock, (p, cmd) => core.authorizeMusicianCommand(p, cmd));
    this.diagnosticContexts = new DiagnosticContexts(core.controller.names, core.policy.musicianAux, { clock: opts.clock });
    this.removeRevokeListener = core.auth.onRevoke(id => this.diagnosticContexts.revoke(id));
  }

  aiAvailable(): boolean {
    return !!this.opts.ai?.available();
  }

  private now() {
    return (this.opts.clock ?? Date.now)();
  }

  async ask(p: Principal, raw: unknown, stamp?: unknown): Promise<AssistantReply> {
    if (!this.core.auth.isActive(p)) return error('UNAUTHORIZED', 'Sessão encerrada ou expirada.');
    if (p.role === 'agent') return error('FORBIDDEN', 'O assistente da tela é para pessoas; o Claude Desktop usa as ferramentas MCP.');
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return error('INVALID', 'Escreva o que você deseja ajustar.');
    if (text.length > MAX_TEXT) return error('INVALID', `Pedido longo demais (máximo ${MAX_TEXT} caracteres).`);
    const consultation = parseConsultation(text, this.core.controller.names);
    const local = parseRequest(text, { names: this.core.controller.names, role: p.role, steps: this.opts.steps, musicianPA: musicianHasPA(this.core.policy) });
    const explicitCommand = isExplicitMixRequest(text);
    if (explicitCommand && !consultation && local.kind !== 'unknown') {
      this.diagnosticContexts.clear(p.id);
      this.prune();
      return { ...this.render(p, local, 'local'), diagnosticContext: null };
    }
    if (explicitCommand && consultation) return { kind: 'answer', source: 'local', text: 'A mensagem mistura comando e diagnóstico. Reformule como comando direto ou como queixa técnica; nada foi ajustado.', code: 'DIAGNOSIS_AMBIGUOUS' };
    if (p.role === 'operator') {
      const parsedStamp = contextStampSchema.optional().safeParse(stamp);
      if (!parsedStamp.success) return error('INVALID', 'Referência de esclarecimento inválida.');
      const technical = this.diagnosticContexts.handle(p.id, text, parsedStamp.data);
      if (technical) return this.withKnowledge(p, technical, text);
    } else if (consultation || stamp !== undefined) {
      return error('FORBIDDEN', 'A consulta técnica é exclusiva do operador autenticado.');
    }
    if (isShortConsultationAnswer(text, this.core.controller.names)) return { kind: 'answer', source: 'local', code: 'DIAGNOSIS_CONTEXT_REQUIRED', text: 'Não há esclarecimento técnico autorizado pendente. Descreva uma queixa completa ou um comando direto.' };
    this.prune();
    if (local.kind !== 'unknown') return this.render(p, local, 'local');

    const ai = this.opts.ai;
    if (!ai?.available()) {
      return {
        kind: 'answer',
        source: 'local',
        code: 'AI_DISABLED',
        text: 'Não entendi pelo modo local, e o modo IA está desligado. Tente algo como "sobe o surdo no PA", "diminui 3 dB da voz Fernando nos fones", "muta o pandeiro no PA" ou "desfaz".',
      };
    }
    if (this.aiBusy.has(p.id)) return error('BUSY', 'Ainda estou esperando a resposta da IA para o pedido anterior.');
    this.aiBusy.add(p.id);
    let r;
    try {
      r = await ai.interpret(text, this.context(p), this.history.get(p.id) ?? []);
    } finally {
      this.aiBusy.delete(p.id);
    }
    if (r.usage) {
      const u = r.usage;
      this.opts.log.add({
        action: 'ai_request',
        ok: r.ok,
        message: `IA (${u.model}): ${u.inputTokens} + ${u.outputTokens} tokens, ~US$ ${u.costUSD.toFixed(5)}, ${u.ms} ms`,
        details: { role: p.role, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUSD: u.costUSD, ms: u.ms, today: ai.usageToday() },
      });
    }
    if (!r.ok) {
      this.opts.log.add({ action: 'ai_unavailable', ok: false, message: r.message, details: { code: r.code, role: p.role } });
      return { kind: 'error', source: 'ai', code: r.code, text: r.message, ai: r.usage };
    }
    const reply = this.render(p, r.outcome, 'ai', r.usage);
    this.remember(p.id, text, reply);
    return reply;
  }

  /** Endpoint explicitamente de conversa técnica: comandos nunca viram propostas aqui. */
  conversation(p: Principal, raw: unknown): AssistantReply {
    if (!this.core.auth.isActive(p)) return error('UNAUTHORIZED', 'Sessão encerrada ou expirada.');
    if (p.role !== 'operator') return error('FORBIDDEN', 'A consulta técnica é exclusiva do operador autenticado.');
    const parsed = conversationSchema.safeParse(raw);
    if (!parsed.success) return error('INVALID', 'Conversa inválida: use texto de até 500 caracteres e a revisão opcional do esclarecimento.');
    if (isExplicitMixRequest(parsed.data.text)) return error('INVALID', 'Este endpoint aceita somente consulta; envie comandos diretos pelo chat de comandos.');
    return this.diagnosticContexts.handle(p.id, parsed.data.text, parsed.data.context)
      ?? error('INVALID', 'Descreva uma queixa técnica ou responda a um esclarecimento pendente.');
  }

  /**
   * Acrescenta o contexto da base local a uma resposta de diagnóstico do operador. Falha da base
   * (ou ausência dela) devolve a resposta original: o motor determinístico continua sendo a resposta.
   */
  async withKnowledge(p: Principal, reply: AssistantReply, text: string): Promise<AssistantReply> {
    const k = this.opts.knowledge;
    if (!k || p.role !== 'operator' || reply.kind !== 'diagnosis' || !this.core.auth.isActive(p)) return reply;
    const known = reply.diagnosticSession?.knownContext;
    const knowledge = await k.enrich({
      text, symptom: known?.symptom ?? undefined, instrument: known?.instrument ?? undefined,
      channel: known?.channel ?? undefined, destination: known?.destination ?? undefined,
    });
    return this.core.auth.isActive(p) ? { ...reply, knowledge } : reply;
  }

  sweep(): void {
    this.diagnosticContexts.sweep(id => this.core.auth.isActive({ id, role: 'operator', label: 'operador' }));
  }
  stop(): void {
    this.removeRevokeListener();
    this.diagnosticContexts.stop();
  }

  /** B3A: autorização e validação comuns a chat, HTTP e WS. Nunca cria propostas. */
  diagnose(p: Principal, raw: unknown): AssistantReply {
    if (!this.core.auth.isActive(p)) return error('UNAUTHORIZED', 'Sessão encerrada ou expirada.');
    if (p.role !== 'operator') return error('FORBIDDEN', 'A consulta técnica é exclusiva do operador autenticado.');
    const parsed = consultationSchema.safeParse(raw);
    if (!parsed.success) return error('INVALID', 'Consulta inválida: informe sintoma, canal/fonte, destino e evidências com origem, sem comandos ou aprovações.');
    try {
      return consult(parsed.data, this.core.controller.names, this.core.policy.musicianAux);
    } catch (err) {
      return error('INVALID', (err as Error).message);
    }
  }

  /** Aplica uma proposta: confere se o estado ainda é o do cálculo e manda para a fila da E2. */
  async apply(p: Principal, proposalId: unknown, requestId: unknown): Promise<ApplyReply> {
    const pr = typeof proposalId === 'string' ? this.proposals.get(proposalId) : undefined;
    if (!pr || pr.ownerId !== p.id) return { status: 'not_found', message: 'Proposta não encontrada (já usada, cancelada ou de outro aparelho).' };
    this.proposals.delete(pr.card.id);
    if (this.now() > pr.expiresAtMs) return { status: 'expired', message: 'A proposta expirou. Peça de novo.' };
    if (!this.builder.isCurrent(pr)) {
      // O valor mudou depois do cálculo: recalcula e pede nova confirmação. Nada foi aplicado.
      const again = this.builder.build(p, pr.intent, pr.card.source);
      if (!again.ok) return { status: again.code === 'NOTHING' ? 'nothing' : 'failed', message: `O valor mudou desde a proposta. ${again.message}` };
      this.proposals.set(again.proposal.card.id, again.proposal);
      return { status: 'recalculated', message: 'O valor mudou desde a proposta. Confira a proposta recalculada e toque em Aplicar de novo.', proposal: again.proposal.card };
    }
    // A conferência definitiva acontece DENTRO da fila do controlador, junto com a escrita:
    // se outro comando mudou os parâmetros (ou o topo do desfazer) enquanto este esperava,
    // nada é aplicado (STATE_CHANGED).
    const r = await this.core.execute(p, { requestId, command: pr.command }, { expect: { revisions: pr.bound, undoId: pr.undoId } });
    const result = r.result;
    if (result.code === 'STATE_CHANGED') {
      this.opts.log.add({ action: 'assistant_conflict', ok: false, message: `Assistente: ${pr.card.title} não aplicado (o estado mudou na fila).`, details: { role: p.role, proposal: pr.card } });
      const again = this.builder.build(p, pr.intent, pr.card.source);
      if (!again.ok) return { status: again.code === 'NOTHING' ? 'nothing' : 'failed', message: `O valor mudou antes de aplicar. ${again.message}` };
      this.proposals.set(again.proposal.card.id, again.proposal);
      return {
        status: 'recalculated',
        message: 'Outro comando mudou o valor enquanto este esperava. Nada foi aplicado: confira a proposta recalculada e toque em Aplicar de novo.',
        proposal: again.proposal.card,
      };
    }
    this.opts.log.add({
      action: 'assistant_apply',
      ok: result.ok,
      message: `Assistente (${pr.card.source}): ${pr.card.title} — ${pr.card.change} → ${result.code}`,
      details: { role: p.role, proposal: pr.card, code: result.code },
    });
    if (result.needsConfirmation || result.code === 'NEEDS_CONFIRMATION') {
      return {
        status: 'awaiting_approval',
        message: p.role === 'operator' ? 'Operação crítica: confirme no cartão de aprovação.' : 'Operação crítica: aguardando a aprovação do operador.',
        result,
      };
    }
    if (!result.ok) return { status: 'failed', message: result.message, result };
    this.applied.set(pr.card.id, pr);
    return { status: 'applied', message: result.message, result, askFeedback: !!pr.revert };
  }

  cancel(p: Principal, proposalId: unknown): boolean {
    const pr = typeof proposalId === 'string' ? this.proposals.get(proposalId) : undefined;
    if (!pr || pr.ownerId !== p.id) return false;
    this.proposals.delete(pr.card.id);
    return true;
  }

  /** "Melhorou?" — sim: anota; não: propõe voltar ao valor anterior (de novo com Aplicar). */
  feedback(p: Principal, proposalId: unknown, better: unknown): AssistantReply {
    const pr = typeof proposalId === 'string' ? this.applied.get(proposalId) : undefined;
    if (!pr || pr.ownerId !== p.id) return error('NOT_FOUND', 'Não encontrei esse ajuste.');
    this.applied.delete(pr.card.id);
    this.opts.log.add({
      action: 'assistant_feedback',
      ok: better === true,
      message: `${better === true ? 'Melhorou' : 'Não melhorou'}: ${pr.card.title} (${pr.card.current} → ${pr.card.result})`,
      details: { role: p.role, source: pr.card.source, proposal: pr.card },
    });
    if (better === true || !pr.revert) return { kind: 'answer', source: 'feedback', text: 'Anotado. Obrigado!' };
    return this.render(p, { kind: 'intents', intents: [pr.revert] }, 'feedback');
  }

  // ---------- internos ----------

  private render(p: Principal, outcome: ParseOutcome, source: AssistantReply['source'], ai?: AiUsage): AssistantReply {
    if (outcome.kind === 'clarify') return { kind: 'clarify', source, question: outcome.question, options: outcome.options, ai };
    if (outcome.kind === 'answer') return { kind: 'answer', source, text: outcome.text, ai };
    if (outcome.kind === 'unknown') return { kind: 'answer', source, text: 'Não entendi o pedido.', ai };
    const cards: ProposalCard[] = [];
    const notes: string[] = [];
    let forbidden = false;
    for (const intent of outcome.intents) {
      const b = this.builder.build(p, intent, source);
      if (b.ok) {
        this.proposals.set(b.proposal.card.id, b.proposal);
        cards.push(b.proposal.card);
      } else {
        notes.push(b.message);
        forbidden ||= b.code === 'FORBIDDEN';
      }
    }
    if (!cards.length) return { kind: forbidden ? 'error' : 'answer', source, code: forbidden ? 'FORBIDDEN' : undefined, text: notes.join(' '), ai };
    return { kind: 'proposals', source, proposals: cards, text: notes.length ? notes.join(' ') : undefined, ai };
  }

  /**
   * Contexto mínimo para a IA: canais, destinos PERMITIDOS a este perfil e só os valores que
   * ele pode ver (músico nunca recebe o master; no fones_only, nem o PA).
   */
  private context(p: Principal): AiContext {
    const c = this.core.controller;
    const policy = this.core.policy;
    const aux = policy.musicianAux;
    const musician = p.role === 'musician';
    const showPA = !musician || musicianHasPA(policy);
    const channels = this.opts.channels.filter(ch => !musician || this.core.musicianIdentity(p).binding?.channels.includes(ch.number));
    const keys = channels.flatMap((ch) => [
      paramKey.level(ch.number, MASTER),
      paramKey.mute(ch.number, MASTER),
      paramKey.level(ch.number, auxBus(aux)),
      paramKey.mute(ch.number, auxBus(aux)),
    ]);
    const snap = c.state.snapshot([...keys, paramKey.master()]).params;
    const val = (k: string) => {
      const v = snap[k]?.value;
      if (!v || v.status !== 'known') return '?';
      return typeof v.value === 'boolean' ? (v.value ? 'mutado' : 'aberto') : fmtDb(v.value);
    };
    const lines = channels.map((ch) => {
      const fones = `Fones ${val(paramKey.level(ch.number, auxBus(aux)))} ${val(paramKey.mute(ch.number, auxBus(aux)))}`;
      return showPA ? `${ch.number} ${ch.name}: PA ${val(paramKey.level(ch.number, MASTER))} ${val(paramKey.mute(ch.number, MASTER))} | ${fones}` : `${ch.number} ${ch.name}: ${fones}`;
    });
    if (!musician) lines.push(`Master: ${val(paramKey.master())}`);
    return {
      role: musician ? 'musician' : 'operator',
      musicianPA: musician && musicianHasPA(policy),
      musicianPaStepDB: policy.musicianPaStepDB,
      channels,
      state: lines.join('\n'),
      steps: this.opts.steps,
    };
  }

  /** Histórico curto por pessoa (só o necessário para "e o violão também?"). */
  private remember(id: string, text: string, reply: AssistantReply) {
    const summary =
      reply.kind === 'proposals'
        ? `Propus: ${reply.proposals!.map((c) => `${c.title} ${c.change} (${c.destination})`).join('; ')}`
        : (reply.question ?? reply.text ?? '');
    const h = [...(this.history.get(id) ?? []), { role: 'user' as const, content: text }, { role: 'assistant' as const, content: summary.slice(0, 300) }];
    this.history.set(id, h.slice(-20));
  }

  private prune() {
    const now = this.now();
    for (const [id, pr] of this.proposals) if (now > pr.expiresAtMs + 60_000) this.proposals.delete(id);
    for (const [id, pr] of this.applied) if (now > pr.expiresAtMs + 30 * 60_000) this.applied.delete(id);
  }
}

function error(code: string, text: string): AssistantReply {
  return { kind: 'error', source: 'local', code, text };
}
