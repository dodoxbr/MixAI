import type { UsageTracker } from '../usage.js';
import type { GenerateResult } from '../../knowledge/local/provider.js';
import { ModelCatalogError, modelPriceSchema, validModel, type CatalogActor, type CatalogProviderDefinition, type CatalogProviderId, type CatalogTextProvider, type ConsentScope, type ModelCatalogConfig, type ModelCatalogView, type ModelConsentPort, type ModelSelection } from './contracts.js';

/** Structural compatibility with mission A's ExternalConsent; each backend instance MUST be private to one session. */
export interface SessionConsentBackend {
  selection(actor: CatalogActor & { label: string }, provider: string, confirmed: boolean): void;
  allowed(actor: CatalogActor & { label: string }, provider: string): boolean;
  revoke(id: string): void;
}
export class SessionModelConsent implements ModelConsentPort {
  private grants = new Map<string, { scope: ConsentScope; backend?: SessionConsentBackend }>();
  constructor(private readonly createBackend?: () => SessionConsentBackend) {}
  grant(actor: CatalogActor, scope: ConsentScope) {
    this.revoke(actor);
    const backend = this.createBackend?.();
    backend?.selection({ ...actor, label: 'Operador catálogo' }, scope.provider, true);
    this.grants.set(actor.id, { scope: { ...scope }, backend });
  }
  allowed(actor: CatalogActor, scope: ConsentScope) {
    const grant = this.grants.get(actor.id);
    return !!grant && grant.scope.provider === scope.provider && grant.scope.model === scope.model && grant.scope.revision === scope.revision &&
      (!grant.backend || grant.backend.allowed({ ...actor, label: 'Operador catálogo' }, scope.provider));
  }
  revoke(actor: CatalogActor) { const grant = this.grants.get(actor.id); this.grants.delete(actor.id); grant?.backend?.revoke(actor.id); }
}
interface SessionState { revision: number; selection?: ModelSelection; client?: CatalogTextProvider }
export interface ModelCatalogOptions {
  config: ModelCatalogConfig; providers: CatalogProviderDefinition[]; tracker: UsageTracker;
  dailyBudgetUSD: number; maxRequestsPerMinute: number; mode(): string; active(actor: CatalogActor): boolean;
  consent?: ModelConsentPort;
  audit?(event: { provider: CatalogProviderId; model: string; responseModel: string; outcome: string; inputTokens?: number; outputTokens?: number; estimatedUSD?: number }): void;
}
/** Isolated catalog generation lane. Does not mutate the legacy global knowledge selection or AutoConfig. */
export class ModelCatalogService {
  private sessions = new Map<string, SessionState>();
  private selecting = new Set<string>();
  private generating = new Set<string>();
  private validating = new Set<string>();
  private stopped = false;
  private consent: ModelConsentPort;
  constructor(private readonly o: ModelCatalogOptions) { this.consent = o.consent ?? new SessionModelConsent(); }
  private guard(actor: CatalogActor) {
    if (!this.o.active(actor)) throw new ModelCatalogError('UNAUTHORIZED');
    if (actor.role !== 'operator' || this.o.mode() !== 'lab') throw new ModelCatalogError('FORBIDDEN');
    if (this.stopped || !this.o.config.enabled) throw new ModelCatalogError('DISABLED');
  }
  private definition(id: CatalogProviderId) {
    const provider = this.o.providers.find(p => p.id === id);
    if (!provider?.enabled) throw new ModelCatalogError('DISABLED');
    if (!provider.configured) throw new ModelCatalogError('NOT_CONFIGURED');
    return provider;
  }
  private priceFor(provider: CatalogProviderDefinition, model: string) {
    if (!provider.external) return undefined;
    const price = modelPriceSchema.safeParse(provider.price(model));
    return price.success ? price.data : undefined;
  }
  private checkRevision(actor: CatalogActor, expected: number) {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new ModelCatalogError('INVALID');
    if ((this.sessions.get(actor.id)?.revision ?? 0) !== expected) throw new ModelCatalogError('STALE');
  }
  private async deadline<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), this.o.config.timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  view(actor: CatalogActor): ModelCatalogView {
    this.guard(actor); const state = this.sessions.get(actor.id);
    return { schemaVersion: 1, mode: 'LAB', revision: state?.revision ?? 0, selection: state?.selection ? { ...state.selection } : null,
      consent: { required: state?.selection?.external ?? false, granted: !!state?.selection?.external && this.consent.allowed(actor, state.selection) }, usage: this.o.tracker.current(),
      providers: this.o.providers.map(p => ({ id: p.id, enabled: p.enabled, configured: p.configured, external: p.external, acceptsCustomModelId: true,
        models: p.models.map(id => ({ id, price: this.priceFor(p, id) ?? null, generationAllowed: p.enabled && p.configured && (!p.external || !!this.priceFor(p, id)) })) })),
      limits: { maxOutputTokens: this.o.config.maxOutputTokens, maxInputBytes: this.o.config.maxInputBytes, unknownPricePolicy: 'block', dailyBudgetUSD: this.o.dailyBudgetUSD, maxRequestsPerMinute: this.o.maxRequestsPerMinute } };
  }
  async validate(actor: CatalogActor, provider: CatalogProviderId, model: string, confirmed = false) {
    this.guard(actor); if (!validModel(provider, model)) throw new ModelCatalogError('INVALID');
    const definition = this.definition(provider);
    if (definition.external && !confirmed) throw new ModelCatalogError('NOT_CONSENTED');
    if (!this.o.tracker.takeSlot(this.o.maxRequestsPerMinute)) throw new ModelCatalogError('RATE_LIMIT');
    if (this.validating.has(actor.id) || this.validating.size >= 8) throw new ModelCatalogError('BUSY');
    this.validating.add(actor.id);
    try {
      const health = await this.deadline(definition.create(model).health(true), { reachable: false, embedModel: false, chatModel: false, detail: 'TIMEOUT' });
      this.guard(actor);
      return { schemaVersion: 1 as const, provider, model, validation: health.reachable && health.chatModel ? 'provider_confirmed' as const : 'unavailable' as const,
        price: this.priceFor(definition, model) ?? null, generationAllowed: (!definition.external || !!this.priceFor(definition, model)) && health.reachable && health.chatModel };
    } finally { this.validating.delete(actor.id); }
  }
  async select(actor: CatalogActor, input: { provider: CatalogProviderId; model: string; expectedRevision: number; confirmExternal?: boolean }) {
    this.guard(actor); this.checkRevision(actor, input.expectedRevision);
    if (this.selecting.has(actor.id)) throw new ModelCatalogError('BUSY');
    if (!this.sessions.has(actor.id) && this.sessions.size >= 128) throw new ModelCatalogError('BUSY');
    this.selecting.add(actor.id);
    try {
      const result = await this.validate(actor, input.provider, input.model, input.confirmExternal === true);
      this.checkRevision(actor, input.expectedRevision);
      if (result.validation !== 'provider_confirmed') throw new ModelCatalogError('MODEL_UNAVAILABLE');
      if (!this.sessions.has(actor.id) && this.sessions.size >= 128) throw new ModelCatalogError('BUSY');
      const definition = this.definition(input.provider);
      const selection: ModelSelection = { provider: input.provider, model: input.model, revision: input.expectedRevision + 1, validation: 'provider_confirmed', external: definition.external };
      // Only this actor/model gains consent. Selecting another model revokes this actor's previous grant.
      this.consent.revoke(actor);
      if (definition.external) this.consent.grant(actor, selection);
      this.sessions.set(actor.id, { revision: selection.revision, selection, client: definition.create(input.model) });
      return this.view(actor);
    } finally { this.selecting.delete(actor.id); }
  }
  clear(actor: CatalogActor, expectedRevision: number) {
    this.guard(actor); this.checkRevision(actor, expectedRevision);
    if (!this.sessions.has(actor.id) && this.sessions.size >= 128) throw new ModelCatalogError('BUSY');
    this.consent.revoke(actor); this.sessions.set(actor.id, { revision: expectedRevision + 1 });
    return this.view(actor);
  }
  revoke(id: string) { this.consent.revoke({ id, role: 'operator' }); this.sessions.delete(id); }
  stop() { this.stopped = true; for (const id of this.sessions.keys()) this.revoke(id); }
  /** Trusted backend port for mission A. No tools or model-driven execution. Revision is checked before AND after await. */
  async generate(actor: CatalogActor, system: string, user: string, expectedRevision: number) {
    this.guard(actor); this.checkRevision(actor, expectedRevision);
    if (typeof system !== 'string' || typeof user !== 'string' || !user.trim() || Buffer.byteLength(system + user, 'utf8') > this.o.config.maxInputBytes) throw new ModelCatalogError('INVALID');
    const state = this.sessions.get(actor.id), selection = state?.selection, client = state?.client;
    if (!selection || !client) throw new ModelCatalogError('NOT_CONFIGURED');
    if (selection.external && !this.consent.allowed(actor, selection)) throw new ModelCatalogError('NOT_CONSENTED');
    if (this.generating.has(actor.id) || this.generating.size >= 8) throw new ModelCatalogError('BUSY');
    const definition = this.definition(selection.provider), price = this.priceFor(definition, selection.model);
    if (selection.external && !price) throw new ModelCatalogError('PRICE_UNKNOWN');
    if (!this.o.tracker.takeSlot(this.o.maxRequestsPerMinute)) throw new ModelCatalogError('RATE_LIMIT');
    const cost = (a: number, b: number) => price ? (a * price.inputPerMTok + b * price.outputPerMTok) / 1e6 : 0;
    // UTF-8 bytes + message envelope allowance is a conservative input estimate, not a billing guarantee.
    const reserved = this.o.tracker.reserve(cost(Buffer.byteLength(system + user) + 1024, this.o.config.maxOutputTokens), this.o.dailyBudgetUSD);
    if (!reserved.ok) throw new ModelCatalogError('BUDGET');
    this.generating.add(actor.id);
    try {
      let result: GenerateResult;
      try { result = await this.deadline(client.generateDetailed(system, user), { failure: 'timeout' } as GenerateResult); } catch { result = { failure: 'unavailable' }; }
      if (result.text && result.text.length > 64000) result = { ...result, text: undefined, failure: 'truncated' };
      const usage = result.usage;
      const validUsage = usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0;
      let estimatedUSD: number;
      if (validUsage) { estimatedUSD = cost(usage.inputTokens, usage.outputTokens); this.o.tracker.settle(reserved.id, usage.inputTokens, usage.outputTokens, estimatedUSD); }
      else if (result.failure === 'auth' || result.failure === 'quota') { estimatedUSD = 0; this.o.tracker.release(reserved.id); }
      else estimatedUSD = this.o.tracker.chargeReserved(reserved.id);
      const responseModel = result.model && validModel(selection.provider, result.model) ? result.model : selection.model;
      this.o.audit?.({ provider: selection.provider, model: selection.model, responseModel, outcome: result.failure ?? 'success', ...(validUsage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}), estimatedUSD });
      this.guard(actor);
      if (this.sessions.get(actor.id) !== state || (selection.external && !this.consent.allowed(actor, selection))) throw new ModelCatalogError('STALE');
      return { schemaVersion: 1 as const, mode: 'LAB' as const, selection: { ...selection }, result: { model: responseModel, ...(result.text && !result.failure ? { text: result.text } : {}), ...(result.failure ? { failure: result.failure } : {}), ...(result.reason ? { reason: result.reason } : {}), ...(validUsage ? { usage } : {}) },
        cost: { status: price ? 'configured_estimate' as const : 'local_no_api_charge' as const, priceModel: selection.model, estimatedUSD, usageReported: !!validUsage }, execution: 'not_executable' as const };
    } finally { this.generating.delete(actor.id); }
  }
}
