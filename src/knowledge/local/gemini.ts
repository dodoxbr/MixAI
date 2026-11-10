import { tokenCount } from './external.js';
import type { AiProvider, GenerateFailure, GenerateResult, ProviderHealth } from './provider.js';

/** Endereço FIXO da API: não é configurável, para que a chave e os textos só possam ir para o Google. */
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const MAX_BODY = 4 * 1024 * 1024;
const BATCH = 50;
const HEALTH_TTL_MS = 60_000;

export interface GeminiOptions {
  chatModel: string;
  embedModel: string;
  embedDimensions: number;
  timeoutMs: number;
  generateTimeoutMs?: number;
  /** Teto de tokens da resposta, contando o raciocínio dos modelos Gemini 3 (padrão 2048). */
  maxOutputTokens?: number;
  /** "default" = não enviar. Padrão "low". */
  thinkingLevel?: 'default' | 'minimal' | 'low' | 'medium' | 'high';
}

class HttpFailure extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** finishReason que representam bloqueio de segurança/política do provedor. */
const SAFETY_FINISH: ReadonlySet<string> = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

const failureFor =(status: number): GenerateFailure =>
  status === 401 || status === 403 ? 'auth' : status === 429 ? 'quota' : 'error';

/**
 * Cliente mínimo do Gemini (Google AI Studio). A chave vai SOMENTE no cabeçalho `x-goog-api-key`:
 * nunca na URL, em mensagem de erro, em log ou em resposta da API do MixAI. Falha sempre de forma
 * contida (undefined / código de motivo): o chamador cai para o Ollama local e, por fim, para o
 * motor determinístico. Corpo de resposta de erro nunca é lido para fora desta classe.
 */
export class GeminiClient implements AiProvider {
  readonly id = 'gemini' as const;
  readonly external = true;
  private cache?: { at: number; value: ProviderHealth };

  constructor(
    private readonly o: GeminiOptions,
    private readonly apiKey: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    for (const m of [o.chatModel, o.embedModel]) if (!MODEL_RE.test(m)) throw new Error('Nome de modelo Gemini inválido.');
  }

  get configured(): boolean { return !!this.apiKey; }

