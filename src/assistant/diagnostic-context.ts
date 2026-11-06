import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { words, type ChannelMap } from '../core/channels.js';
import { consult, isShortConsultationAnswer, matchConsultationChoice, parseConsultation, type ConsultationInput, type ConsultationReply } from './sound-engineer.js';

export const CONTEXT_TTL_MS = 5 * 60_000;
export const CONTEXT_LIMITS = { pending: 128, sessions: 256, requestsPerMinute: 20 } as const;
export const contextStampSchema = z.strictObject({ id: z.string().uuid(), revision: z.number().int().positive() });
export const conversationSchema = z.strictObject({ text: z.string().trim().min(1).max(500), context: contextStampSchema.optional() });
export type ContextStamp = z.infer<typeof contextStampSchema>;
export interface DiagnosticContextView extends ContextStamp {
  expiresAt: string;
  subject: string;
  question: string;
  field: NonNullable<ConsultationReply['clarification']>['field'];
}
export interface ContextReply {
  kind: 'answer' | 'error'; source: 'local'; text: string; code: string;
  diagnosticContext: DiagnosticContextView | null;
}
export type ContextualReply = ((ConsultationReply & { diagnosticContext: DiagnosticContextView | null }) | ContextReply) & { code?: string };
interface Pending { id: string; revision: number; expiresAt: number; input: ConsultationInput }

/** Estado síncrono, somente no servidor: nenhuma chamada externa entre comparar revisão e atualizar. */
export class DiagnosticContexts {
  private pending = new Map<string, Pending>();
  private rates = new Map<string, { until: number; count: number }>();
  constructor(private names: ChannelMap, private aux: number, private options: {
    clock?: () => number; ttlMs?: number; maxPending?: number; maxSessions?: number; requestsPerMinute?: number; id?: () => string;
  } = {}) {}
  private now() { return (this.options.clock ?? Date.now)(); }

  sweep(active: (id: string) => boolean = () => true): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (now >= pending.expiresAt || !active(id)) this.pending.delete(id);
    for (const [id, rate] of this.rates) if (now >= rate.until || !active(id)) this.rates.delete(id);
  }
  clear(id: string): void { this.pending.delete(id); }
  revoke(id: string): void { this.pending.delete(id); this.rates.delete(id); }
  stop(): void { this.pending.clear(); this.rates.clear(); }
  /** Apenas contagens; não expõe conteúdo de outra sessão. */
  get size() { return this.pending.size; }

  handle(id: string, text: string, stamp?: ContextStamp): ContextualReply | undefined {
    this.sweep();
    const current = this.pending.get(id);
    const normalized = words(text).join(' ');
    const cancel = /^(?:cancela|cancelar|cancelar diagnostico|cancelar o diagnostico|cancela o diagnostico|cancelar consulta|cancelar investigacao|mudar de assunto|novo assunto)$/.test(normalized);
    const restart = /^(?:novo diagnostico|nova consulta|reiniciar diagnostico)$/.test(normalized);
    const parsed = parseConsultation(text, this.names);
    if (!current && !parsed && !cancel && !restart && !stamp && !isShortConsultationAnswer(text, this.names)) return undefined;
    const matching = !stamp || (!!current && current.id === stamp.id && current.revision === stamp.revision);
    if (cancel && matching) {
      this.clear(id);
      return this.message('DIAGNOSIS_CANCELLED', 'Diagnóstico encerrado. Nenhuma proposta ou alteração foi criada. Você pode iniciar outro assunto.');
    }
    if (!this.allow(id)) return this.message('DIAGNOSIS_RATE_LIMIT', 'Limite temporário de consultas por sessão ou de sessões atendidas. Aguarde; comandos diretos continuam disponíveis.', current);
    if (stamp && (!current || current.id !== stamp.id || current.revision !== stamp.revision)) {
      return this.message('DIAGNOSIS_CONTEXT_STALE', 'Este esclarecimento expirou ou mudou. Use a pergunta atual ou inicie um diagnóstico completo.', current);
    }
    if (restart) return this.save(id, { evidence: [] });
    if (current) {
      const choice = matchConsultationChoice(text, consult(current.input, this.names, this.aux), this.names);
      if (choice) return this.save(id, choice.input, current);
    }
    if (parsed && (!current || parsed.evidence.length > 0 || normalized.split(' ').length > 2)) return this.save(id, parsed);
    if (!current) return this.message('DIAGNOSIS_CONTEXT_REQUIRED', 'Não há esclarecimento pendente nesta sessão. Descreva uma nova queixa completa; nada foi ajustado.');
    const reply = consult(current.input, this.names, this.aux);
    return this.message('DIAGNOSIS_CLARIFY', `Não interpretei essa resposta como o campo solicitado. ${reply.clarification?.question ?? 'Inicie uma nova queixa.'} Para mudar de assunto, descreva a nova queixa ou cancele o diagnóstico.`, current);
  }

  private allow(id: string): boolean {
    const now = this.now();
    let rate = this.rates.get(id);
    if (!rate) {
      if (this.rates.size >= (this.options.maxSessions ?? CONTEXT_LIMITS.sessions)) return false;
      rate = { until: now + 60_000, count: 0 };
      this.rates.set(id, rate);
    }
    if (rate.count >= (this.options.requestsPerMinute ?? CONTEXT_LIMITS.requestsPerMinute)) return false;
    rate.count++;
    return true;
  }
  private save(id: string, input: ConsultationInput, previous?: Pending): ContextualReply {
    const reply = consult(input, this.names, this.aux);
    if (!reply.clarification) {
      this.clear(id);
      return { ...reply, diagnosticContext: null };
    }
    if (!this.pending.has(id) && this.pending.size >= (this.options.maxPending ?? CONTEXT_LIMITS.pending)) {
      return this.message('DIAGNOSIS_CAPACITY', 'Limite de investigações pendentes atingido. Tente novamente após expiração de outra consulta.');
    }
    const pending: Pending = {
      id: previous?.id ?? (this.options.id ?? randomUUID)(), revision: (previous?.revision ?? 0) + 1,
      expiresAt: previous?.expiresAt ?? this.now() + (this.options.ttlMs ?? CONTEXT_TTL_MS),
      // Somente campos confirmados e evidências necessárias; sem guardar transcrição dos turnos.
      input: structuredClone(input),
    };
    this.pending.set(id, pending);
    return { ...reply, diagnosticContext: this.view(pending, reply) };
  }
  private view(pending: Pending, reply = consult(pending.input, this.names, this.aux)): DiagnosticContextView {
    const input = pending.input;
    return {
      id: pending.id, revision: pending.revision, expiresAt: new Date(pending.expiresAt).toISOString(),
      subject: `${input.channel ? this.names.inputs.nameOf(input.channel) : 'Fonte a confirmar'} · ${input.symptom ?? 'Sintoma a confirmar'} · ${input.destination?.toUpperCase() ?? 'Destino a confirmar'}`,
      field: reply.clarification!.field, question: reply.clarification!.question,
    };
  }
  private message(code: string, text: string, current?: Pending): ContextReply {
    return { kind: code === 'DIAGNOSIS_RATE_LIMIT' || code === 'DIAGNOSIS_CAPACITY' ? 'error' : 'answer', source: 'local', code, text, diagnosticContext: current ? this.view(current) : null };
  }
}
