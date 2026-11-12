import type { Result } from '../core/protocol';
export type OperationState = 'simulated' | 'sent' | 'reported' | 'pending' | 'uncertain' | 'refused';
export interface OperationReceipt { receivedAt: number; result: Result }
/** A reply/HTTP 200 is not physical acknowledgement. Use only business data supplied by the server. */
export function operationView(result: Result | undefined, mode?: string): { state: OperationState; label: string; message: string } {
  const message = typeof result?.message === 'string' ? result.message : 'Retorno detalhado não disponível.';
  if (result?.needsConfirmation || result?.code === 'NEEDS_CONFIRMATION') return { state: 'pending', label: 'Aguardando aprovação especial', message };
  const changes = Array.isArray(result?.data?.['changes']) ? result!.data!['changes'] as Array<{ outcome?: unknown }> : [];
  if (result?.code === 'INDETERMINATE' || result?.code === 'PARTIAL' || changes.some(c => c?.outcome === 'indeterminate' || c?.outcome === 'not_sent')) return { state: 'uncertain', label: 'Resultado indeterminado — confira o estado', message };
  if (result && !result.ok) return { state: 'refused', label: 'Pedido recusado pelo servidor', message };
  if (changes.some(c => c?.outcome === 'sent')) return { state: 'sent', label: 'Enviado — sem confirmação física da Ui16', message };
  if (changes.length && changes.every(c => c?.outcome === 'applied_simulated') && (mode === 'lab' || mode === 'mock')) return { state: 'simulated', label: 'Aplicado no laboratório (simulado)', message };
  return { state: 'reported', label: 'Retorno recebido — confirmação final não disponível', message };
}
