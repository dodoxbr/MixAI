import type { Intent } from '../assistant/intent.js';
import type { ProposalCard } from '../assistant/proposals.js';
import { processingSpec } from '../core/processing-policy.js';
import type { Principal } from './auth.js';
import type { ServerCore } from './core.js';
import { realControlsFor } from './first-real-aux/service.js';
import { processingFor } from './ui16-processing/service.js';

/**
 * Único ponto em que o assistente alcança os controles REAL: devolve SOMENTE prévias (propostas) pelos serviços existentes.
 * Volume/mute (PA e AUX) → serviço de controles (#100/#102); EQ/HPF/bypass → serviço de processamento (#103). Desfazer vai para o
 * serviço dono do topo da pilha. Nada aqui confirma, executa ou fala com o transporte.
 */
export function realAssistantPreview(core: ServerCore) {
  return (p: Principal, intent: Intent, source: ProposalCard['source']): { proposal?: ProposalCard; result?: { code: string; message: string } } => {
    const top = core.controller.peekUndo();
    const processing = intent.type === 'processing' || (intent.type === 'undo' && top?.targets.length === 1 && !!processingSpec(top.targets[0]!.key));
    return processing ? processingFor(core).previewIntent(p, intent, source) : realControlsFor(core).previewIntent(p, intent, source);
  };
}
