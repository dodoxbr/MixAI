import { Injectable, inject } from '@angular/core';
import { SessionService } from '../core/session.service';
import { PROVIDERS, type ModelPrice, type ModelValidation, type ProviderChoice, type ProviderId, type ProviderSettingsPort, type ProviderSettingsSnapshot, validModelId } from './provider-settings-port';
export class ProviderSettingsError extends Error { constructor(readonly code: string) { super(code); } }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is ProviderId => PROVIDERS.includes(v as ProviderId);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const price = (v: unknown): v is ModelPrice | null => v === null || object(v) && number(v['inputPerMTok']) && v['inputPerMTok'] <= 1000 && number(v['outputPerMTok']) && v['outputPerMTok'] <= 1000;
function ensure(ok: unknown): asserts ok { if (!ok) throw new ProviderSettingsError('INVALID_RESPONSE'); }
export function catalogSnapshot(value: unknown): ProviderSettingsSnapshot {
  ensure(object(value)); const v = value;
  ensure(v['schemaVersion'] === 1 && v['mode'] === 'LAB' && integer(v['revision']));
  const providers = v['providers']; ensure(Array.isArray(providers) && providers.length <= 5);
  const seen = new Set<string>();
  for (const p of providers) {
    ensure(object(p) && id(p['id']) && !seen.has(p['id'])); seen.add(p['id']);
    ensure(typeof p['enabled'] === 'boolean' && typeof p['configured'] === 'boolean' && p['external'] === (p['id'] !== 'ollama') && p['acceptsCustomModelId'] === true);
    ensure(Array.isArray(p['models']) && p['models'].length <= 64);
    const models = new Set<string>();
    for (const m of p['models']) {
      ensure(object(m) && typeof m['id'] === 'string' && validModelId(p['id'], m['id']) && !models.has(m['id']) && price(m['price']) && typeof m['generationAllowed'] === 'boolean'); models.add(m['id']);
    }
  }
  const s = v['selection'], c = v['consent'], u = v['usage'], l = v['limits'];
  ensure(s === null || object(s) && id(s['provider']) && typeof s['model'] === 'string' && validModelId(s['provider'], s['model']) && s['revision'] === v['revision'] && s['validation'] === 'provider_confirmed' && s['external'] === (s['provider'] !== 'ollama') && seen.has(s['provider']));
  ensure(object(c) && typeof c['required'] === 'boolean' && typeof c['granted'] === 'boolean' && c['required'] === (object(s) && s['external'] === true) && (!c['granted'] || c['required']));
  ensure(object(u) && typeof u['day'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u['day']) && ['requests', 'inputTokens', 'outputTokens'].every(k => integer(u[k])) && number(u['costUSD']) && number(u['reservedUSD']) && typeof u['blocked'] === 'boolean' && typeof u['paused'] === 'boolean');
  ensure(object(l) && integer(l['maxOutputTokens']) && integer(l['maxInputBytes']) && l['unknownPricePolicy'] === 'block' && number(l['dailyBudgetUSD']) && integer(l['maxRequestsPerMinute']));
  // Return only public v1 fields; unknown extras, including error bodies, never reach the view.
  return { schemaVersion: 1, mode: 'LAB', revision: v['revision'], selection: s as ProviderSettingsSnapshot['selection'], consent: c as ProviderSettingsSnapshot['consent'], usage: { day: u['day'] as string, requests: u['requests'] as number, inputTokens: u['inputTokens'] as number, outputTokens: u['outputTokens'] as number, costUSD: u['costUSD'] as number, reservedUSD: u['reservedUSD'] as number, blocked: u['blocked'] as boolean, paused: u['paused'] as boolean }, limits: l as ProviderSettingsSnapshot['limits'], providers: providers as ProviderSettingsSnapshot['providers'] };
}
export function catalogValidation(value: unknown, choice: ProviderChoice): ModelValidation {
  ensure(object(value) && value['schemaVersion'] === 1 && value['provider'] === choice.provider && value['model'] === choice.model &&
    ['provider_confirmed', 'unavailable'].includes(value['validation'] as string) && price(value['price']) && typeof value['generationAllowed'] === 'boolean');
  return { schemaVersion: 1, provider: choice.provider, model: choice.model, validation: value['validation'] as ModelValidation['validation'], price: value['price'] as ModelPrice | null, generationAllowed: value['generationAllowed'] as boolean };
}
const CODES = new Set(['INVALID','FORBIDDEN','UNAUTHORIZED','DISABLED','NOT_CONFIGURED','NOT_CONSENTED','MODEL_UNAVAILABLE','PRICE_UNKNOWN','STALE','BUSY','RATE_LIMIT','BUDGET','UNAVAILABLE']);
@Injectable({ providedIn: 'root' })
export class CatalogProviderSettings implements ProviderSettingsPort {
  private readonly session = inject(SessionService);
  private async request(method: 'GET' | 'POST' | 'DELETE', suffix: string, signal: AbortSignal, body?: object): Promise<unknown> {
    const token = this.session.token(); if (!token) throw new ProviderSettingsError('UNAUTHORIZED');
    const response = await fetch('/api/ai/models' + suffix, { method, signal, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify({ schemaVersion: 1, ...body }) } : {}) });
    if (token !== this.session.token()) throw new ProviderSettingsError('SESSION_CHANGED');
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = response.status === 401 ? 'UNAUTHORIZED' : response.status === 404 ? 'UNSUPPORTED' : object(data) && data['schemaVersion'] === 1 && typeof data['code'] === 'string' && CODES.has(data['code']) ? data['code'] : 'UNAVAILABLE';
      throw new ProviderSettingsError(code);
    }
    return data;
  }
  async load(signal: AbortSignal) { return catalogSnapshot(await this.request('GET', '', signal)); }
  async validate(choice: ProviderChoice, signal: AbortSignal) { return catalogValidation(await this.request('POST', '/validate', signal, choice), choice); }
  async select(choice: ProviderChoice, revision: number, signal: AbortSignal) { return catalogSnapshot(await this.request('POST', '/selection', signal, { ...choice, expectedRevision: revision })); }
  async clear(revision: number, signal: AbortSignal) { return catalogSnapshot(await this.request('DELETE', '/selection', signal, { expectedRevision: revision })); }
}
