import { parseMixerRequest, channelCandidates, resolveDestination } from './mixer-operator/parser.js';
import { isProcessingCommand, parseProcessingRequest } from './mixer-operator/processing-parser.js';
import { interpretMixerRequest } from './mixer-operator/interpreter.js';
import { operatorObservations } from './mixer-operator/observations.js';
import type { OperatorObservations } from './mixer-operator/contracts.js';
import { sameValue } from '../core/revisions.js';
import { DiagnosticContexts, conversationSchema, contextStampSchema, knowledgeQueryOf, type DiagnosticContextView } from './diagnostic-context.js';
import { consult, isShortConsultationAnswer, consultationSchema, parseConsultation, type ConsultationReply } from './sound-engineer.js';
import type { AiContext, AiTurn, AiUsage, ClaudeClient } from '../ai/claude.js';
import type { NamedEntry } from '../core/config.js';
import type { Result } from '../core/controller.js';
import type { ActionLog } from '../core/log.js';
import { paramKey } from '../core/revisions.js';
import { auxBus, MASTER } from '../mixer/types.js';
import type { Principal } from '../server/auth.js';
import type { KnowledgeContext, LocalKnowledge } from '../knowledge/local/index.js';
import type { ChatRoute } from '../knowledge/local/provider.js';
import { musicianHasPA } from '../server/policy.js';
import type { ServerCore } from '../server/core.js';
import type { ClarifyOption, ParseOutcome } from './intent.js';
import { isExplicitMixRequest, parseRequest, type StepSizes } from './nl-parser.js';
import { fmtDb, ProposalBuilder, type Proposal, type ProposalCard } from './proposals.js';

const KNOWLEDGE_CACHE_MS = 60_000;
const KNOWLEDGE_CACHE_SESSIONS = 256;
/** A interface desiste em 25 s (web/src/app/core/live.service.ts). A resposta precisa chegar antes, com folga. */
export const KNOWLEDGE_DEADLINE_MS = 20_000;

export interface AssistantReply {
  kind: 'proposals' | 'clarify' | 'answer' | 'error' | 'diagnosis';
  diagnosis?: ConsultationReply['diagnosis'];
  observations?: OperatorObservations;
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

export type ApplyStatus = 'applied' | 'awaiting_approval' | 'recalculated' | 'expired' | 'not_found' | 'nothing' | 'failed' | 'unconfirmed';

export interface ApplyReply {
  status: ApplyStatus;
  message: string;
  result?: Result;
  /** Proposta nova (quando o valor mudou e foi preciso recalcular). */
  proposal?: ProposalCard;
  /** Depois de aplicar: perguntar "Melhorou?". */
  askFeedback?: boolean;
  verification?: { source: 'lab_readback'; outcome: 'confirmed' | 'different' | 'unavailable'; readings: Array<{ key: string; known: boolean; matches: boolean }> };
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
  private mixEpoch = new Map<string, number>();
  private mixSequence = 0;
  private mixPending = new Map<string, { text: string; options: ClarifyOption[]; expires: number }>();
  /** Última consulta documental de cada sessão: só é reaproveitada se o contexto consolidado NÃO mudou (e por pouco tempo). */
  private knowledgeCache = new Map<string, { key: string; expiresAt: number; knowledge: KnowledgeContext }>();
  /** Read-only planning projection of this principal's latest M1 reply; never advances diagnosis. */
  private planningContexts = new Map<string, { session: NonNullable<ConsultationReply['diagnosticSession']>; revision: number; key: string; expiresAt: number }>();
  private planningRevision = 0;
  readonly builder: ProposalBuilder;
  readonly diagnosticContexts: DiagnosticContexts;
  private removeRevokeListener: () => void;
  /** Canais com microfone de modelo confirmado no cadastro da banda (instantâneo somente leitura, renovado a cada 30 s). */
  private registeredMics = new Set<number>();
  private micsAt = -Infinity;

