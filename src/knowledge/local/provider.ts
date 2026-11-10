/**
 * Contrato dos provedores de IA da base de conhecimento. Ollama (local) e Gemini (externo) falam a
 * mesma língua; o motor determinístico é o fallback de todos e não passa por aqui. Nenhum provedor
 * conhece a mesa, o controlador ou a fila: só recebem texto de apoio e devolvem texto/vetores.
 */
export type ProviderId = 'ollama' | 'gemini' | 'deepseek' | 'anthropic';
/** Provedores externos exigem consentimento do operador por sessão antes de qualquer envio (Gemini mantém o fluxo anterior). */
export const PROVIDER_IDS = ['ollama', 'gemini', 'deepseek', 'anthropic'] as const;

export interface ProviderHealth { reachable: boolean; embedModel: boolean; chatModel: boolean; detail: string }

/**
 * Por que não houve texto. Só códigos: nunca a mensagem do servidor, a chave nem o conteúdo.
 * auth = chave recusada; quota = limite de uso;
 * refused = recusa de SEGURANÇA/política do provedor (pedido ou resposta bloqueados): NUNCA aciona outro provedor;
 * recitation = o modelo não pôde responder por reproduzir texto protegido: falha do modelo, não recusa de segurança;
 * truncated = a resposta parou no teto de tokens (incompleta: nunca é exibida como se estivesse concluída).
 */
export type GenerateFailure = 'unavailable' | 'timeout' | 'error' | 'empty' | 'auth' | 'quota' | 'refused' | 'recitation' | 'truncated';
/** Consumo informado pela API: só números. */
export interface ProviderUsage { inputTokens: number; outputTokens: number }
export interface GenerateResult {
  text?: string; failure?: GenerateFailure;
  /** Modelo que de fato respondeu (o que a API informou, ou o configurado). Nunca conteúdo. */
  model?: string;
  usage?: ProviderUsage;
  /** Detalhe de uma falha para o registro (sem texto do servidor): saldo esgotado, orçamento diário local, limite por minuto. */
  reason?: 'insufficient_balance' | 'budget' | 'rate_limit';
}

export interface AiProvider {
  readonly id: ProviderId;
  /** true = os dados saem deste computador. Exige habilitação explícita e confirmação do operador. */
  readonly external: boolean;
  /** Modelo de conversa em uso e os que o operador pode escolher (provedores com mais de um modelo). */
  readonly model?: string;
  readonly modelOptions?: readonly string[];
  selectModel?(model: string): boolean;
  health(force?: boolean): Promise<ProviderHealth>;
  /** Vetores (um por texto) ou undefined se o serviço/modelo não estiver disponível. */
  embed(texts: string[], kind?: 'query' | 'document'): Promise<number[][] | undefined>;
  /** Texto do modelo ou o motivo da falha. A saída é DADO a exibir: nunca é interpretada como comando. */
  generateDetailed(system: string, user: string): Promise<GenerateResult>;
}
