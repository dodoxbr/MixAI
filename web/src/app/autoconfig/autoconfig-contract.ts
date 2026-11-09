import { AutoConfigView, type AutoConfigReadModel } from '../../../../src/autoconfig/contracts';
import {
  AdvisoryResponse,
  type AutoConfigAdvice,
} from '../../../../src/autoconfig/advisory-contracts';
import { z } from 'zod';
export { AdvisoryResponse };
export type { AutoConfigAdvice };

const FIELD_LABEL: Record<string, string> = {
  channel: 'canal',
  instrument: 'instrumento',
  destination: 'destino',
  symptom: 'sintoma',
  goal: 'objetivo',
  report: 'relato',
  comparison: 'comparação PA/fones',
  isolation: 'fonte sozinha ou com a banda',
  feedback: 'contenção do apito',
};
const REFUSAL_LABEL: Record<string, string> = {
  disabled: 'Planejador indisponível nesta sessão',
  invalid_input: 'Entrada inválida',
  unsupported_source: 'Fonte não cadastrada ou contraditória',
  safety_stop: 'Parada de segurança',
  stale_observation: 'Estado LAB mudou',
  stale_policy: 'Sessão, seleção ou consentimento mudou',
  provider_refused: 'O modelo recusou — nenhum outro modelo foi tentado',
  invalid_model_output: 'Resposta do modelo fora do contrato — descartada',
  knowledge_unavailable: 'Conhecimento indisponível',
};
const ATTEMPT_LABEL: Record<string, string> = {
  not_consented: 'não confirmado nesta sessão',
  unavailable: 'indisponível',
  timeout: 'tempo esgotado',
  error: 'erro',
  empty: 'resposta vazia',
  auth: 'chave recusada',
  quota: 'cota esgotada',
  refused: 'recusou',
  recitation: 'bloqueio de citação',
  truncated: 'resposta cortada',
  invalid_output: 'resposta fora do contrato',
};
const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  ollama: 'Ollama local',
  deterministic: 'motor determinístico',
};

/** Pure view of the planner advice. Labels only; nothing here authorizes or creates a plan. */
export function advicePresentation(a: AutoConfigAdvice) {
  const used = a.model.used;
  const model =
    used === 'deterministic'
      ? 'Motor determinístico do MixAI — nenhum modelo de IA gerou esta escolha'
      : used === 'gemini'
        ? `Gemini · ${a.model.name ?? 'modelo configurado'} — serviço externo (recebeu só categorias e títulos públicos)`
        : `Ollama local · ${a.model.name ?? 'modelo configurado'} — no próprio computador`;
  const failed = a.advice.provider.attempts.filter((t) => t.status !== 'used');
  const notes = failed.map(
    (t) =>
      `${PROVIDER_LABEL[t.provider] ?? t.provider}: ${ATTEMPT_LABEL[t.status] ?? t.status}` +
      (t.status === 'not_consented'
        ? ' — nada foi enviado. Para usá-lo, confirme o provedor no painel da base de conhecimento (a chave já configurada é reaproveitada).'
        : ''),
  );
  const known = a.context.known.map((f) => FIELD_LABEL[f] ?? f);
  const base = {
    model,
    selected: PROVIDER_LABEL[a.model.selected] ?? a.model.selected,
    notes,
    safety: a.advice.safety,
    known,
    fromDiagnosis: a.context.fromDiagnosis,
  };
  if (a.advice.kind === 'question')
    return { ...base, kind: 'question' as const, question: a.advice.question };
  if (a.advice.kind === 'refusal')
    return {
      ...base,
      kind: 'refusal' as const,
      reason: REFUSAL_LABEL[a.advice.reason] ?? a.advice.reason,
      message: a.advice.message,
      safetyStop: a.advice.reason === 'safety_stop',
    };
  const p = a.advice.proposal,
    s = p.suggestions[0],
    c = s.candidate;
  return {
    ...base,
    kind: 'proposal' as const,
    channel: p.channel,
    destination: p.destination === 'fones' ? ('AUX1' as const) : ('PA' as const),
    risk: s.risk === 'high' ? 'alto' : 'médio',
    purpose: c.purpose,
    instruction: c.instruction,
    preconditions: c.preconditions,
    verification: c.verification,
    stop: c.stop,
    justification: s.justification,
    limitations: s.limitations,
    rollback: s.rollback.instruction,
    evidence: p.evidence.map(
      (e) =>
        `${e.kind === 'musician_report' ? 'Relato de músico, não verificado' : 'Relato do operador'}: ${e.symptom} — não é medição`,
    ),
    references: c.references.map((r) => ({
      title: r.title,
      url: r.url,
      detail: `${r.section} · ${r.version} · consultado em ${r.consultedOn} · teoria`,
    })),
    procedure: `${c.procedureId} v${c.procedureVersion}`,
    skeleton: a.proposal?.items[0] ?? null,
  };
}
export type AdviceView = ReturnType<typeof advicePresentation>;
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