  constructor(
    private core: ServerCore,
    private opts: {
      steps: StepSizes;
      ttlMs: number;
      channels: NamedEntry[];
      ai?: ClaudeClient;
      knowledge?: LocalKnowledge;
      /** Prazo máximo da consulta documental dentro da resposta (deve ficar abaixo do prazo da interface). Padrão 20 s. */
      knowledgeDeadlineMs?: number;
      /** Consentimento por sessão para enviar resumos a DeepSeek/Anthropic. Sem ele, esses provedores não são chamados. */
      externalConsent?: { allowed(p: Principal, providerId: string): boolean; revoke(id: string): void; readonly revision: number };
      /** Roteador central: provedor/modelo escolhido pelo operador NESTA sessão (catálogo). Sem seleção, devolve undefined e vale o caminho anterior. */
      chatRoute?: (p: Principal) => ChatRoute | undefined;
      mixerRoute?: (p: Principal) => ChatRoute | undefined;
      realPreview?: (p: Principal, intent: import('./intent.js').Intent, source: ProposalCard['source']) => { proposal?: ProposalCard; result?: { code: string; message: string } };
      usesModelCatalog?: boolean;
      log: ActionLog;
      clock?: () => number;
    },
  ) {
    this.builder = new ProposalBuilder(core.controller, core.policy, opts.ttlMs, opts.clock, (p, cmd) => core.authorizeMusicianCommand(p, cmd));
    this.diagnosticContexts = new DiagnosticContexts(core.controller.names, core.policy.musicianAux, { clock: opts.clock, registeredCapture: ch => (this.registeredMics.has(ch) ? 'microphone' : undefined) });
    void this.refreshMics();
    this.removeRevokeListener = core.auth.onRevoke(id => { this.diagnosticContexts.revoke(id); this.knowledgeCache.delete(id); this.planningContexts.delete(id); this.opts.externalConsent?.revoke(id); this.mixPending.delete(id); this.mixEpoch.delete(id); this.history.delete(id);
      for (const [key, proposal] of this.proposals) if (proposal.ownerId === id) this.proposals.delete(key);
      for (const [key, proposal] of this.applied) if (proposal.ownerId === id) this.applied.delete(key);
    });
  }

  aiAvailable(): boolean {
    return !!this.opts.ai?.available();
  }

  private now() {
    return (this.opts.clock ?? Date.now)();
  }

  /** Lê o cadastro de microfones da base local; falha ou ausência de base = nada cadastrado (a pergunta de captação continua). */
  private async refreshMics(): Promise<void> {
    const k = this.opts.knowledge;
    if (!k || this.now() - this.micsAt < 30_000) return;
    this.micsAt = this.now();
    try {
      const set = new Set<number>();
      for (const [key, a] of Object.entries((await k.microphones()).assignments)) {
        const n = /^CH(\d+)$/i.exec(key);
        if (n && a.modelId && a.evidence !== 'unconfirmed') set.add(Number(n[1]));
      }
      this.registeredMics = set;
    } catch { /* sem cadastro legível: nada é presumido */ }
  }