  private async call(path: string, body?: unknown, timeoutMs: number = this.o.timeoutMs): Promise<unknown> {
    if (!this.apiKey) throw new HttpFailure(401);
    const res = await this.fetchFn(new URL(path, GEMINI_API_BASE), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-goog-api-key': this.apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      credentials: 'omit',
    });
    if (!res.ok) throw new HttpFailure(res.status);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error('resposta grande demais');
    return JSON.parse(text);
  }

  /** Estado em cache por 60 s. Sem chave: nem tenta a rede. */
  async health(force = false): Promise<ProviderHealth> {
    if (!this.apiKey) return { reachable: false, embedModel: false, chatModel: false, detail: 'Gemini sem chave configurada' };
    const now = this.clock();
    if (!force && this.cache && now - this.cache.at < HEALTH_TTL_MS) return this.cache.value;
    const probe = async (model: string): Promise<'ok' | 'auth' | 'down'> => {
      try { await this.call(`models/${model}`); return 'ok'; } catch (e) { return e instanceof HttpFailure && (e.status === 401 || e.status === 403 || e.status === 400) ? 'auth' : 'down'; }
    };
    const [chat, embed] = await Promise.all([probe(this.o.chatModel), probe(this.o.embedModel)]);
    const value: ProviderHealth = chat === 'auth' || embed === 'auth'
      ? { reachable: false, embedModel: false, chatModel: false, detail: 'Gemini recusou a chave' }
      : { reachable: chat === 'ok' || embed === 'ok', embedModel: embed === 'ok', chatModel: chat === 'ok', detail: chat === 'down' && embed === 'down' ? 'Gemini indisponível' : 'Gemini (serviço externo)' };
    this.cache = { at: now, value };
    return value;
  }

  async embed(texts: string[], kind: 'query' | 'document' = 'document'): Promise<number[][] | undefined> {
    if (!texts.length) return [];
    if (!this.apiKey) return undefined;
    const out: number[][] = [];
    try {
      for (let i = 0; i < texts.length; i += BATCH) {
        const part = texts.slice(i, i + BATCH);
        const data = (await this.call(`models/${this.o.embedModel}:batchEmbedContents`, {
          requests: part.map((text) => ({
            model: `models/${this.o.embedModel}`,
            content: { parts: [{ text }] },
            taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            outputDimensionality: this.o.embedDimensions,
          })),
        }, kind === 'document' ? Math.max(this.o.timeoutMs, 60_000) : undefined)) as { embeddings?: Array<{ values?: unknown }> };
        const e = data.embeddings;
        if (!Array.isArray(e) || e.length !== part.length) return undefined;
        for (const item of e) {
          const v = item.values;
          if (!Array.isArray(v) || v.length !== this.o.embedDimensions || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
          // Dimensão reduzida não vem normalizada: normaliza para o cosseno ser comparável.
          const norm = Math.sqrt((v as number[]).reduce((s, x) => s + x * x, 0)) || 1;
          out.push((v as number[]).map((x) => x / norm));
        }
      }
      return out;
    } catch (e) {
      if (e instanceof HttpFailure && (e.status === 401 || e.status === 403)) this.cache = undefined;
      return undefined;
    }
  }

  async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    if (!this.apiKey) return { failure: 'auth' };
    try {
      const data = (await this.call(`models/${this.o.chatModel}:generateContent`, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: this.o.maxOutputTokens ?? 2048,
          ...((this.o.thinkingLevel ?? 'low') !== 'default' ? { thinkingConfig: { thinkingLevel: this.o.thinkingLevel ?? 'low' } } : {}),
        },
      }, this.o.generateTimeoutMs ?? this.o.timeoutMs)) as {
        usageMetadata?: { promptTokenCount?: unknown; totalTokenCount?: unknown };
        promptFeedback?: { blockReason?: unknown };
        candidates?: Array<{ finishReason?: unknown; content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
      };
      const prompt = tokenCount(data.usageMetadata?.promptTokenCount), total = tokenCount(data.usageMetadata?.totalTokenCount);
      const meta = prompt !== undefined && total !== undefined && total >= prompt ? { usage: { inputTokens: prompt, outputTokens: total - prompt } } : {};
      if (data.promptFeedback?.blockReason) return { failure: 'refused', ...meta };
      const c = data.candidates?.[0];
      if (!c) return { failure: 'empty', ...meta };
      // Recusas de segurança/política (não podem ser contornadas por outro provedor).
      if (typeof c.finishReason === 'string' && SAFETY_FINISH.has(c.finishReason)) return { failure: 'refused', ...meta };
      // Recitação não é segurança: o modelo só não pôde responder com aquele texto.
      if (c.finishReason === 'RECITATION') return { failure: 'recitation', ...meta };
      // MAX_TOKENS = o modelo parou no teto (muitas vezes porque o raciocínio consumiu o orçamento): a resposta
      // está incompleta e NÃO pode ser tratada como concluída, mesmo que haja texto parcial.
      if (c.finishReason === 'MAX_TOKENS') return { failure: 'truncated', ...meta };
      // Qualquer outro motivo de parada que não seja o normal (STOP) também não é uma resposta concluída.
      if (c.finishReason !== undefined && c.finishReason !== 'STOP') return { failure: 'error', ...meta };
      const text = (c.content?.parts ?? []).map((p) => (p.thought !== true && typeof p.text === 'string' ? p.text : '')).join('').trim();
      return text ? { text, ...meta } : { failure: 'empty', ...meta };
    } catch (e) {
      if (e instanceof HttpFailure) { if (e.status === 401 || e.status === 403) this.cache = undefined; return { failure: failureFor(e.status) }; }
      return { failure: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unavailable' };
    }
  }
}
