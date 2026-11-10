import type { Principal } from './auth.js';

/**
 * Consentimento do operador para enviar informações a um serviço EXTERNO (Gemini, DeepSeek, Anthropic), na memória e POR SESSÃO.
 * Nasce da seleção confirmada na tela (POST /api/knowledge/providers com confirmExternal) e vale só para o provedor selecionado
 * e para quem confirmou. Qualquer nova seleção apaga todas as concessões; sair da sessão revoga; reiniciar o servidor apaga.
 * Configuração, preferência gravada ou chave presente NUNCA criam consentimento.
 */
export class ExternalConsent {
  revision = 0;
  private grants = new Map<string, string>();
  selection(p: Principal, selected: string, confirmed: boolean): void {
    this.revision++; this.grants.clear();
    if (p.role === 'operator' && ['gemini', 'deepseek', 'anthropic'].includes(selected) && confirmed) this.grants.set(p.id, selected);
  }
  revoke(id: string): void { this.grants.delete(id); this.revision++; }
  /** true somente se esta sessão confirmou ESTE provedor e ele continua sendo o selecionado. */
  allowed(p: Principal, selected: string): boolean { return p.role === 'operator' && ['gemini', 'deepseek', 'anthropic'].includes(selected) && this.grants.get(p.id) === selected; }
  clear(): void { this.grants.clear(); this.revision++; }
}
