import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { words, type ChannelMap } from '../core/channels.js';
import { diagnosticSessionSchema, isShortConsultationAnswer, matchConsultationChoice, parseConsultation, sanitizeDiagnosticText,
  type ConsultationInput, type ConsultationReply, type DiagnosticProgress, type DiagnosticSession, type DiagnosticQuestionField } from './sound-engineer.js';
import { guidedConsultation, progressChoice, reportedProgress } from './diagnostic-session.js';

export const CONTEXT_TTL_MS = 5 * 60_000;
export const CONTEXT_LIMITS = { pending: 128, sessions: 256, requestsPerMinute: 20 } as const;
export const contextStampSchema = z.strictObject({ id: z.string().uuid(), revision: z.number().int().positive() });
export const conversationSchema = z.strictObject({ text: z.string().trim().min(1).max(500), context: contextStampSchema.optional() });
export type ContextStamp = z.infer<typeof contextStampSchema>;
export interface DiagnosticContextView extends ContextStamp {
  expiresAt: string; subject: string; question: string; field: DiagnosticQuestionField;
}
export interface ContextReply {
  kind: 'answer' | 'error'; source: 'local'; text: string; code: string;
  diagnosticContext: DiagnosticContextView | null; diagnosticSession: DiagnosticSession | null;
  diagnosis?: ConsultationReply['diagnosis']; technicalDetails?: ConsultationReply['technicalDetails']; references?: ConsultationReply['references'];
}
export type ContextualReply = ((ConsultationReply & { diagnosticContext: DiagnosticContextView | null }) | ContextReply) & { code?: string };
interface Pending { id: string; revision: number; expiresAt: number; input: ConsultationInput; progress: DiagnosticProgress; complaint: string }

/**
 * O que a base de conhecimento (e o modelo local) devem receber: o relato ORIGINAL do operador, o sintoma, a fonte, o destino e
 * os esclarecimentos já dados, nunca a última resposta isolada ("Fones", "Microfone"). Só existe no servidor.
 */
export interface KnowledgeQuery { text: string; symptom?: string; instrument?: string; channel?: number; destination?: string }
const QUERY = Symbol('mixai.knowledgeQuery');
/** A consulta consolidada vai como propriedade NÃO enumerável: nunca é serializada para a tela, o HTTP ou o WebSocket. */
export function knowledgeQueryOf(reply: unknown): KnowledgeQuery | undefined {
  return reply && typeof reply === 'object' ? (reply as Record<symbol, KnowledgeQuery | undefined>)[QUERY] : undefined;
}
function withQuery<T extends object>(reply: T, query: KnowledgeQuery | undefined): T {
  if (query) Object.defineProperty(reply, QUERY, { value: query, enumerable: false });
  return reply;
}
const COMPLAINT_MAX = 300;
const joinComplaint = (a: string, b: string) => (a ? `${a} ${b}` : b).replace(/\s+/g, ' ').trim().slice(0, COMPLAINT_MAX);
const norm = (text: string) => words(text).join(' ');

