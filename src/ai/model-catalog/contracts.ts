import { z } from 'zod';
import type { AiProvider } from '../../knowledge/local/provider.js';
import type { UsageTracker } from '../usage.js';
export const catalogProviderSchema = z.enum(['ollama', 'gemini', 'deepseek', 'anthropic', 'openai']);
export type CatalogProviderId = z.infer<typeof catalogProviderSchema>;
export const modelIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(s => !s.includes('..') && !s.includes('//') && !s.includes('://'));
export function validModel(provider: CatalogProviderId, model: string): boolean {
  return modelIdSchema.safeParse(model).success && (provider === 'ollama' || (model.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(model)));
}
export const modelPriceSchema = z.strictObject({ inputPerMTok: z.number().finite().min(0).max(1000), outputPerMTok: z.number().finite().min(0).max(1000) });
export type CatalogPrice = z.infer<typeof modelPriceSchema>;
export const modelCatalogConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  maxOutputTokens: z.number().int().min(64).max(8192).default(1024),
  timeoutMs: z.number().int().min(1000).max(180000).default(30000),
  maxInputBytes: z.number().int().min(256).max(64000).default(12000),
  unknownPricePolicy: z.literal('block').default('block'),
  providers: z.partialRecord(catalogProviderSchema, z.strictObject({ enabled: z.boolean(), models: z.array(modelIdSchema).max(64).default([]),
    prices: z.record(modelIdSchema, modelPriceSchema).default({}) }).partial()).default({}),
}).superRefine((config, ctx) => {
  for (const [provider, settings] of Object.entries(config.providers)) {
    for (const model of [...(settings?.models ?? []), ...Object.keys(settings?.prices ?? {})]) {
      if (!validModel(provider as CatalogProviderId, model)) ctx.addIssue({ code: 'custom', path: ['providers', provider], message: 'INVALID_MODEL_FORMAT' });
    }
  }
});
export type ModelCatalogConfig = z.infer<typeof modelCatalogConfigSchema>;
export interface CatalogActor { id: string; role: string }
export interface ConsentScope { provider: CatalogProviderId; model: string; revision: number }
/** Adapter for mission A. Grants must be session/model-bound, ephemeral and revocable. */
export interface ModelConsentPort {
  grant(actor: CatalogActor, scope: ConsentScope): void;
  allowed(actor: CatalogActor, scope: ConsentScope): boolean;
  revoke(actor: CatalogActor): void;
}
export type CatalogTextProvider = Omit<AiProvider, 'id'> & { readonly id: CatalogProviderId };
export interface CatalogProviderDefinition {
  id: CatalogProviderId; external: boolean; enabled: boolean; configured: boolean; models: readonly string[];
  price(model: string): CatalogPrice | undefined;
  /** Must create an independent, immutable-for-request instance; never selectModel on shared clients. */
  create(model: string): CatalogTextProvider;
}
export const selectionRequestSchema = z.strictObject({ schemaVersion: z.literal(1), provider: catalogProviderSchema, model: modelIdSchema,
  expectedRevision: z.number().int().nonnegative(), confirmExternal: z.boolean().optional() }).refine(v => validModel(v.provider, v.model));
export const validationRequestSchema = z.strictObject({ schemaVersion: z.literal(1), provider: catalogProviderSchema, model: modelIdSchema,
  confirmExternal: z.boolean().optional() }).refine(v => validModel(v.provider, v.model));
export const completionRequestSchema = z.strictObject({ schemaVersion: z.literal(1), expectedRevision: z.number().int().nonnegative(), text: z.string().min(1).max(16000) });
export interface ModelSelection extends ConsentScope { validation: 'provider_confirmed'; external: boolean }
export interface ModelCatalogView {
  schemaVersion: 1; mode: 'LAB'; revision: number; selection: ModelSelection | null;
  consent: { required: boolean; granted: boolean };
  usage: ReturnType<UsageTracker['current']>;
  providers: Array<{ id: CatalogProviderId; enabled: boolean; configured: boolean; external: boolean; acceptsCustomModelId: true;
    models: Array<{ id: string; price: CatalogPrice | null; generationAllowed: boolean }> }>;
  limits: { maxOutputTokens: number; maxInputBytes: number; unknownPricePolicy: 'block'; dailyBudgetUSD: number; maxRequestsPerMinute: number };
}
export type CatalogErrorCode = 'INVALID' | 'FORBIDDEN' | 'UNAUTHORIZED' | 'DISABLED' | 'NOT_CONFIGURED' | 'NOT_CONSENTED' | 'MODEL_UNAVAILABLE' | 'PRICE_UNKNOWN' | 'STALE' | 'BUSY' | 'RATE_LIMIT' | 'BUDGET' | 'UNAVAILABLE';
export class ModelCatalogError extends Error { constructor(readonly code: CatalogErrorCode) { super(code); this.name = 'ModelCatalogError'; } }
export type ModelSelectionRequest = z.input<typeof selectionRequestSchema>;
export type ModelValidationRequest = z.input<typeof validationRequestSchema>;
export type ModelCompletionRequest = z.input<typeof completionRequestSchema>;
