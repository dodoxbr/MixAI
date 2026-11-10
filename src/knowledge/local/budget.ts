import type { UsageTracker } from '../../ai/usage.js';
import type { AiProvider, GenerateResult, ProviderHealth } from './provider.js';

export interface ModelPrice { inputPerMTok: number; outputPerMTok: number }
export interface BudgetOptions {
  tracker: UsageTracker;
  dailyBudgetUSD: number;
  maxRequestsPerMinute: number;
  /** Preço por modelo (USD por milhão de tokens). Modelo sem preço configurado usa `fallback`. */
  price(model: string): ModelPrice;
  maxOutputTokens: number;
  /** Só provedor, modelo, tokens e custo estimado: nunca chave, pergunta ou resposta. */
  log?: (msg: string) => void;
}

/**
 * Controle de custo dos provedores EXTERNOS. Reserva o custo máximo estimado (preço do modelo × tokens) ANTES da chamada,
 * troca pela medida real depois, e recusa localmente (sem rede) quando o teto diário ou o limite por minuto acabou.
 * É uma proteção por ESTIMATIVA com preços configurados; não substitui o painel de faturamento do provedor.
 */
export class BudgetedProvider implements AiProvider {
  constructor(private readonly inner: AiProvider, private readonly o: BudgetOptions) {}
  get id() { return this.inner.id; }
  get external() { return this.inner.external; }
  get model() { return this.inner.model; }
  get modelOptions() { return this.inner.modelOptions; }
  get configured(): boolean { return (this.inner as { configured?: boolean }).configured !== false; }
  selectModel(model: string): boolean { return this.inner.selectModel?.(model) ?? false; }
  health(force?: boolean): Promise<ProviderHealth> { return this.inner.health(force); }
  embed(texts: string[], kind?: 'query' | 'document') { return this.inner.embed(texts, kind); }

  async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    const model = this.inner.model ?? 'desconhecido', price = this.o.price(model);
    const cost = (inTok: number, outTok: number) => (inTok * price.inputPerMTok + outTok * price.outputPerMTok) / 1e6;
    const note = (what: string) => this.o.log?.(`IA externa: provedor=${this.inner.id} modelo=${model} ${what}`);
    const t = this.o.tracker;
    if (!t.takeSlot(this.o.maxRequestsPerMinute)) { note('resultado=bloqueado motivo=limite_por_minuto'); return { failure: 'quota', reason: 'rate_limit', model }; }
    // 2 caracteres por token é conservador para português; a reserva é o MÁXIMO possível.
    const reserved = t.reserve(cost(Math.ceil((system.length + user.length) / 2), this.o.maxOutputTokens), this.o.dailyBudgetUSD);
    if (!reserved.ok) { note(`resultado=bloqueado motivo=orcamento_diario`); return { failure: 'quota', reason: 'budget', model }; }
    let result: GenerateResult;
    try { result = await this.inner.generateDetailed(system, user); } catch { result = { failure: 'error' }; }
    const used = result.model ?? model;
    if (result.usage) {
      const real = cost(result.usage.inputTokens, result.usage.outputTokens);
      t.settle(reserved.id, result.usage.inputTokens, result.usage.outputTokens, real);
      note(`resultado=${result.failure ? `falha:${result.failure}` : 'ok'} modelo_respondeu=${used} tokens_entrada=${result.usage.inputTokens} tokens_saida=${result.usage.outputTokens} custo_estimado_usd=${real.toFixed(6)}`);
    } else if (result.failure === 'auth' || result.failure === 'quota') {
      t.release(reserved.id); // recusa clara, sem processamento
      note(`resultado=falha:${result.failure}${result.reason ? ` motivo=${result.reason}` : ''} custo=0`);
    } else {
      const charged = t.chargeReserved(reserved.id); // pode ter sido processada: cobra a estimativa inteira
      note(`resultado=${result.failure ? `falha:${result.failure}` : 'ok'} custo_estimado_usd=${charged.toFixed(6)} (sem consumo informado)`);
    }
    return { ...result, model: used };
  }
}
