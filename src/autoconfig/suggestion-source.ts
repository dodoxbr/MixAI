import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { AutoConfigProposal, type AutoConfigSuggestionSource } from './contracts.js';
import { ReferenceError } from '../reference/schema.js';
import type { Principal } from '../server/auth.js';
import type { LoadedConfig } from '../core/config.js';
import type { ChannelMap } from '../core/channels.js';
import { m1RequiresStop, plannerInputFromSession } from './planner/kb-adapter.js';
import { answerPlannerQuestion, plannerFingerprint } from './planner/engine.js';
import { createConfiguredPlanner } from './planner/provider-adapter.js';
import { plannerResultSchema, type AutoConfigPlannerPort, type PlannerInput, type PlannerResult } from './planner/contracts.js';
const scopeOf = (d: PlannerInput['destination']) => d === 'pa' ? 'PA' as const : d === 'fones' ? 'AUX1' as const : undefined;
const destinationOf = (s: 'PA' | 'AUX1' | undefined) => s === 'PA' ? 'pa' as const : s === 'AUX1' ? 'fones' as const : undefined;

import { AdvisoryRequest, AdvisoryResponse, advisoryKnownField, type AutoConfigAdvice } from './advisory-contracts.js';
export { AdvisoryRequest, AdvisoryResponse, type AutoConfigAdvice } from './advisory-contracts.js';
/** Non-mutating endpoint/transport port. All authoritative D action contracts are unchanged. */
export interface AutoConfigAdvisoryPort { suggest(p: Principal, raw: unknown): Promise<AutoConfigAdvice> }
class AdviceOnly extends Error { constructor(readonly advice: PlannerResult) { super('ADVICE_ONLY'); } }

/** Implements D's exact suggestion port. No inspection is converted into a number. */
export class ConsultativeSuggestionSource implements AutoConfigSuggestionSource {
  result?: PlannerResult;
  constructor(private planner: AutoConfigPlannerPort, private input: PlannerInput, private scope: 'PA' | 'AUX1') {}
  async propose(request: Parameters<AutoConfigSuggestionSource['propose']>[0]) {
    if (request.scope !== this.scope) throw new ReferenceError('CONFLICT');
    const result = plannerResultSchema.parse(await this.planner.plan(this.input)); this.result = result;
    if (result.kind !== 'proposal') throw new AdviceOnly(result);
    if (!this.input.channel || result.proposal.channel !== this.input.channel || result.inputFingerprint !== plannerFingerprint(this.input)) throw new ReferenceError('CONFLICT');
    if (result.proposal.destination !== (request.scope === 'PA' ? 'pa' : 'fones')) throw new ReferenceError('CONFLICT');
    // D only supports level_delta drafts. This is explicitly an unfilled OPERATOR scaffold,
    // not a numeric recommendation or a claim that a level change solves the inspection.
    return AutoConfigProposal.parse({ schemaVersion: 1, items: [{
      id: `inspect-${result.proposal.id}`, operation: 'level_delta', channel: result.proposal.channel,
      rationale: 'Inspeção consultiva, não recomendação de alterar nível. Nenhum passo numérico foi sugerido. Só o operador decide se cabe um teste virtual e informa o valor no rascunho.',
      evidence: [
        { kind: 'human_report', text: `Relato classificado: ${result.proposal.evidence[0]!.symptom}; origem ${result.proposal.evidence[0]!.kind}; não é medição.` },
        { kind: 'theory', text: `${result.proposal.suggestions[0].candidate.purpose}. ${result.proposal.suggestions[0].candidate.procedureId} v${result.proposal.knowledgeVersion}. Sem causa acústica validada.` },
      ],
    }] });
  }
}

export interface AdvisorReadPort {
  serverId: string; mode(): string; active(p: Principal): boolean; connected(): boolean;
  stateRevision(): number; m1(p: Principal): { session: unknown; revision: number } | undefined;
  eventVersion(id: string): number | undefined;
  selectedProvider(): string;
  audit(p: Principal, result: { kind: string; provider?: string; outcome: string }): void;
}
/** Same provider-selection UI/endpoint, scoped to the authenticated operator, memory only.
 * Configuration/preference alone never creates an AutoConfig external grant. */
