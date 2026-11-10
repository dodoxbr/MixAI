import { Injectable, inject } from '@angular/core';
import { SessionService } from '../core/session.service';
import { PROVIDERS, type ProviderChoice, type ProviderId, type ProviderOption, type ProviderSettingsPort, type ProviderSettingsSnapshot } from './provider-settings-port';

export class ProviderSettingsError extends Error {
  constructor(readonly code: string) { super(code); }
}
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const providerId = (v: unknown): v is ProviderId => PROVIDERS.includes(v as ProviderId);
const modelId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(v);

/** Strict conversion of the CURRENT /api/knowledge/providers response. No guessed health/cost. */
export function legacySnapshot(value: unknown): ProviderSettingsSnapshot {
  const root = object(value), chat = object(root?.['chat']);
  if (!root || !chat || !providerId(chat['selected']) || !Array.isArray(chat['options']) || typeof root['narrative'] !== 'boolean') throw new ProviderSettingsError('INVALID_RESPONSE');
  const raw = chat['options'];
  if (raw.length > 5) throw new ProviderSettingsError('INVALID_RESPONSE');
  const entries = new Map<ProviderId, ProviderOption>();
  for (const item of raw) {
    const p = object(item);
    if (!p || !providerId(p['id']) || p['id'] === 'openai' || typeof p['configured'] !== 'boolean' ||
      p['external'] !== (p['id'] !== 'ollama') || entries.has(p['id'])) throw new ProviderSettingsError('INVALID_RESPONSE');
    if (p['model'] !== undefined && !modelId(p['model'])) throw new ProviderSettingsError('INVALID_RESPONSE');
    const list = p['models'];
    if (list !== undefined && (!Array.isArray(list) || list.length > 100 || !list.every(modelId) || new Set(list).size !== list.length)) throw new ProviderSettingsError('INVALID_RESPONSE');
    const models = (list ?? []) as string[];
    entries.set(p['id'], {
      id: p['id'], external: p['external'] as boolean,
      status: p['configured'] ? 'configured' : 'not_configured', selectable: p['configured'],
      model: p['model'] as string | undefined ?? null, models,
      modelMode: models.length ? 'list' : 'server_only', price: null,
    });
  }
  if (!entries.has(chat['selected'])) throw new ProviderSettingsError('INVALID_RESPONSE');
  return {
    options: PROVIDERS.map(id => entries.get(id) ?? { id, external: id !== 'ollama', status: 'unavailable', selectable: false, model: null, models: [], modelMode: 'server_only', price: null }),
    active: { provider: chat['selected'], model: entries.get(chat['selected'])!.model },
    narrative: root['narrative'], fallback: root['externalFallback'] === 'ollama' || root['externalFallback'] === 'none' ? root['externalFallback'] : null,
    budget: null, consumed: null, sessionConsent: 'legacy_gemini',
  };
}

@Injectable({ providedIn: 'root' })
export class LegacyProviderSettings implements ProviderSettingsPort {
  private readonly session = inject(SessionService);
  private async request(method: 'GET' | 'POST', signal: AbortSignal, choice?: ProviderChoice): Promise<ProviderSettingsSnapshot> {
    const token = this.session.token();
    if (!token) throw new ProviderSettingsError('UNAUTHORIZED');
    if (choice && (choice.provider === 'openai' || choice.model !== undefined && !modelId(choice.model))) throw new ProviderSettingsError('UNSUPPORTED');
    const res = await fetch('/api/knowledge/providers', {
      method, signal, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(choice ? { 'content-type': 'application/json' } : {}) },
      ...(choice ? { body: JSON.stringify({ chat: choice.provider, ...(choice.confirmExternal ? { confirmExternal: true } : {}), ...(choice.model ? { model: choice.model } : {}) }) } : {}),
    });
    if (token !== this.session.token()) throw new ProviderSettingsError('STALE');
    if (!res.ok) throw new ProviderSettingsError(({ 400: 'INVALID', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'UNSUPPORTED', 409: 'BUSY', 429: 'QUOTA' } as Record<number, string>)[res.status] ?? 'UNAVAILABLE');
    return legacySnapshot(await res.json()); // never render raw error messages/credentials
  }
  load(signal: AbortSignal) { return this.request('GET', signal); }
  select(choice: ProviderChoice, signal: AbortSignal) { return this.request('POST', signal, choice); }
}
