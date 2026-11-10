import { callJson, failureOfError, MODEL_RE, tokenCount } from '../../knowledge/local/external.js';
import type { GenerateResult, ProviderHealth } from '../../knowledge/local/provider.js';
import type { CatalogTextProvider } from './contracts.js';
export const OPENAI_API_BASE = 'https://api.openai.com/v1/';
/** Official Responses API, text only. Credentials never leave fixed official origin. */
export class OpenAITextClient implements CatalogTextProvider {
  readonly id = 'openai' as const;
  readonly external = true;
  constructor(readonly model: string, private readonly key: string | undefined, private readonly options: { maxOutputTokens: number; timeoutMs: number }, private readonly fetchFn: typeof fetch = fetch) {
    if (!MODEL_RE.test(model)) throw new Error('INVALID_MODEL');
  }
  get configured() { return !!this.key; }
  private headers() { return { authorization: `Bearer ${this.key}` }; }
  async health(): Promise<ProviderHealth> {
    if (!this.key) return { reachable: false, chatModel: false, embedModel: false, detail: 'NOT_CONFIGURED' };
    try {
      const data = await callJson(this.fetchFn, new URL(`models/${encodeURIComponent(this.model)}`, OPENAI_API_BASE), { method: 'GET', headers: this.headers() }, this.options.timeoutMs) as { id?: unknown };
      return { reachable: true, chatModel: data.id === this.model, embedModel: false, detail: data.id === this.model ? 'MODEL_AVAILABLE' : 'MODEL_UNAVAILABLE' };
    } catch { return { reachable: false, chatModel: false, embedModel: false, detail: 'MODEL_UNAVAILABLE' }; }
  }
  async embed(): Promise<undefined> { return undefined; }
  async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    if (!this.key) return { failure: 'auth' };
    try {
      const data = await callJson(this.fetchFn, new URL('responses', OPENAI_API_BASE), { method: 'POST', headers: this.headers(), body: {
        model: this.model, instructions: system, input: user, max_output_tokens: this.options.maxOutputTokens,
        store: false, stream: false,
      } }, this.options.timeoutMs) as { model?: unknown; status?: unknown; output?: Array<{ type?: unknown; role?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
      const input = tokenCount(data.usage?.input_tokens), output = tokenCount(data.usage?.output_tokens);
      const meta = { model: typeof data.model === 'string' && MODEL_RE.test(data.model) ? data.model : this.model,
        ...(input === undefined || output === undefined ? {} : { usage: { inputTokens: input, outputTokens: output } }) };
      if (!Array.isArray(data.output)) return { failure: 'error', ...meta };
      if (data.output.some(item => Array.isArray(item.content) && item.content.some(c => c.type === 'refusal'))) return { failure: 'refused', ...meta };
      if (data.status === 'incomplete') return { failure: 'truncated', ...meta };
      if (data.status !== 'completed') return { failure: 'error', ...meta };
      // Tool/function output is never executable or interpreted; reject unexpected items entirely.
      if (data.output.some(item => item.type !== 'message' && item.type !== 'reasoning')) return { failure: 'error', ...meta };
      const text = data.output.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => (Array.isArray(item.content) ? item.content : []).filter(c => c.type === 'output_text' && typeof c.text === 'string').map(c => c.text as string)).join('\n').trim();
      return text ? { text, ...meta } : { failure: 'empty', ...meta };
    } catch (error) { return failureOfError(error); }
  }
}
