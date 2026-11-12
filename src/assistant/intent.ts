/** Destino de um ajuste: som do público (PA) ou o retorno compartilhado dos fones (AUX dos músicos). */
export type Destination = 'pa' | 'fones';

/**
 * O que a pessoa (ou a IA) quer, já com os canais identificados pelos NÚMEROS cadastrados.
 * Ainda não é comando: vira proposta (cartão com Aplicar) e só então passa pela autorização,
 * pelas travas e pela fila da E2.
 */
export type Intent =
  | { type: 'level'; channel: number; dest: Destination; aux?: number; deltaDB?: number; db?: number; reason?: string }
  | { type: 'mute'; channels: number[]; dest: Destination; aux?: number; muted: boolean; reason?: string }
  | { type: 'master'; deltaDB?: number; db?: number; reason?: string }
  | { type: 'undo'; reason?: string };

export interface ClarifyOption {
  /** Texto do botão ("PA", "Fones", "Voz Fred"). */
  label: string;
  /** Pedido completo reescrito, enviado de novo quando a pessoa toca no botão. */
  text: string;
}

export type ParseOutcome =
  | { kind: 'intents'; intents: Intent[] }
  | { kind: 'clarify'; question: string; options: ClarifyOption[] }
  | { kind: 'answer'; text: string }
  | { kind: 'query'; channel: number; dest: Destination; aux?: number; parameter: 'level' | 'mute' | 'configuration' }
  | { kind: 'masterQuery' }
  | { kind: 'unknown' };
