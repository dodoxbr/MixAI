import type { LoadedConfig } from '../../core/config.js';
import type { ChannelMap } from '../../core/channels.js';
import type { MicPack } from '../../knowledge/local/pack.js';
import { GeminiClient } from '../../knowledge/local/gemini.js';
import { OllamaClient } from '../../knowledge/local/ollama.js';
import type { AiProvider } from '../../knowledge/local/provider.js';
import type { PlannerObservationPort, PlannerPolicy, PlannerProvider } from './contracts.js';
import { bandKnowledgeAdapter } from './kb-adapter.js';
import { TechnicalPlanner } from './engine.js';

/** Narrow existing provider to text generation only; never pass health/embed/tools to the planner. */
export function textProviderAdapter(provider: AiProvider): PlannerProvider {
  return { id: provider.id, external: provider.external, generate: async (system, user) => { const r = await provider.generateDetailed(system, user); return { ...(r.text !== undefined ? { text: r.text } : {}), ...(r.failure ? { failure: r.failure } : {}), ...(r.model ? { model: r.model } : provider.model ? { model: provider.model } : {}) }; } };
}
function loopback(url: string) {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
/** No config/secret discovery, preference writes, model installation or automatic start.
 * D supplies current selection/consent from its authenticated existing provider flow, not request JSON.
 * Configuration alone NEVER manufactures consent. Qwen3 is used when it is the configured Ollama model.
 */
export function createConfiguredPlanner(loaded: LoadedConfig, names: ChannelMap, deps: {
  policy(): PlannerPolicy; observations?: PlannerObservationPort; microphones?: MicPack; allowDeterministicWithoutKnowledge?: boolean;
  fetch?: typeof fetch; geminiFetch?: typeof fetch; clock?: () => number; timeoutMs?: number;
  /** DeepSeek/Anthropic já construídos pela base de conhecimento (com controle de custo e o modelo escolhido pelo operador). */
  externalProviders?: readonly AiProvider[];
}) {
  const k = loaded.config.knowledge, providers: PlannerProvider[] = [];
  if (k.enabled && k.ollama.narrative) {
    if (loopback(k.ollama.url)) providers.push(textProviderAdapter(new OllamaClient({ ...k.ollama, generateTimeoutMs: k.ollama.narrativeTimeoutMs }, deps.fetch ?? fetch, deps.clock)));
    if (k.gemini.enabled) providers.push(textProviderAdapter(new GeminiClient({ ...k.gemini, generateTimeoutMs: k.gemini.narrativeTimeoutMs }, loaded.secrets?.geminiApiKey, deps.geminiFetch ?? fetch, deps.clock)));
  }
  if (k.enabled && k.ollama.narrative) for (const p of deps.externalProviders ?? []) providers.push(textProviderAdapter(p));
  return new TechnicalPlanner({ knowledge: bandKnowledgeAdapter(names, deps.microphones), providers, fallbackToLocal: k.external.fallback === 'ollama', observations: deps.observations, clock: deps.clock, timeoutMs: deps.timeoutMs,
    policy: () => { const p = deps.policy(); return { ...p, enabled: (k.enabled || !!deps.allowDeterministicWithoutKnowledge) && loaded.config.mixer.mode === 'lab' && p.enabled }; } });
}
