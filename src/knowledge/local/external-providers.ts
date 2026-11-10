import { join, resolve } from 'node:path';
import { UsageTracker } from '../../ai/usage.js';
import type { LoadedConfig } from '../../core/config.js';
import { PROJECT_ROOT } from '../../core/config.js';
import { AnthropicClient } from './anthropic.js';
import { PricedProvider } from './priced-provider.js';
import { DeepSeekClient } from './deepseek.js';
import type { AiProvider } from './provider.js';

const trackers = new Map<string, UsageTracker>();
/** Um único registro de consumo por arquivo: base de conhecimento e planejador dividem o mesmo teto diário. */
export function externalUsageTracker(file: string, clock?: () => number): UsageTracker {
  const key = resolve(file);
  let t = trackers.get(key);
  if (!t) { t = new UsageTracker(key, clock); trackers.set(key, t); }
  return t;
}

/**
 * DeepSeek e Anthropic como provedores de TEXTO, só quando habilitados na configuração. Cada um vem dentro do controle de custo
 * (teto diário estimado, limite por minuto, preço por modelo). A configuração sozinha NUNCA cria consentimento de envio.
 * Chaves: deepseekApiKey / anthropicApiKey (config/secrets.yaml ou ambiente); nunca saem daqui.
 */
export function buildExternalProviders(loaded: LoadedConfig, deps: { fetch?: typeof fetch; clock?: () => number; log?: (msg: string) => void; dataDir?: string } = {}): AiProvider[] {
  const k = loaded.config.knowledge, e = k.external;
  const tracker = externalUsageTracker(join(deps.dataDir ?? loaded.dataDir ?? join(PROJECT_ROOT, 'data'), 'external-ai-usage.json'), deps.clock);
  const wrap = (inner: AiProvider, maxOutputTokens: number): AiProvider => new PricedProvider(inner, {
    tracker, dailyBudgetUSD: e.dailyBudgetUSD, maxRequestsPerMinute: e.maxRequestsPerMinute, maxOutputTokens, log: deps.log,
    price: (model) => e.prices[model],
  }, model => Object.hasOwn(e.prices, model) && [e.prices[model].inputPerMTok, e.prices[model].outputPerMTok].every(n => Number.isFinite(n) && n >= 0));
  const out: AiProvider[] = [];
  if (k.deepseek.enabled) out.push(wrap(new DeepSeekClient({ chatModel: k.deepseek.chatModel, timeoutMs: k.deepseek.timeoutMs, generateTimeoutMs: k.deepseek.narrativeTimeoutMs, maxOutputTokens: k.deepseek.maxOutputTokens, thinking: k.deepseek.thinking }, loaded.secrets?.deepseekApiKey, deps.fetch ?? fetch, deps.clock), k.deepseek.maxOutputTokens));
  if (k.anthropic.enabled) out.push(wrap(new AnthropicClient({ chatModel: k.anthropic.chatModel, timeoutMs: k.anthropic.timeoutMs, generateTimeoutMs: k.anthropic.narrativeTimeoutMs, maxOutputTokens: k.anthropic.maxOutputTokens }, loaded.secrets?.anthropicApiKey, deps.fetch ?? fetch, deps.clock), k.anthropic.maxOutputTokens));
  return out;
}
