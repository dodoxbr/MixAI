import type { AiProvider, GenerateResult, ProviderHealth } from '../../knowledge/local/provider.js';
import { ModelCatalogError, type CatalogActor, type CatalogErrorCode } from '../model-catalog/contracts.js';
import type { ModelCatalogService } from '../model-catalog/service.js';
import type { RouteSnapshot, RoutedFlow } from './router.js';

/** Código local do catálogo -> falha de provedor já conhecida pelos consumidores. Nunca texto do servidor. */
const FAILURES: Partial<Record<CatalogErrorCode, Pick<GenerateResult, 'failure' | 'reason'>>> = {
  PRICE_UNKNOWN: { failure: 'quota', reason: 'price_unknown' },
  BUDGET: { failure: 'quota', reason: 'budget' },
  RATE_LIMIT: { failure: 'quota', reason: 'rate_limit' },
  BUSY: { failure: 'unavailable' }, DISABLED: { failure: 'unavailable' }, NOT_CONFIGURED: { failure: 'unavailable' }, UNAVAILABLE: { failure: 'unavailable' },
  MODEL_UNAVAILABLE: { failure: 'unavailable' }, INVALID: { failure: 'error' },
};

/**
 * Adaptador do catálogo como `AiProvider` de TEXTO, ligado a uma sessão e a uma revisão da seleção.
 * Toda geração passa por `ModelCatalogService.generate` (consentimento por sessão+modelo, preço, orçamento, limite por minuto,
 * revalidação depois do await). Não busca vetores: embeddings continuam sendo outra operação, outro modelo.
 */
export class RoutedProvider implements AiProvider {
  readonly id: RouteSnapshot['provider'];
  readonly external: boolean;
  readonly model: string;
  constructor(private readonly catalog: ModelCatalogService, private readonly actor: CatalogActor, private readonly snap: RouteSnapshot, private readonly flow: RoutedFlow) {
    this.id = snap.provider; this.external = snap.external; this.model = snap.model;
  }
  async health(): Promise<ProviderHealth> { return { reachable: false, embedModel: false, chatModel: false, detail: 'ROTEADO' }; }
  async embed(): Promise<undefined> { return undefined; }
  async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    try {
      const r = await this.catalog.generate(this.actor, system, user, this.snap.revision, this.flow);
      return { ...(r.result.text !== undefined ? { text: r.result.text } : {}), ...(r.result.failure ? { failure: r.result.failure } : {}), model: r.result.model,
        ...(r.result.usage ? { usage: r.result.usage } : {}), ...(r.result.reason ? { reason: r.result.reason } : {}) };
    } catch (error) {
      // STALE / NOT_CONSENTED / UNAUTHORIZED / FORBIDDEN: a sessão mudou. O consumidor reavalia `allowed()` e descarta; aqui só 'error'.
      const mapped = error instanceof ModelCatalogError ? FAILURES[error.code] : undefined;
      return { failure: mapped?.failure ?? 'error', ...(mapped?.reason ? { reason: mapped.reason } : {}) };
    }
  }
}