/** One bounded, synchronous state machine per authenticated principal; no execution capability. */
export class DiagnosticContexts {
  private pending = new Map<string, Pending>();
  private rates = new Map<string, { until: number; count: number }>();
  constructor(private names: ChannelMap, private aux: number, private options: {
    clock?: () => number; ttlMs?: number; maxPending?: number; maxSessions?: number; requestsPerMinute?: number; id?: () => string;
    /** Captação já CADASTRADA para o canal (hoje: microfone com modelo confirmado). Se existe, a pergunta não é feita; se não, continua sendo. */
    registeredCapture?: (channel: number) => 'microphone' | undefined;
  } = {}) {}
  /** Progresso efetivo: o que o operador respondeu + o que o cadastro já sabe. Nunca inventa: sem cadastro, nada é preenchido. */
  private effective(input: ConsultationInput, progress: DiagnosticProgress): DiagnosticProgress {
    if (progress.capture !== undefined || input.channel === undefined) return progress;
    const capture = this.options.registeredCapture?.(input.channel);
    return capture ? { ...progress, capture } : progress;
  }
  private guided(input: ConsultationInput, progress: DiagnosticProgress): ConsultationReply {
    return guidedConsultation(input, this.names, this.aux, this.effective(input, progress));
  }
  private now() { return (this.options.clock ?? Date.now)(); }
  sweep(active: (id: string) => boolean = () => true): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (now >= p.expiresAt || !active(id)) this.pending.delete(id);
    for (const [id, rate] of this.rates) if (now >= rate.until || !active(id)) this.rates.delete(id);
  }
  clear(id: string): void { this.pending.delete(id); }
  revoke(id: string): void { this.pending.delete(id); this.rates.delete(id); }
  stop(): void { this.pending.clear(); this.rates.clear(); }
  get size() { return this.pending.size; }

  handle(id: string, raw: string, stamp?: ContextStamp): ContextualReply | undefined {
    this.sweep();
    const current = this.pending.get(id);
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return this.message('INVALID', 'Use uma resposta de até 500 caracteres.', current);
    const text = sanitizeDiagnosticText(raw), normalized = norm(text);
    const cancel = /^(?:cancela|cancelar|cancelar diagnostico|cancelar o diagnostico|cancela o diagnostico|cancelar consulta|cancelar investigacao|mudar de assunto|novo assunto)$/.test(normalized);
    const restart = /^(?:novo diagnostico|nova consulta|reiniciar diagnostico|reiniciar|reset)$/.test(normalized);
    const parsed = parseConsultation(text, this.names);
    if (!current && !parsed && !cancel && !restart && !stamp && !isShortConsultationAnswer(text, this.names)) return undefined;
    const matching = !stamp || (!!current && current.id === stamp.id && current.revision === stamp.revision);
    if (cancel && matching) { this.clear(id); return this.message('DIAGNOSIS_CANCELLED', 'Diagnóstico encerrado. Nenhuma proposta ou alteração foi criada.'); }
    if (!this.allow(id)) return this.message('DIAGNOSIS_RATE_LIMIT', 'Limite temporário de consultas. Aguarde; comandos diretos continuam disponíveis.', current);
    if (!matching) return this.message('DIAGNOSIS_CONTEXT_STALE', 'Este esclarecimento expirou ou mudou. Use a pergunta atual ou inicie um diagnóstico completo.', current);
    if (restart) return this.save(id, { evidence: [] }, undefined, { results: [] }, '');
    if (current) {
      const reply = this.guided(current.input, current.progress);
      if (/^(?:detalhes|fontes|justificativas|ver detalhes|mostrar fontes)$/.test(normalized)) return this.present(current, reply);
      const correction = this.correction(text, current);
      if (correction) return this.save(id, correction.input, current, correction.progress);
      const basic = reply.clarification && ['symptom', 'channel', 'instrument', 'destination'].includes(reply.clarification.field)
        ? matchConsultationChoice(text, reply, this.names) : undefined;
      const facts = reportedProgress(text, current.input.destination);
      const field = reply.clarification?.field;
      const selected = progressChoice(text, reply.diagnosticSession, parsed?.symptom) ?? (field === 'scope' ? facts.scope : field === 'isolation' ? facts.isolation : field === 'capture' ? facts.capture : undefined);
      if (basic) return this.save(id, basic.input, current, { ...current.progress, ...reportedProgress(text, basic.input.destination) });
      if (selected !== undefined && reply.clarification) {
        const field = reply.clarification.field;
        if (['symptom', 'channel', 'instrument', 'destination'].includes(field)) {
          const at = reply.diagnosticSession.choices.findIndex(c => c.value === selected);
          if (at >= 0) return this.save(id, reply.diagnosticOptions[at]!.input, current);
        } else {
          const progress = structuredClone(current.progress), input = structuredClone(current.input);
          if (field === 'check' && reply.diagnosticSession.nextCheck) progress.results.push({ checkId: reply.diagnosticSession.nextCheck.id, result: selected as DiagnosticProgress['results'][number]['result'] });
          else if (field === 'scope') progress.scope = selected as DiagnosticProgress['scope'];
          else if (field === 'isolation') progress.isolation = selected as DiagnosticProgress['isolation'];
          else if (field === 'capture') progress.capture = selected as DiagnosticProgress['capture'];
          else if (field === 'report') {
            progress.report = selected as DiagnosticProgress['report'];
            if (selected === 'current' && input.symptom) input.evidence.push({ id: `reported-turn-${current.revision}`, kind: 'operator_report', symptom: input.symptom,
              detail: 'O operador confirmou estar relatando este sintoma agora; não houve medição de áudio.' });
          }
          return this.save(id, input, current, progress);
        }
      }
      if (parsed?.evidence.length && parsed.symptom === current.input.symptom &&
        (parsed.channel === undefined || parsed.channel === current.input.channel) &&
        (parsed.destination === undefined || parsed.destination === current.input.destination) &&
        parsed.evidence.every(e => current.input.evidence.some(old => old.kind === e.kind && old.detail === e.detail && 'symptom' in old && 'symptom' in e && old.symptom === e.symptom))) {
        return this.present(current, reply); // repeated complaint/network retry does not restart the interview
      }
      if (parsed && (parsed.evidence.length > 0 || normalized.split(' ').length > 2)) {
        // An explicitly named new source starts a clean investigation. An anaphoric new
        // symptom keeps the confirmed source/path, never importing another user's state.
        if (parsed.channel !== undefined && parsed.channel !== current.input.channel || parsed.relatedInstruments?.length && !parsed.relatedInstruments.includes(current.input.instrument!)) {
          return this.save(id, parsed, undefined, { ...reportedProgress(text, parsed.destination), results: [] }, text);
        }
        if (parsed.evidence.length) {
          const evidence = [...current.input.evidence, ...parsed.evidence.map(e => ({ ...e, id: `${e.id}-turn-${current.revision}` }))];
          if (evidence.length > 20) return this.message('DIAGNOSIS_CAPACITY', 'Limite de relatos desta investigação; reinicie para continuar.', current);
          const input = { ...current.input, ...Object.fromEntries(Object.entries(parsed).filter(([key, v]) => v !== undefined && !(key === 'relatedInstruments' && Array.isArray(v) && !v.length))), evidence } as ConsultationInput;
          if (!parsed.symptom && (parsed.symptomCandidates?.length ?? 0) > 1) input.symptom = undefined;
          const sameSymptom = input.symptom === current.input.symptom;
          return this.save(id, input, current, { ...(sameSymptom ? current.progress : { capture: current.progress.capture }), ...reportedProgress(text, input.destination), results: [] }, joinComplaint(current.complaint, text));
        }
      }
      const unavailable = /\b(?:canal|ch) ?(\d+)\b/.exec(normalized);
      return this.message('DIAGNOSIS_CLARIFY', unavailable && !this.names.inputs.configured().includes(Number(unavailable[1]))
        ? 'Esse canal não está disponível no cadastro. Use uma das fontes oferecidas.' : 'Não confirmei essa resposta. Use uma das opções da pergunta atual.', current);
    }
    if (parsed) return this.save(id, parsed, undefined, { ...reportedProgress(text, parsed.destination), results: [] }, text);
    return this.message('DIAGNOSIS_CONTEXT_REQUIRED', 'Não há esclarecimento pendente nesta sessão. Descreva uma nova queixa completa; nada foi ajustado.');
  }

  private correction(text: string, current: Pending): { input: ConsultationInput; progress: DiagnosticProgress } | undefined {
    const raw = norm(text);
    if (!/^(?:na verdade|corrigindo|correcao|corrigir)\b/.test(raw) || /\b(se|talvez|nao)\b/.test(raw)) return undefined;
    const body = raw.replace(/^(?:na verdade|corrigindo|correcao|corrigir) (?:e )?/, '');
    const pa = /\bpa\b/.test(body), fones = /\b(fones?|retorno|aux ?1)\b/.test(body);
    if (pa !== fones) {
      const destination = pa ? 'pa' as const : 'fones' as const;
      return { input: { ...current.input, destination }, progress: { ...reportedProgress(text, destination), capture: current.progress.capture, results: [] } };
    }
    try {
      const channel = this.names.channel(body).number;
      if (!this.names.inputs.configured().includes(channel)) return undefined;
      return { input: { ...current.input, channel, instrument: undefined, relatedInstruments: [] }, progress: { results: [] } };
    } catch { return undefined; }
  }
  private allow(id: string): boolean {
    const now = this.now(); let rate = this.rates.get(id);
    if (!rate) {
      if (this.rates.size >= (this.options.maxSessions ?? CONTEXT_LIMITS.sessions)) return false;
      rate = { until: now + 60_000, count: 0 }; this.rates.set(id, rate);
    }
    if (rate.count >= (this.options.requestsPerMinute ?? CONTEXT_LIMITS.requestsPerMinute)) return false;
    rate.count++; return true;
  }
  private save(id: string, input: ConsultationInput, previous?: Pending, progress = previous?.progress ?? { results: [] }, complaint = previous?.complaint ?? ''): ContextualReply {
    let reply: ConsultationReply;
    try { reply = this.guided(input, progress); }
    catch { this.clear(id); return this.message('INVALID', 'Fonte ou destino indisponível para esta consulta; confira o cadastro e o AUX.'); }
    input = { ...input, instrument: reply.diagnosticSession.knownContext.instrument ?? input.instrument };
    if (reply.clarification && !this.pending.has(id) && this.pending.size >= (this.options.maxPending ?? CONTEXT_LIMITS.pending)) {
      return this.message('DIAGNOSIS_CAPACITY', 'Limite de investigações pendentes atingido. Aguarde uma expiração.');
    }
    const pending: Pending = { id: previous?.id ?? (this.options.id ?? randomUUID)(), revision: (previous?.revision ?? 0) + 1,
      expiresAt: previous?.expiresAt ?? this.now() + (this.options.ttlMs ?? CONTEXT_TTL_MS), input: structuredClone(input), progress: structuredClone(progress), complaint: complaint.slice(0, COMPLAINT_MAX) };
    if (reply.clarification) this.pending.set(id, pending); else this.clear(id);
    return this.present(pending, reply);
  }
  private present(pending: Pending, reply = this.guided(pending.input, pending.progress)): ContextualReply {
    const session = diagnosticSessionSchema.parse({ ...reply.diagnosticSession, sessionId: pending.id, revision: pending.revision, expiresAt: new Date(pending.expiresAt).toISOString() });
    return withQuery({ ...reply, diagnosticSession: session, diagnosticContext: reply.clarification ? this.view(pending, reply) : null }, this.knowledgeQuery(pending, session.knownContext));
  }
  /** Relato original + esclarecimentos já dados. A ordem importa: o relato vem primeiro (o resto pode ser cortado pelo limite). */
  private knowledgeQuery(pending: Pending, known: DiagnosticSession['knownContext']): KnowledgeQuery {
    const p = this.effective(pending.input, pending.progress), to = pending.input.destination;
    const hints = [
      p.scope === 'selected_only' ? (to === 'fones' ? 'Só no retorno.' : 'Só no PA.') : p.scope === 'both' ? 'Acontece no PA e nos fones.' : '',
      p.isolation === 'alone' ? 'Soa assim também sozinha.' : p.isolation === 'ensemble' ? 'Só soa assim com a banda.' : '',
      p.capture === 'microphone' ? 'A fonte usa microfone.' : p.capture === 'pickup_di' ? 'A fonte usa captador ou DI.' : '',
    ].filter(Boolean);
    const complaint = pending.complaint && !/[.!?]$/.test(pending.complaint) ? `${pending.complaint}.` : pending.complaint; // frases separadas no prompt
    return { text: [complaint, ...hints].filter(Boolean).join(' ').slice(0, 400), symptom: known.symptom ?? undefined,
      instrument: known.instrument ?? undefined, channel: known.channel ?? undefined, destination: known.destination ?? undefined };
  }
  private view(pending: Pending, reply = this.guided(pending.input, pending.progress)): DiagnosticContextView {
    return { id: pending.id, revision: pending.revision, expiresAt: new Date(pending.expiresAt).toISOString(),
      subject: `${pending.input.channel ? this.names.inputs.nameOf(pending.input.channel) : 'Fonte a confirmar'} · ${pending.input.symptom ?? 'Sintoma a confirmar'} · ${pending.input.destination?.toUpperCase() ?? 'Destino a confirmar'}`,
      field: reply.clarification!.field, question: reply.clarification!.question };
  }
  private message(code: string, text: string, current?: Pending): ContextReply {
    const projection = current ? this.present(current) : undefined;
    return withQuery({ kind: ['INVALID', 'DIAGNOSIS_RATE_LIMIT', 'DIAGNOSIS_CAPACITY'].includes(code) ? 'error' as const : 'answer' as const, source: 'local' as const, code,
      text: `${text}${projection?.diagnosticContext ? ` ${projection.diagnosticContext.question}` : ''}`,
      diagnosticContext: projection?.diagnosticContext ?? null, diagnosticSession: projection?.diagnosticSession ?? null,
      ...(projection?.kind === 'diagnosis' ? { diagnosis: projection.diagnosis, technicalDetails: projection.technicalDetails, references: projection.references } : {}) }, projection ? knowledgeQueryOf(projection) : undefined);
  }
}