export class PlannerConsent {
  revision = 0;
  private grants = new Set<string>();
  selection(p: Principal, selected: string, confirmed: boolean) {
    this.revision++; this.grants.clear();
    if (selected === 'gemini' && confirmed) this.grants.add(p.id);
  }
  revoke(id: string) { if (this.grants.delete(id)) this.revision++; }
  allowed(p: Principal, selected: string) { return selected === 'gemini' && this.grants.has(p.id); }
  clear() { this.grants.clear(); this.revision++; }
}
interface Pending { input: PlannerInput; advice: PlannerResult; m1: string; scope?: 'PA' | 'AUX1'; eventId?: string; expiresAt: number }
export class AutoConfigAdvisor implements AutoConfigAdvisoryPort {
  private pending = new Map<string, Pending>();
  private busy = new Set<string>();
  private stopped = false;
  constructor(private loaded: LoadedConfig, private names: ChannelMap, private read: AdvisorReadPort,
    readonly consent = new PlannerConsent(), private options: { clock?: () => number; fetch?: typeof fetch; geminiFetch?: typeof fetch; timeoutMs?: number } = {}) {}
  private now() { return (this.options.clock ?? Date.now)(); }
  revoke(id: string) { this.pending.delete(id); this.consent.revoke(id); }
  stop() { this.stopped = true; this.pending.clear(); this.consent.clear(); }
  private guard(p: Principal) {
    if (this.stopped) throw new ReferenceError('DEPENDENCY_UNAVAILABLE');
    if (this.read.mode() !== 'lab') throw new ReferenceError('MODE_MISMATCH');
    if (!this.read.active(p)) throw new ReferenceError('UNAUTHORIZED');
    if (p.role !== 'operator') throw new ReferenceError('FORBIDDEN');
  }
  async suggest(p: Principal, raw: unknown): Promise<AutoConfigAdvice> {
    this.guard(p);
    const parsed = AdvisoryRequest.safeParse(raw); if (!parsed.success) throw new ReferenceError('INVALID');
    const request = parsed.data;
    if (request.serverId !== this.read.serverId) throw new ReferenceError('SERVER_CHANGED');
    if (this.busy.has(p.id)) throw new ReferenceError('CONFLICT');
    for (const [id, value] of this.pending) if (value.expiresAt <= this.now() || !this.read.active({ id, role: 'operator', label: 'operador' })) this.pending.delete(id);
    const eventVersion = request.eventId ? this.read.eventVersion(request.eventId) : undefined;
    if (request.eventId && eventVersion === undefined) throw new ReferenceError('INVALID');
    const m1 = this.read.m1(p);
    if (m1 && m1RequiresStop(m1.session)) throw new ReferenceError('CONFLICT');
    const m1key = m1 ? String(m1.revision) : 'absent';
    const existing = this.pending.get(p.id);
    // Without an explicit scope the M1 destination is reused; if nobody knows it, the planner asks.
    let input: PlannerInput = m1 ? plannerInputFromSession(m1.session, request.scope) : { mode: 'LAB' as const, ...(request.scope ? { destination: destinationOf(request.scope) } : {}) };
    if (request.scope && input.destination !== destinationOf(request.scope)) throw new ReferenceError('CONFLICT');
    const same = existing && existing.m1 === m1key && existing.scope === request.scope && existing.eventId === request.eventId;
    if (request.answer) {
      if (!same || existing.advice.kind !== 'question' || request.answer.inputFingerprint !== existing.advice.inputFingerprint) throw new ReferenceError('STALE_STATE');
      try { input = answerPlannerQuestion(existing.input, existing.advice, request.answer.value); } catch { throw new ReferenceError('INVALID'); }
    } else if (same) input = existing.input;
    if (!existing && this.pending.size >= 128) throw new ReferenceError('CAPACITY');
    const selected = () => this.read.selectedProvider();
    const revision = () => {
      const currentM1 = this.read.m1(p), event = request.eventId ? this.read.eventVersion(request.eventId) : undefined;
      return Number.parseInt(createHash('sha256').update(JSON.stringify([currentM1?.revision, event, this.read.stateRevision(), this.read.connected(), this.consent.revision, selected()])).digest('hex').slice(0, 12), 16);
    };
    const initialRevision = revision();
    const planner = createConfiguredPlanner(this.loaded, this.names, {
      allowDeterministicWithoutKnowledge: true, fetch: this.options.fetch, geminiFetch: this.options.geminiFetch, clock: this.options.clock, timeoutMs: this.options.timeoutMs,
      policy: () => ({ enabled: !this.stopped, active: this.read.active(p) && this.read.mode() === 'lab' && this.read.connected(), selected: selected(),
        externalConsent: this.consent.allowed(p, selected()), revision: revision() }),
    });
    // Placeholder scope only matters once the planner has a destination (it asks for it first).
    const scope = scopeOf(input.destination) ?? 'PA', selectedAtStart = selected();
    const source = new ConsultativeSuggestionSource(planner, input, scope);
    this.busy.add(p.id);
    try {
      let proposal: z.infer<typeof AutoConfigProposal> | null = null, advice: PlannerResult;
      try {
        proposal = await source.propose({ eventId: request.eventId, scope }); advice = source.result!;
      } catch (error) {
        if (!(error instanceof AdviceOnly)) throw error;
        advice = error.advice;
      }
      this.guard(p);
      if (revision() !== initialRevision || (request.eventId && this.read.eventVersion(request.eventId) !== eventVersion)) throw new ReferenceError('STALE_STATE');
      const used = advice.provider.used, k = this.loaded.config.knowledge;
      const model = { selected: selectedAtStart, used, external: used === 'gemini',
        name: used === 'ollama' ? k.ollama.chatModel : used === 'gemini' ? k.gemini.chatModel : null };
      const known = advisoryKnownField.options.filter(f => input[f] !== undefined);
      const response = AdvisoryResponse.parse({ serverId: this.read.serverId, advice, proposal, numericInput: 'operator_required', createsDraft: false,
        model, context: { fromDiagnosis: !!m1, known } });
      if (advice.kind === 'question') this.pending.set(p.id, { input, advice, m1: m1key, scope: request.scope, eventId: request.eventId, expiresAt: existing?.expiresAt ?? this.now() + 300_000 });
      else this.pending.delete(p.id);
      this.read.audit(p, { kind: advice.kind, provider: advice.provider.used, outcome: 'returned' });
      return response;
    } catch (error) {
      this.read.audit(p, { kind: 'refusal', outcome: 'discarded' }); throw error;
    } finally { this.busy.delete(p.id); }
  }
}