  async ask(p: Principal, raw: unknown, stamp?: unknown): Promise<AssistantReply> {
    if (!this.core.auth.isActive(p)) return error('UNAUTHORIZED', 'Sessão encerrada ou expirada.');
    if (p.role === 'agent') return error('FORBIDDEN', 'O assistente da tela é para pessoas; o Claude Desktop usa as ferramentas MCP.');
    let text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return error('INVALID', 'Escreva o que você deseja ajustar.');
    if (text.length > MAX_TEXT) return error('INVALID', `Pedido longo demais (máximo ${MAX_TEXT} caracteres).`);
    const pending = this.mixPending.get(p.id);
    this.mixPending.delete(p.id);
    if (pending && pending.expires > this.now()) {
      const answer = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '');
      const option = pending.options.find(option => option.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '') === answer);
      if (option) text = option.text;
    }
    if (this.mixEpoch.size >= 128 && !this.mixEpoch.has(p.id)) this.mixEpoch.delete(this.mixEpoch.keys().next().value!);
    const epoch = ++this.mixSequence; this.mixEpoch.set(p.id, epoch);
    // Comando explícito de EQ/HPF tem prioridade sobre a conversa técnica (não é queixa): vira prévia ou pergunta, nunca diagnóstico.
    const consultation = p.role === 'operator' && isProcessingCommand(text) ? undefined : parseConsultation(text, this.core.controller.names);
    if (consultation) {
      const destination = resolveDestination(text, this.core.controller.names);
      const unsupportedAux = [...text.matchAll(/\baux\s*(\d+)\b/gi)].some(match => Number(match[1]) !== 1);
      if (destination.problemCode === 'unknown_return' || unsupportedAux || (destination.aux !== undefined && destination.aux !== 1)) {
        this.diagnosticContexts.clear(p.id); this.planningContexts.delete(p.id);
        return { kind: 'answer', source: 'local', code: 'DIAGNOSIS_DESTINATION_UNSUPPORTED', diagnosticContext: null, text: destination.problem ?? 'O diagnóstico técnico atual contempla PA e FONES/AUX1. Não vou tratar esse AUX como AUX1. Consulte os controles desse destino ou descreva uma queixa no PA/AUX1; nenhuma alteração foi preparada.' };
      }
    }
    const parseContext = { names: this.core.controller.names, role: p.role, steps: this.opts.steps, musicianPA: musicianHasPA(this.core.policy) };
    const local = parseProcessingRequest(text, parseContext) ?? parseMixerRequest(text, parseContext) ?? parseRequest(text, parseContext);
    if (local.kind === 'query' || local.kind === 'masterQuery') return this.render(p, local, 'local', undefined, text);
    const explicitCommand = isExplicitMixRequest(text) || isProcessingCommand(text);
    if (explicitCommand && !consultation && local.kind !== 'unknown') {
      this.diagnosticContexts.clear(p.id); this.planningContexts.delete(p.id);
      this.prune();
      return { ...this.render(p, local, 'local', undefined, text), diagnosticContext: null };
    }
    if (explicitCommand && consultation) return { kind: 'answer', source: 'local', text: 'A mensagem mistura comando e diagnóstico. Reformule como comando direto ou como queixa técnica; nada foi ajustado.', code: 'DIAGNOSIS_AMBIGUOUS' };
    if (p.role === 'operator') {
      const parsedStamp = contextStampSchema.optional().safeParse(stamp);
      if (!parsedStamp.success) return error('INVALID', 'Referência de esclarecimento inválida.');
      await this.refreshMics();
      const technical = this.diagnosticContexts.handle(p.id, text, parsedStamp.data);
      if (technical) return this.withKnowledge(p, technical, text);
    } else if (consultation || stamp !== undefined) {
      return error('FORBIDDEN', 'A consulta técnica é exclusiva do operador autenticado.');
    }
    if (isShortConsultationAnswer(text, this.core.controller.names)) return { kind: 'answer', source: 'local', code: 'DIAGNOSIS_CONTEXT_REQUIRED', text: 'Não há esclarecimento técnico autorizado pendente. Descreva uma queixa completa ou um comando direto.' };
    this.prune();
    if (local.kind !== 'unknown') return this.render(p, local, 'local', undefined, text);

