import type { AiProvider, GenerateFailure, GenerateResult, ProviderHealth } from './provider.js';
export type { GenerateFailure, GenerateResult } from './provider.js';

export interface OllamaOptions { url: string; embedModel: string; chatModel: string; embedDimensions: number; timeoutMs: number; /** Geração é bem mais lenta que embedding em CPU: tempo próprio. */ generateTimeoutMs?: number; /** Prefixos que alguns modelos exigem (ex.: nomic: "search_query: " / "search_document: "). */ queryPrefix?: string; documentPrefix?: string }
export type OllamaHealth = ProviderHealth;

const MAX_BODY = 4 * 1024 * 1024;
/** Lote de documento (16 trechos, em CPU) leva bem mais que uma pergunta: não herda o limite curto da consulta. */
const DOCUMENT_EMBED_TIMEOUT_MS = 60_000;

/**
 * Cliente mínimo do Ollama local. Falha SEMPRE de forma contida (retorna indisponível): o chamador
 * cai para busca por palavras e para o motor determinístico. Nunca recebe segredos nem a mesa.
 */
export class OllamaClient implements AiProvider {
  readonly id = 'ollama' as const;
  readonly external = false;
  get model(): string { return this.o.chatModel; }
  private cache?: { at: number; value: OllamaHealth };
  constructor(private readonly o: OllamaOptions, private readonly fetchFn: typeof fetch = fetch, private readonly clock: () => number = Date.now) {}

  private async call(path: string, body?: unknown, timeoutMs: number = this.o.timeoutMs): Promise<unknown> {
    const res = await this.fetchFn(new URL(path, this.o.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error('resposta grande demais');
    return JSON.parse(text);
  }

  /** Estado do serviço, em cache por 15 s para não atrasar cada pergunta do chat. */
  async health(force = false): Promise<OllamaHealth> {
    const now = this.clock();
    if (!force && this.cache && now - this.cache.at < 15_000) return this.cache.value;
    let value: OllamaHealth;
    try {
      const data = (await this.call('/api/tags')) as { models?: Array<{ name?: unknown }> };
      const names = (data.models ?? []).map((m) => String(m.name ?? ''));
      const has = (model: string) => names.some((n) => n === model || n.split(':')[0] === model.split(':')[0] && (!model.includes(':') || n === model));
      value = { reachable: true, embedModel: has(this.o.embedModel), chatModel: has(this.o.chatModel), detail: names.length ? `${names.length} modelo(s) instalado(s)` : 'nenhum modelo instalado' };
    } catch {
      value = { reachable: false, embedModel: false, chatModel: false, detail: 'Ollama indisponível' };
    }
    this.cache = { at: now, value };
    return value;
  }

  /** Vetores (um por texto) ou undefined se o modelo/serviço não estiver disponível. */
  async embed(texts: string[], kind: 'query' | 'document' = 'document'): Promise<number[][] | undefined> {
    if (!texts.length) return [];
    const prefix = (kind === 'query' ? this.o.queryPrefix : this.o.documentPrefix) ?? '';
    const h = await this.health();
    if (!h.reachable || !h.embedModel) return undefined;
    try {
      const data = (await this.call('/api/embed', { model: this.o.embedModel, input: prefix ? texts.map((t) => prefix + t) : texts }, kind === 'document' ? Math.max(this.o.timeoutMs, DOCUMENT_EMBED_TIMEOUT_MS) : undefined)) as { embeddings?: unknown };
      const e = data.embeddings;
      if (!Array.isArray(e) || e.length !== texts.length) return undefined;
      const ok = e.every((v) => Array.isArray(v) && v.length === this.o.embedDimensions && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
      return ok ? (e as number[][]) : undefined;
    } catch {
      this.cache = undefined;
      return undefined;
    }
  }

  /** Texto do modelo, ou undefined. A saída é DADO a exibir: nunca é interpretada como comando. */
  async generate(system: string, user: string): Promise<string | undefined> {
    return (await this.generateDetailed(system, user)).text;
  }

  /** Como `generate`, mas informa o MOTIVO da falha (sem conteúdo do modelo nem do servidor). */
  async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    const h = await this.health();
    if (!h.reachable || !h.chatModel) return { failure: 'unavailable' };
    try {
      const data = (await this.call('/api/chat', {
        model: this.o.chatModel, stream: false,
        // Modelos que "pensam" (qwen3, deepseek-r1…) gastavam o num_predict no raciocínio e a resposta saía cortada
        // (medido: qwen3:8b, 260 tokens, 818 caracteres de raciocínio, done_reason=length). O resumo não precisa disso.
        think: false,
        // Mantém o modelo na GPU entre perguntas (carga a frio do 8B levou ~30 s, o mesmo do tempo limite do resumo).
        // É por requisição: não altera a configuração global do Ollama nem os modelos de outros projetos.
        keep_alive: '30m',
        options: { temperature: 0.2, num_predict: 260 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }, this.o.generateTimeoutMs ?? this.o.timeoutMs)) as { message?: { content?: unknown }; done_reason?: unknown };
      // done_reason "length" = parou em num_predict: texto incompleto, não é uma resposta concluída.
      if (data.done_reason === 'length') return { failure: 'truncated' };
      const out = data.message?.content;
      return typeof out === 'string' && out.trim() ? { text: out } : { failure: 'empty' };
    } catch (err) {
      this.cache = undefined;
      return { failure: err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'error' };
    }
  }
}
