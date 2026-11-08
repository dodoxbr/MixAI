/**
 * Contrato dos provedores de IA da base de conhecimento. Ollama (local) e Gemini (externo) falam a
 * mesma língua; o motor determinístico é o fallback de todos e não passa por aqui. Nenhum provedor
 * conhece a mesa, o controlador ou a fila: só recebem texto de apoio e devolvem texto/vetores.
 */
export type ProviderId = 'ollama' | 'gemini';

export interface ProviderHealth { reachable: boolean; embedModel: boolean; chatModel: boolean; detail: string }

/**
 * Por que não houve texto. Só códigos: nunca a mensagem do servidor, a chave nem o conteúdo.
 * auth = chave recusada; quota = limite de uso;
 * refused = recusa de SEGURANÇA/política do provedor (pedido ou resposta bloqueados): NUNCA aciona outro provedor;
 * recitation = o modelo não pôde responder por reproduzir texto protegido: falha do modelo, não recusa de segurança;
 * truncated = a resposta parou no teto de tokens (incompleta: nunca é exibida como se estivesse concluída).
 */
export type GenerateFailure = 'unavailable' | 'timeout' | 'error' | 'empty' | 'auth' | 'quota' | 'refused' | 'recitation' | 'truncated';
export interface GenerateResult { text?: string; failure?: GenerateFailure }

export interface AiProvider {
  readonly id: ProviderId;
  /** true = os dados saem deste computador. Exige habilitação explícita e confirmação do operador. */
  readonly external: boolean;
  health(force?: boolean): Promise<ProviderHealth>;
  /** Vetores (um por texto) ou undefined se o serviço/modelo não estiver disponível. */
  embed(texts: string[], kind?: 'query' | 'document'): Promise<number[][] | undefined>;
  /** Texto do modelo ou o motivo da falha. A saída é DADO a exibir: nunca é interpretada como comando. */
  generateDetailed(system: string, user: string): Promise<GenerateResult>;
}
