import type { ProviderSettingsSnapshot } from '../app/ai-settings/provider-settings-port';
export function catalogFixture(): ProviderSettingsSnapshot {
  return { schemaVersion: 1, mode: 'LAB', revision: 0, selection: null, consent: { required: false, granted: false },
    usage: { day: '2026-11-10', requests: 2, inputTokens: 20, outputTokens: 10, costUSD: .004, reservedUSD: .001, blocked: false, paused: false },
    limits: { maxOutputTokens: 1024, maxInputBytes: 12000, unknownPricePolicy: 'block', dailyBudgetUSD: 3, maxRequestsPerMinute: 12 },
    providers: ['ollama','gemini','deepseek','anthropic','openai'].map(id => ({ id: id as ProviderSettingsSnapshot['providers'][number]['id'], enabled: id !== 'anthropic', configured: id !== 'deepseek', external: id !== 'ollama', acceptsCustomModelId: true,
      models: [{ id: 'fixture-model', price: id === 'ollama' ? null : { inputPerMTok: 1, outputPerMTok: 2 }, generationAllowed: id !== 'deepseek' && id !== 'anthropic' }] })) };
}
