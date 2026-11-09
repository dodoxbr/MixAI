import { AutoConfigView, type AutoConfigReadModel } from '../../../../src/autoconfig/contracts';
import { z } from 'zod';
export interface AutoContext {
  eventId: string;
  eventName: string;
  eventVersion: number;
}
export interface AutoAnswers {
  goal: string;
  channel: number;
  destination: 'PA' | 'AUX1';
  report: string;
}
export const Workspace = z.object({
  schemaVersion: z.literal(1),
  serverId: z.string(),
  mode: z.enum(['lab', 'mock']),
  capabilities: z.object({ execution: z.literal('virtual_only'), realWrite: z.literal(false) }),
  channels: z.array(z.object({ number: z.number().int(), name: z.string() })),
  plans: z.array(AutoConfigView).max(50),
});
// A receipt for the saved server reference, not a loadable scene or local reference store.
export const ReferenceReceipt = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  validationStatus: z.literal('UNVERIFIED'),
  simulation: z.object({
    planId: z.string(),
    mode: z.enum(['lab', 'mock']),
    notApplied: z.literal(true),
  }),
});
export type AutoReference = z.infer<typeof ReferenceReceipt>;
export interface AutoAdapter {
  request(path: string, body: object | undefined, signal: AbortSignal): Promise<unknown>;
}
export { AutoConfigView };
export type { AutoConfigReadModel };
export function presentation(plan: AutoConfigReadModel) {
  return {
    items: plan.items.map((i) => ({
      id: i.spec.id,
      channel: i.spec.channel,
      destination: plan.scope,
      title: `Teste virtual CH${i.spec.channel ?? '?'}`,
      before:
        i.observation?.status === 'known'
          ? String(i.observation.value) + ' dB (virtual)'
          : 'Indisponível — não presumido',
      after:
        i.target === undefined
          ? 'Aguardando contexto'
          : `${i.target} dB (virtual); diferença ${i.spec.deltaDB} dB`,
      rationale: i.spec.rationale,
      evidence:
        i.spec.evidence
          .map((e) => `${e.kind === 'human_report' ? 'Relato humano' : 'Teoria'}: ${e.text}`)
          .join('; ') || 'Evidência ausente',
      preconditions: ['Preparação atual no servidor e autorização individual da sessão operadora.'],
      limitations: [
        'Somente level_delta virtual, até ±3 dB. Não é uma recomendação acústica.',
        'AUX1 compartilhado; nenhum áudio coletado.',
      ],
      validation: 'Verificador do servidor compara valores virtuais; não valida som.',
      rollback: 'Desfazer retorna apenas a visão virtual. Não existe compensação na mesa.',
      references: [
        {
          title: 'Núcleo AutoConfig — contrato e limites',
          url: 'https://github.com/dodoxbr/MixAI/blob/main/docs/autoconfig/CORE.md',
        },
      ],
    })),
  };
}
