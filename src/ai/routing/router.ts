import type { ChatRoute } from '../../knowledge/local/provider.js';
import type { CatalogActor, CatalogProviderId } from '../model-catalog/contracts.js';
import type { ModelCatalogService } from '../model-catalog/service.js';
import { RoutedProvider } from './routed-provider.js';

/** Fluxo que pediu a geração (registro/auditoria). Nenhum deles executa comandos. */
export type RoutedFlow = 'knowledge' | 'autoconfig' | 'complete' | 'mixer_operator';
export interface RouteSnapshot { provider: CatalogProviderId; model: string; revision: number; external: boolean; consented: boolean; key: string }

/**
 * Resolução central de provedor/modelo POR SESSÃO AUTENTICADA. Fonte única da verdade: a seleção revisionada do catálogo
 * (`ModelCatalogService`), que também guarda o consentimento por sessão+provedor+modelo. Este roteador NÃO guarda seleção,
 * consentimento, orçamento nem cache: lê tudo do catálogo a cada pergunta, então revogar, trocar o modelo, sair da sessão ou
 * reiniciar nunca deixa um estado paralelo que permita envio externo.
 * Sem seleção no catálogo para a sessão, `route()` devolve undefined e o consumidor mantém o comportamento anterior.
 */
export class AiRouter {
  constructor(private readonly catalog: ModelCatalogService) {}

  snapshot(actor: CatalogActor): RouteSnapshot | undefined {
    try {
      const view = this.catalog.view({ id: actor.id, role: actor.role });
      const s = view.selection;
      if (!s) return undefined;
      const consented = !s.external || view.consent.granted;
      return { provider: s.provider, model: s.model, revision: s.revision, external: s.external, consented, key: `${s.provider}|${s.model}|${s.revision}|${consented ? 'c' : 'n'}` };
    } catch { return undefined; }
  }

  /** Rota presa à seleção ATUAL da sessão. `allowed()` só é verdadeira enquanto a mesma seleção/revisão/consentimento continuar valendo. */
  route(actor: CatalogActor, flow: RoutedFlow): ChatRoute | undefined {
    const id = { id: actor.id, role: actor.role };
    const snap = this.snapshot(id);
    if (!snap) return undefined;
    return {
      provider: new RoutedProvider(this.catalog, id, snap, flow), key: snap.key,
      allowed: () => { const now = this.snapshot(id); return !!now && now.key === snap.key && now.consented; },
      live: () => this.snapshot(id)?.key ?? 'gone',
    };
  }
}
