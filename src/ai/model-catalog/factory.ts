import { join } from 'node:path';
import { PROJECT_ROOT, type LoadedConfig } from '../../core/config.js';
import { externalUsageTracker } from '../../knowledge/local/external-providers.js';
import { OllamaClient } from '../../knowledge/local/ollama.js';
import { GeminiClient } from '../../knowledge/local/gemini.js';
import { DeepSeekClient } from '../../knowledge/local/deepseek.js';
import { AnthropicClient } from '../../knowledge/local/anthropic.js';
import { OpenAITextClient } from './openai.js';
import { ModelCatalogService, type ModelCatalogOptions } from './service.js';
import type { CatalogProviderDefinition, CatalogProviderId, CatalogTextProvider } from './contracts.js';

/** Keys remain closed over by server factories. No keys or configurable remote URLs in public contracts. */
export function buildModelCatalog(loaded: LoadedConfig, ports: Pick<ModelCatalogOptions, 'active' | 'mode' | 'audit' | 'consent'>,
  deps: { fetch?: typeof fetch; clock?: () => number } = {}): ModelCatalogService {
  const k = loaded.config.knowledge, config = loaded.config.modelCatalog, fetchFn = deps.fetch ?? fetch;
  const defaults = { ollama: { enabled: true, model: k.ollama.chatModel }, gemini: { enabled: k.gemini.enabled, model: k.gemini.chatModel },
    deepseek: { enabled: k.deepseek.enabled, model: k.deepseek.chatModel }, anthropic: { enabled: k.anthropic.enabled, model: k.anthropic.chatModel }, openai: { enabled: false, model: undefined } };
  const keys = { ollama: undefined, gemini: loaded.secrets?.geminiApiKey, deepseek: loaded.secrets?.deepseekApiKey, anthropic: loaded.secrets?.anthropicApiKey, openai: loaded.secrets?.openaiApiKey };
  const create = (id: CatalogProviderId, model: string): CatalogTextProvider => {
    const base = { chatModel: model, timeoutMs: config.timeoutMs, generateTimeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens };
    switch (id) {
      case 'ollama': return new OllamaClient({ ...k.ollama, ...base }, fetchFn, deps.clock);
      case 'gemini': return new GeminiClient({ ...k.gemini, ...base, embedDimensions: k.ollama.embedDimensions }, keys.gemini, fetchFn, deps.clock);
      case 'deepseek': return new DeepSeekClient(base, keys.deepseek, fetchFn, deps.clock);
      case 'anthropic': return new AnthropicClient(base, keys.anthropic, fetchFn, deps.clock);
      case 'openai': return new OpenAITextClient(model, keys.openai, config, fetchFn);
    }
  };
  const providers = (Object.keys(defaults) as CatalogProviderId[]).map(id => {
    const override = config.providers[id], fallback = defaults[id];
    return { id, external: id !== 'ollama', enabled: override?.enabled ?? fallback.enabled, configured: id === 'ollama' || !!keys[id],
      models: [...new Set(override?.models?.length ? override.models : fallback.model ? [fallback.model] : [])],
      price: (model: string) => id === 'ollama' ? undefined : override?.prices && Object.hasOwn(override.prices, model) ? override.prices[model] :
        (id === 'deepseek' || id === 'anthropic') && Object.hasOwn(k.external.prices, model) ? k.external.prices[model] : undefined,
      create: (model: string) => create(id, model),
    } satisfies CatalogProviderDefinition;
  });
  return new ModelCatalogService({ ...ports, config, providers,
    tracker: externalUsageTracker(join(loaded.dataDir ?? join(PROJECT_ROOT, 'data'), 'external-ai-usage.json'), deps.clock),
    dailyBudgetUSD: k.external.dailyBudgetUSD, maxRequestsPerMinute: k.external.maxRequestsPerMinute,
  });
}
