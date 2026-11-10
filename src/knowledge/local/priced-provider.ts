import { BudgetedProvider, type BudgetOptions } from './budget.js';
import type { AiProvider, GenerateResult } from './provider.js';
/** Fail-closed price gate around the existing budget implementation; does not duplicate its accounting. */
export class PricedProvider extends BudgetedProvider {
  constructor(inner: AiProvider, private readonly budget: BudgetOptions, private readonly known: (model: string) => boolean) { super(inner, budget); }
  override async generateDetailed(system: string, user: string): Promise<GenerateResult> {
    const model = this.model ?? 'desconhecido';
    if (!this.known(model)) {
      this.budget.log?.(`IA externa: provedor=${this.id} modelo=${model} resultado=bloqueado motivo=preco_desconhecido`);
      return { failure: 'quota', reason: 'budget', model };
    }
    return super.generateDetailed(system, user);
  }
}