    const route = this.opts.mixerRoute?.(p);
    if (route) {
      if (this.core.mode !== 'lab' || this.core.mixer.mode !== 'lab') return error('REAL_READ_ONLY', 'Interpretação operacional por IA disponível somente no LAB.');
      if (this.aiBusy.has(p.id)) return error('BUSY', 'Ainda estou interpretando o pedido anterior.');
      this.aiBusy.add(p.id);
      const snapshot = this.core.controller.state.snapshot();
      const policy = JSON.stringify(this.core.policy), names = JSON.stringify(this.core.controller.names.inputs.terms());
      const candidates = channelCandidates(text, this.core.controller.names);
      const destination = resolveDestination(text, this.core.controller.names);
      const state = candidates.length === 1 && destination.dest ? operatorObservations(this.core, p, candidates[0], destination.dest, destination.aux) : { link: snapshot.link, revision: snapshot.revision, values: 'source_or_destination_not_confirmed' };
      const operations = this.opts.log.recent(30).filter(entry => ['set_level', 'set_mute', 'undo', 'set_master'].includes(entry.action)).slice(-5).map(entry => ({ action: entry.action,
        changes: Array.isArray(entry.details?.changes) ? entry.details.changes.filter(change => change && typeof change.key === 'string' && this.core.controller.registry.has(change.key)).map(change => ({ key: change.key, from: change.from, to: change.to, outcome: change.outcome })) : [] }));
      try {
        const result = await interpretMixerRequest(route, text, { names: this.core.controller.names, steps: this.opts.steps, musicianAux: this.core.policy.musicianAux,
          state, history: { dialogue: (this.history.get(p.id) ?? []).slice(-6), operations } });
        if (!this.core.auth.isActive(p)) return error('UNAUTHORIZED', 'Sessão encerrada durante a interpretação.');
        if (!route.allowed()) return error('AI_SELECTION_CHANGED', 'Seleção ou consentimento mudou; descartei a resposta antiga.');
        const current = this.core.controller.state.snapshot();
        if (current.revision !== snapshot.revision || current.link !== snapshot.link || policy !== JSON.stringify(this.core.policy) || names !== JSON.stringify(this.core.controller.names.inputs.terms()) || this.mixEpoch.get(p.id) !== epoch)
          return error('AI_CONTEXT_CHANGED', 'O estado ou contexto mudou durante a interpretação. Nada foi preparado; faça um novo pedido.');
        if (!result.ok) return error(result.code, result.message);
        if ('diagnosisChannel' in result) {
          const technical = this.diagnosticContexts.handle(p.id, `diagnostico canal ${result.diagnosisChannel}. ${text}`);
          return technical ? this.withKnowledge(p, technical, text) : { kind: 'clarify', source: 'local', question: 'Qual problema você percebe nessa fonte?', options: [] };
        }
        const reply = this.render(p, result.outcome, 'ai', undefined, text);
        this.remember(p.id, text, reply);
        return reply;
      } catch { return error('AI_UNAVAILABLE', 'Não foi possível concluir a interpretação. Nada foi preparado ou executado.'); }
      finally { this.aiBusy.delete(p.id); }
    }
    if (this.opts.usesModelCatalog) return error('AI_NOT_SELECTED', 'Selecione e confirme um provedor/modelo nesta sessão. Não usei um provedor alternativo.');
    const ai = this.opts.ai;
    if (!ai?.available()) {
      return {
        kind: 'answer',
        source: 'local',
        code: 'AI_DISABLED',
        text: 'Não entendi, e o modo IA está desligado. Para descrever um problema, tente algo como "A voz está abafada no retorno", "O surdo está sem grave", "Está microfonando quando o Fred canta" ou "O Fred não aparece quando o coro entra". Para um comando direto, tente "sobe o surdo no PA", "diminui 3 dB da voz Fernando nos fones" ou "desfaz". Nada foi ajustado.',
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
    const reply = this.render(p, r.outcome, 'ai', r.usage, text);
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
    void this.refreshMics();
    return this.capturePlanningContext(p, this.diagnosticContexts.handle(p.id, parsed.data.text, parsed.data.context)
      ?? error('INVALID', 'Descreva o problema (por exemplo "A voz está abafada no retorno" ou "O surdo está sem grave") ou responda ao esclarecimento pendente.'));
  }

  /**
   * Acrescenta o contexto da base local a uma resposta de diagnóstico do operador. Falha da base
   * (ou ausência dela) devolve a resposta original: o motor determinístico continua sendo a resposta.
   */
  private async enrichWithin(k: LocalKnowledge, query: Parameters<LocalKnowledge['enrich']>[0], p: Principal, route?: ChatRoute): Promise<KnowledgeContext> {
    const ms = this.opts.knowledgeDeadlineMs ?? KNOWLEDGE_DEADLINE_MS;
    // enrich() já captura os próprios erros; a captura extra garante que uma rejeição inesperada nunca derrube a resposta.
    const consent = this.opts.externalConsent;
    const consentRevision = consent?.revision;
    const work = k.enrich(query, { ...(route ? { chat: route } : {}), externalAllowed: (id) => this.core.auth.isActive(p) && consent?.revision === consentRevision && consent?.allowed(p, id) === true }).catch((): KnowledgeContext => ({ mode: 'deterministic', degraded: true, reason: 'Base de conhecimento indisponível.', passages: [] }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), ms); });
    try {
      const first = await Promise.race([work, late]);
      if (first !== 'late') return first;
      // o trabalho tardio é descartado, nunca reutilizado
      return { mode: 'deterministic', degraded: true, reason: `A base de conhecimento demorou mais de ${Math.round(ms / 1000)} s (modelo local ocupado ou carregando). Mostrando a orientação local, sem o resumo.`, passages: [], narrativeStatus: { status: 'timeout' } };
    } finally { clearTimeout(timer); }
  }

  async withKnowledge(p: Principal, reply: AssistantReply, text: string): Promise<AssistantReply> {
    this.capturePlanningContext(p, reply);
    const k = this.opts.knowledge;
    if (!k || p.role !== 'operator' || reply.kind !== 'diagnosis' || !this.core.auth.isActive(p)) return reply;
    const known = reply.diagnosticSession?.knownContext;
    // Contexto CONSOLIDADO da conversa (relato original + sintoma + fonte + destino + esclarecimentos). O texto da mensagem
    // só é usado quando a resposta não veio da conversa guiada (consulta direta, sem esclarecimentos): nunca "Fones" sozinho.
    const query = knowledgeQueryOf(reply) ?? {
      text, symptom: known?.symptom ?? undefined, instrument: known?.instrument ?? undefined,
      channel: known?.channel ?? undefined, destination: known?.destination ?? undefined,
    };
    // Relato ainda vago ("violão horrível"): sem sintoma, não há o que buscar. A base e o modelo local só entram depois do esclarecimento.
    if (!query.symptom) return reply;
    // A revisão do consentimento entra na chave: trocar/revogar o provedor externo invalida o resumo guardado.
    const route = this.opts.chatRoute?.(p);
    const key = JSON.stringify([query.text, query.symptom, query.instrument, query.channel, query.destination, this.opts.externalConsent?.revision ?? 0, k.providers().chat.selected, route?.key ?? 'legado']);
    const hit = this.knowledgeCache.get(p.id);
    let knowledge: KnowledgeContext;
    if (hit && hit.key === key && hit.expiresAt > this.now()) knowledge = structuredClone(hit.knowledge);
    else {
      // A consulta documental (busca + resumo do modelo local) é OPCIONAL: não pode segurar a orientação determinística além do prazo da interface.
      const consentAtStart = this.opts.externalConsent?.revision ?? 0;
      knowledge = await this.enrichWithin(k, query, p, route);
      // Consentimento mudou durante a consulta: o resultado pode ter vindo de um envio já revogado. O LocalKnowledge já descarta o
      // resumo externo; aqui garantimos que nada dessa rodada fica em cache.
      // (Com rota do catálogo o consentimento é o do catálogo, avaliado abaixo: a seleção legada de outra sessão não interfere.)
      if (!route && (this.opts.externalConsent?.revision ?? 0) !== consentAtStart) {
        knowledge = { mode: 'deterministic', degraded: true, reason: 'Consentimento alterado durante a consulta; resposta descartada.', passages: [], narrativeStatus: { status: 'not_consented' } };
      }
      // Seleção/consentimento do catálogo mudou (ou a sessão acabou) durante a consulta: a resposta é da seleção ANTIGA e é descartada.
      if (route && !route.allowed()) {
        knowledge = { mode: 'deterministic', degraded: true, reason: 'Seleção de modelo ou consentimento alterado durante a consulta; resposta descartada.', passages: [], narrativeStatus: { status: 'not_consented', rule: 'selecao_alterada' } };
      }
      // Resultado degradado (Ollama fora, tempo esgotado) não é guardado: a próxima volta tenta de novo.
      const transient = knowledge.degraded || ['timeout', 'unavailable', 'error'].includes(knowledge.narrativeStatus?.status ?? '');
      if (!transient && this.core.auth.isActive(p)) {
        if (this.knowledgeCache.size >= KNOWLEDGE_CACHE_SESSIONS && !this.knowledgeCache.has(p.id)) this.knowledgeCache.delete(this.knowledgeCache.keys().next().value!);
        this.knowledgeCache.set(p.id, { key, expiresAt: this.now() + KNOWLEDGE_CACHE_MS, knowledge: structuredClone(knowledge) });
      }
    }
    return this.core.auth.isActive(p) ? { ...reply, knowledge } : reply;
  }

  private capturePlanningContext(p: Principal, reply: AssistantReply): AssistantReply {
    if (p.role !== 'operator' || !this.core.auth.isActive(p)) return reply;
    const session = reply.diagnosticSession;
    if (session) {
      const key = JSON.stringify(session), old = this.planningContexts.get(p.id);
      if (!old || old.expiresAt <= this.now() || old.key !== key) {
        if (this.planningContexts.size >= 128 && !old) this.planningContexts.delete(this.planningContexts.keys().next().value!);
        this.planningContexts.set(p.id, { session: structuredClone(session), key, revision: ++this.planningRevision,
          expiresAt: session.expiresAt ? Date.parse(session.expiresAt) : this.now() + 300_000 });
      }
    } else if (reply.diagnosticContext === null) this.planningContexts.delete(p.id);
    const context = reply.diagnosticSession?.knownContext;
    if (context?.channel && context.destination) reply.observations = operatorObservations(this.core, p, context.channel, context.destination);
    return reply;
  }
  planningContext(p: Principal): { session: NonNullable<ConsultationReply['diagnosticSession']>; revision: number } | undefined {
    if (p.role !== 'operator' || !this.core.auth.isActive(p)) return undefined;
    const cached = this.planningContexts.get(p.id);
    if (!cached || cached.expiresAt <= this.now()) { this.planningContexts.delete(p.id); return undefined; }
    return { session: structuredClone(cached.session), revision: cached.revision };
  }

  sweep(): void {
    this.diagnosticContexts.sweep(id => this.core.auth.isActive({ id, role: 'operator', label: 'operador' }));
    const now = this.now();
    for (const [id, pending] of this.mixPending) if (pending.expires <= now) this.mixPending.delete(id);
    for (const [id, c] of this.planningContexts) if (now >= c.expiresAt || !this.core.auth.isActive({ id, role: 'operator', label: 'operador' })) this.planningContexts.delete(id);
    for (const [id, c] of this.knowledgeCache) if (now >= c.expiresAt || !this.core.auth.isActive({ id, role: 'operator', label: 'operador' })) this.knowledgeCache.delete(id);
  }
  stop(): void {
    this.removeRevokeListener();
    this.diagnosticContexts.stop();
    this.knowledgeCache.clear(); this.planningContexts.clear(); this.mixPending.clear(); this.mixEpoch.clear(); this.history.clear(); this.proposals.clear(); this.applied.clear();
  }

  /** B3A: autorização e validação comuns a chat, HTTP e WS. Nunca cria propostas. */
  diagnose(p: Principal, raw: unknown): AssistantReply {
    if (!this.core.auth.isActive(p)) return error('UNAUTHORIZED', 'Sessão encerrada ou expirada.');
    if (p.role !== 'operator') return error('FORBIDDEN', 'A consulta técnica é exclusiva do operador autenticado.');
    const parsed = consultationSchema.safeParse(raw);
    if (!parsed.success) return error('INVALID', 'Consulta inválida: informe sintoma, canal/fonte, destino e evidências com origem, sem comandos ou aprovações.');
    try {
      return this.capturePlanningContext(p, consult(parsed.data, this.core.controller.names, this.core.policy.musicianAux));
    } catch (err) {
      return error('INVALID', (err as Error).message);
    }
  }

  /** Aplica uma proposta: confere se o estado ainda é o do cálculo e manda para a fila da E2. */
  async apply(p: Principal, proposalId: unknown, requestId: unknown): Promise<ApplyReply> {
    if (this.core.mode === 'real' || this.core.mixer.mode === 'real') return { status: 'failed', message: 'REAL permanece somente leitura; nenhum comando enviado pelo assistente.' };
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
    const r = await this.core.execute(p, { requestId, command: pr.command }, { expect: { revisions: pr.bound, undoId: pr.undoId, authorize: () => this.core.auth.isActive(p) && this.core.mode !== 'real' && this.core.mixer.mode !== 'real' } });
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
    const expected = pr.card.parameters ?? [];
    const changes = (result.data as { changes?: Array<{ key: string; to: number | boolean | '-inf'; outcome: string }> } | undefined)?.changes;
    const targets = expected.length ? expected.map(item => ({ key: item.key, value: item.target === '-inf' ? -Infinity : item.target })) :
      (changes ?? []).map(item => ({ key: item.key as import('../core/revisions.js').ParamKey, value: item.to === '-inf' ? -Infinity : item.to }));
    const readings = targets.map(item => { const read = this.core.mixer.read(item.key); return { key: item.key, known: read.known, matches: read.known && sameValue(read.value, item.value) }; });
    const verified = readings.length > 0 && readings.every(item => item.known && item.matches) && this.core.mixer.link() === 'READY';
    const verification: NonNullable<ApplyReply['verification']> = { source: 'lab_readback', outcome: verified ? 'confirmed' : readings.some(item => item.known && !item.matches) ? 'different' : 'unavailable', readings };
    if (!verified && targets.length) return { status: 'unconfirmed', message: 'A execução retornou, mas a leitura de retorno não confirmou o valor. Pode ter sido aplicado; confira manualmente. Nenhum reenvio automático.', result, verification };
    this.applied.set(pr.card.id, pr);
    return { status: 'applied', message: result.message, result, askFeedback: !!pr.revert, verification };
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

  private render(p: Principal, outcome: ParseOutcome, source: AssistantReply['source'], ai?: AiUsage, requestText?: string): AssistantReply {
    if (outcome.kind === 'clarify') {
      let options = outcome.options;
      if (!options.length && requestText && /destino|PA|AUX/.test(outcome.question)) options = [{ label: 'PA', text: `${requestText} no PA` }, { label: 'Fones', text: `${requestText} nos fones` }];
      if (requestText && options.some(option => option.label === 'PA') && p.role === 'operator') {
        const base = options.find(option => option.label === 'PA')!.text.replace(/ no PA$/, '');
        options = [...options, ...this.core.controller.names.aux.list().filter(aux => aux.number !== this.core.policy.musicianAux).slice(0, 6).map(aux => ({ label: `AUX ${aux.number}`, text: `${base} no AUX ${aux.number}` }))];
      }
      if (requestText) {
        if (this.mixPending.size >= 128) this.mixPending.delete(this.mixPending.keys().next().value!);
        this.mixPending.set(p.id, { text: requestText, options, expires: this.now() + this.opts.ttlMs });
      }
      return { kind: 'clarify', source, question: outcome.question, options, ai };
    }
    if (outcome.kind === 'masterQuery') {
      const snapshot = this.core.snapshotFor(p), state = snapshot.params['master.level'];
      if (!state) return error('FORBIDDEN', 'Master não está visível para esta sessão.');
      const value = state.value.status === 'known' && (typeof state.value.value === 'number' || state.value.value === '-inf') ? fmtDb(state.value.value === '-inf' ? -Infinity : state.value.value) : 'leitura indisponível/desconhecida';
      return { kind: 'answer', source: 'local', text: `Master: ${value}. Modo ${this.core.mode}; conexão ${snapshot.link}. Nenhuma alteração.` };
    }
    if (outcome.kind === 'query') {
      const observations = operatorObservations(this.core, p, outcome.channel, outcome.dest, outcome.aux);
      if (!observations) return error('FORBIDDEN', 'Esse canal/destino não está visível para esta sessão.');
      const parameter = observations.parameters.find(item => item.key.endsWith(`.${outcome.parameter === 'mute' ? 'mute' : 'level'}`));
      const value = parameter?.status === 'known' ? typeof parameter.value === 'boolean' ? parameter.value ? 'mutado' : 'aberto' : fmtDb(parameter.value === '-inf' ? -Infinity : parameter.value as number) : 'leitura indisponível/desconhecida';
      return { kind: 'answer', source: 'local', text: `${this.core.controller.names.inputs.nameOf(outcome.channel)} (${observations.destination}): ${value}.${outcome.parameter === 'configuration' ? ' HPF/EQ são mostrados apenas conforme a capacidade disponível; ganho e roteamento físico não são medidos. Nenhuma alteração.' : ''}`, observations };
    }
    if (outcome.kind === 'answer') return { kind: 'answer', source, text: outcome.text, ai };
    if (outcome.kind === 'unknown') return { kind: 'answer', source, text: 'Não entendi o pedido.', ai };
    if (this.core.mode === 'real' || this.core.mixer.mode === 'real') {
      if (p.role !== 'operator' || !this.opts.realPreview) return error('REAL_READ_ONLY', 'REAL permanece somente leitura; nenhuma proposta de escrita foi criada.');
      if (outcome.intents.length !== 1) return error('INVALID', 'REAL exige um único parâmetro; não preparo operações em lote.');
      const prepared = this.opts.realPreview(p, outcome.intents[0]!, source);
      if (!prepared.proposal) return error('REAL_READ_ONLY', `Recurso REAL bloqueado ou recusado: ${prepared.result?.message ?? 'categoria REAL desabilitada.'} Nada foi preparado ou enviado.`);
      return { kind: 'proposals', source, proposals: [prepared.proposal], text: 'Proposta REAL: nada foi enviado. Confira canal, destino, valor anterior e valor proposto e confirme no cartão; o envio só ocorre depois da sua confirmação.' };
    }
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
