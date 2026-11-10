import { InjectionToken } from '@angular/core';

// Wire-only mirror: backend contracts transitively reference Node fs/path through UsageTracker.
// test/catalog-ui-contract.test.ts checks exact structural compatibility without shipping Node code.
export type ProviderId = 'ollama' | 'gemini' | 'deepseek' | 'anthropic' | 'openai';
export interface ModelPrice { inputPerMTok: number; outputPerMTok: number }
export interface ProviderSettingsSnapshot {
  schemaVersion: 1; mode: 'LAB'; revision: number;
  selection: { provider: ProviderId; model: string; revision: number; validation: 'provider_confirmed'; external: boolean } | null;
  consent: { required: boolean; granted: boolean };
  usage: { day: string; requests: number; inputTokens: number; outputTokens: number; costUSD: number; reservedUSD: number; blocked: boolean; paused: boolean };
  providers: Array<{ id: ProviderId; enabled: boolean; configured: boolean; external: boolean; acceptsCustomModelId: true;
    models: Array<{ id: string; price: ModelPrice | null; generationAllowed: boolean }> }>;
  limits: { maxOutputTokens: number; maxInputBytes: number; unknownPricePolicy: 'block'; dailyBudgetUSD: number; maxRequestsPerMinute: number };
}
export const PROVIDERS = ['ollama', 'gemini', 'deepseek', 'anthropic', 'openai'] as const;
export const PROVIDER_LABELS: Record<ProviderId, string> = { ollama: 'Ollama', gemini: 'Gemini', deepseek: 'DeepSeek', anthropic: 'Anthropic', openai: 'OpenAI' };
export interface ModelValidation {
  schemaVersion: 1; provider: ProviderId; model: string;
  validation: 'provider_confirmed' | 'unavailable'; price: ModelPrice | null; generationAllowed: boolean;
}
export interface ProviderChoice { provider: ProviderId; model: string; confirmExternal: boolean }
export interface ProviderSettingsPort {
  load(signal: AbortSignal): Promise<ProviderSettingsSnapshot>;
  validate(choice: ProviderChoice, signal: AbortSignal): Promise<ModelValidation>;
  select(choice: ProviderChoice, revision: number, signal: AbortSignal): Promise<ProviderSettingsSnapshot>;
  clear(revision: number, signal: AbortSignal): Promise<ProviderSettingsSnapshot>;
}
export const PROVIDER_SETTINGS_PORT = new InjectionToken<ProviderSettingsPort>('ProviderSettingsPort');
/** Mirrors validModel v1. Availability and consent remain server decisions. */
export function validModelId(provider: ProviderId, model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) && !model.includes('..') && !model.includes('//') && !model.includes('://') &&
    (provider === 'ollama' || /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(model));
}
