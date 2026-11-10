import { HEALTH_TTL_MS, MODEL_RE, HttpFailure, callJson, failureOfError, tokenCount } from './external.js';
import type { AiProvider, GenerateResult, ProviderHealth } from './provider.js';

/** Endereço FIXO da API oficial (compatível com OpenAI): a chave e os textos só podem ir para a DeepSeek. */
export const DEEPSEEK_API_BASE = 'https://api.deepseek.com/';
/** Modelos oferecidos ao operador (documentação oficial da DeepSeek). Flash é o padrão. */
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;

export interface DeepSeekOptions {
  chatModel: string;
  timeoutMs: number;
  generateTimeoutMs?: number;
  /** Teto de tokens da resposta (padrão 600). */
  maxOutputTokens?: number;
}

/**
 * Cliente mínimo da DeepSeek (somente texto). A chave vai SOMENTE no cabeçalho Authorization: nunca na URL, em
 * mensagem de erro, em log ou em resposta da API do MixAI. Sem embeddings: a busca documental continua local.
 * Falha de forma contida (código de motivo); quem decide a reserva é o chamador, nunca este cliente.
 */
export class DeepSeekClient implements AiProvider {
  readonly id = 'deepseek' as const;
  readonly external = true;
  readonly modelOptions: readonly string[] = DEEPSEEK_MODELS;
  private chat: string;
  private cache?: { at: number; model: string; value: ProviderHealth };

  constructor(
    private readonly o: DeepSeekOptions,
    private readonly apiKey: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    if (!MODEL_RE.test(o.chatModel)) throw new Error('Nome de modelo DeepSeek inválido.');
    this.chat = o.chatModel;
  }

  get configured(): boolean { return !!this.apiKey; }
  get model(): string { return this.chat; }
  selectModel(model: string): boolean {
    if (!(DEEPSEEK_MODELS as readonly string[]).includes(model)) return false;
    this.chat = model; this.cache = undefined;
    return true;
  }

  private headers(): Record<string, string> { return { authorization: `Bearer ${this.apiKey}` }; }

  /** GET /models não consome saldo. Em cache por 60 s. Sem chave: nem tenta a rede. */
  async health(force = false): Promise<ProviderHealth> {
    if (!this.apiKey) return { reachable: false, embedModel: false, chatModel: false, detail: 'DeepSeek sem chave configurada' };
    const now = this.clock();
    if (!force && this.cache && this.cache.model === this.chat && now - this.cache.at < HEALTH_TTL_MS) return this.cache.value;
    let value: ProviderHealth;
    try {
      const data = (await callJson(this.fetchFn, new URL('models', DEEPSEEK_API_BASE), { method: 'GET', headers: this.headers() }, this.o.timeoutMs)) as { data?: Array<{ id?: unknown }> };
      const ids = new Set((data.data ?? []).map((m) => m.id));
      value = { reachable: true, embedModel: false, chatModel: ids.has(this.chat), detail: 'DeepSeek (serviço externo)' };
    } catch (e) {
      value = e instanceof HttpFailure && (e.status === 401 || e.status === 403)
        ? { reachable: false, embedModel: false, chatModel: false, detail: 'DeepSeek recusou a chave' }
        : { reachable: false, embedModel: false, chatModel: false, detail: 'DeepSeek indisponível' };
    }
    this.cache = { at: now, model: this.chat, value };
    return value;
  }

  async embed(): Promise<undefined> { return undefined; }

  async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    if (!this.apiKey) return { failure: 'auth' };
    try {
      const data = (await callJson(this.fetchFn, new URL('chat/completions', DEEPSEEK_API_BASE), {
        method: 'POST', headers: this.headers(),
        body: { model: this.chat, stream: false, temperature: 0.2, max_tokens: this.o.maxOutputTokens ?? 600,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
      }, this.o.generateTimeoutMs ?? this.o.timeoutMs)) as {
        model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
      };
      const model = typeof data.model === 'string' && MODEL_RE.test(data.model) ? data.model : this.chat;
      const input = tokenCount(data.usage?.prompt_tokens), output = tokenCount(data.usage?.completion_tokens);
      const usage = input !== undefined && output !== undefined ? { inputTokens: input, outputTokens: output } : undefined;
      const meta = { model, ...(usage ? { usage } : {}) };
      const c = data.choices?.[0];
      if (!c) return { failure: 'empty', ...meta };
      // content_filter = bloqueio de segurança/política: NUNCA aciona outro provedor.
      if (c.finish_reason === 'content_filter') return { failure: 'refused', ...meta };
      if (c.finish_reason === 'length') return { failure: 'truncated', ...meta };
      if (c.finish_reason === 'insufficient_system_resource') return { failure: 'unavailable', ...meta };
      if (c.finish_reason !== undefined && c.finish_reason !== 'stop') return { failure: 'error', ...meta };
      const text = typeof c.message?.content === 'string' ? c.message.content.trim() : '';
      return text ? { text, ...meta } : { failure: 'empty', ...meta };
    } catch (e) {
      if (e instanceof HttpFailure && (e.status === 401 || e.status === 403)) this.cache = undefined;
      return failureOfError(e);
    }
  }
}
