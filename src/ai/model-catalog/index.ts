export * from './contracts.js';
export { ModelCatalogService, SessionModelConsent, type ModelCatalogOptions, type SessionConsentBackend } from './service.js';
export { OpenAITextClient } from './openai.js';
export { buildModelCatalog } from './factory.js';
export type ModelCompletion = Awaited<ReturnType<import('./service.js').ModelCatalogService['generate']>>;
export type ModelValidation = Awaited<ReturnType<import('./service.js').ModelCatalogService['validate']>>;
