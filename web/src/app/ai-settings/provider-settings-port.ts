import { InjectionToken } from '@angular/core';

export const PROVIDERS = ['ollama', 'gemini', 'deepseek', 'anthropic', 'openai'] as const;
export type ProviderId = typeof PROVIDERS[number];
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama', gemini: 'Gemini', deepseek: 'DeepSeek', anthropic: 'Anthropic', openai: 'OpenAI',
};
export interface BackendAmount {
  value: number;
  currency: 'USD';
  asOf: string;
  source: 'backend';
}
export interface ProviderOption {
  id: ProviderId;
  external: boolean;
  status: 'configured' | 'not_configured' | 'unavailable' | 'connected';
  selectable: boolean;
  model: string | null;
  models: readonly string[];
  modelMode: 'list' | 'manual' | 'server_only';
  price: { model: string; inputPerMillion: BackendAmount; outputPerMillion: BackendAmount } | null;
}
/** Frontend view contract, NOT a proposed HTTP schema for agent B. */
export interface ProviderSettingsSnapshot {
  options: readonly ProviderOption[];
  active: { provider: ProviderId; model: string | null };
  narrative: boolean;
  fallback: 'ollama' | 'none' | null;
  budget: BackendAmount | null;
  consumed: BackendAmount | null;
  sessionConsent: 'server_enforced' | 'legacy_gemini';
}
export interface ProviderChoice { provider: ProviderId; model?: string; confirmExternal: boolean }
/** Only this boundary is replaced after the actual B contract is reviewed. */
export interface ProviderSettingsPort {
  load(signal: AbortSignal): Promise<ProviderSettingsSnapshot>;
  select(choice: ProviderChoice, signal: AbortSignal): Promise<ProviderSettingsSnapshot>;
}
export const PROVIDER_SETTINGS_PORT = new InjectionToken<ProviderSettingsPort>('ProviderSettingsPort');
export const validModelId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value);
export function trustedAmount(value: BackendAmount | null): BackendAmount | null {
  return value?.source === 'backend' && value.currency === 'USD' && Number.isFinite(value.value) && value.value >= 0 &&
    Number.isFinite(Date.parse(value.asOf)) ? value : null;
}
