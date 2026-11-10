import type { GenerateResult } from './provider.js';

/** Helpers dos provedores EXTERNOS (DeepSeek, Anthropic). Só códigos de motivo: nunca o corpo do erro, a chave nem o conteúdo. */
export const MAX_BODY = 4 * 1024 * 1024;
export const HEALTH_TTL_MS = 60_000;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;

export class HttpFailure extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** Código HTTP → falha. 402 = saldo esgotado (DeepSeek); 429 = limite; 5xx/529 = indisponível. */
export function failureForStatus(status: number): GenerateResult {
  if (status === 401 || status === 403) return { failure: 'auth' };
  if (status === 402) return { failure: 'quota', reason: 'insufficient_balance' };
  if (status === 429) return { failure: 'quota' };
  if (status === 408 || status >= 500) return { failure: 'unavailable' };
  return { failure: 'error' };
}

export function failureOfError(e: unknown): GenerateResult {
  if (e instanceof HttpFailure) return failureForStatus(e.status);
  return { failure: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unavailable' };
}

/** GET/POST JSON com endereço fixo, sem redirecionamento, sem cookies e com prazo. */
export async function callJson(fetchFn: typeof fetch, url: URL, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown }, timeoutMs: number): Promise<unknown> {
  const res = await fetchFn(url, {
    method: init.method,
    headers: { ...init.headers, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    credentials: 'omit',
  });
  if (!res.ok) throw new HttpFailure(res.status);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('resposta grande demais');
  return JSON.parse(text);
}

export const tokenCount = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
