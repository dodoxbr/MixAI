import { HEALTH_TTL_MS, MODEL_RE, HttpFailure, callJson, failureOfError, tokenCount } from './external.js';
import type { AiProvider, GenerateResult, ProviderHealth } from './provider.js';

/** Endereço FIXO da API oficial da Anthropic. */
export const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/';
/** Identificadores confirmados em platform.claude.com (Models overview): Opus 5.5 e Fable 5.2. */
export const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-fable-5-2'] as const;

export interface AnthropicOptions {
  chatModel: string;
  timeoutMs: number;
  generateTimeoutMs?: number;
  /** Teto de tokens da resposta, contando o raciocínio adaptativo dos modelos 5.x (padrão 1024). */
  maxOutputTokens?: number;
}

/**
 * Provedor de TEXTO da Anthropic para resumo e planejador. Reaproveita a chave `anthropicApiKey` do assistente
 * (nunca no navegador, no log ou em erro). Sem ferramentas: não existe `tool_use` aqui, então o modelo não propõe ajustes.
 * O assistente de comandos (ClaudeClient) continua separado e inalterado.
 */
export class AnthropicClient implements AiProvider {
  readonly id = 'anthropic' as const;
  readonly external = true;
  readonly modelOptions: readonly string[] = ANTHROPIC_MODELS;
  private chat: string;
  private cache?: { at: number; model: string; value: ProviderHealth };

  constructor(
    private readonly o: AnthropicOptions,
    private readonly apiKey: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    if (!MODEL_RE.test(o.chatModel)) throw new Error('Nome de modelo Anthropic inválido.');
    this.chat = o.chatModel;
  }

  get configured(): boolean { return !!this.apiKey; }
  get model(): string { return this.chat; }
  selectModel(model: string): boolean {
    if (!(ANTHROPIC_MODELS as readonly string[]).includes(model)) return false;
    this.chat = model; this.cache = undefined;
    return true;
  }

  private headers(): Record<string, string> { return { 'x-api-key': this.apiKey!, 'anthropic-version': '2023-06-01' }; }

  /** GET /models/{id} não consome tokens. Em cache por 60 s. Sem chave: nem tenta a rede. */
  async health(force = false): Promise<ProviderHealth> {
    if (!this.apiKey) return { reachable: false, embedModel: false, chatModel: false, detail: 'Anthropic sem chave configurada' };
    const now = this.clock();
    if (!force && this.cache && this.cache.model === this.chat && now - this.cache.at < HEALTH_TTL_MS) return this.cache.value;
    let value: ProviderHealth;
    try {
      await callJson(this.fetchFn, new URL(`models/${this.chat}`, ANTHROPIC_API_BASE), { method: 'GET', headers: this.headers() }, this.o.timeoutMs);
      value = { reachable: true, embedModel: false, chatModel: true, detail: 'Anthropic (serviço externo)' };
    } catch (e) {
      value = e instanceof HttpFailure && (e.status === 401 || e.status === 403)
        ? { reachable: false, embedModel: false, chatModel: false, detail: 'Anthropic recusou a chave' }
        : { reachable: false, embedModel: false, chatModel: false, detail: 'Anthropic indisponível' };
    }
    this.cache = { at: now, model: this.chat, value };
    return value;
  }

  async embed(): Promise<undefined> { return undefined; }

  async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    if (!this.apiKey) return { failure: 'auth' };
    try {
      const data = (await callJson(this.fetchFn, new URL('messages', ANTHROPIC_API_BASE), {
        method: 'POST', headers: this.headers(),
        body: { model: this.chat, max_tokens: this.o.maxOutputTokens ?? 1024, system, messages: [{ role: 'user', content: user }] },
      }, this.o.generateTimeoutMs ?? this.o.timeoutMs)) as {
        model?: unknown; stop_reason?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown };
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
      const model = typeof data.model === 'string' && MODEL_RE.test(data.model) ? data.model : this.chat;
      const input = tokenCount(data.usage?.input_tokens), output = tokenCount(data.usage?.output_tokens);
      const usage = input !== undefined && output !== undefined ? { inputTokens: input, outputTokens: output } : undefined;
      const meta = { model, ...(usage ? { usage } : {}) };
      // Recusa de segurança/política do modelo: NUNCA aciona outro provedor.
      if (data.stop_reason === 'refusal') return { failure: 'refused', ...meta };
      if (data.stop_reason === 'max_tokens') return { failure: 'truncated', ...meta };
      if (data.stop_reason !== undefined && data.stop_reason !== 'end_turn' && data.stop_reason !== 'stop_sequence') return { failure: 'error', ...meta };
      // Só blocos de texto: raciocínio (thinking) e qualquer tool_use são ignorados.
      const text = (data.content ?? []).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('').trim();
      return text ? { text, ...meta } : { failure: 'empty', ...meta };
    } catch (e) {
      if (e instanceof HttpFailure && (e.status === 401 || e.status === 403)) this.cache = undefined;
      return failureOfError(e);
    }
  }
}
