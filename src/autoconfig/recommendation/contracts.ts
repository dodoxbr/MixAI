import { z } from 'zod';
import { LIMITS } from '../../core/params.js';
import { Id, Scope, Text } from '../../reference/values.js';

/**
 * AutoConfig 2.0 — contrato de RECOMENDAÇÃO técnica (protótipo offline, ainda não ligado a rota, tela ou núcleo D).
 *
 * Princípios (todos verificados por teste):
 *  - uma recomendação é DADO: nunca comando, nunca autorização, nunca execução (`authorization: 'not_granted'`, `execution: 'not_executable'`);
 *  - todo valor carrega a sua PROVENIÊNCIA: observado (estado LAB lido pelo servidor), informado pelo operador, sugerido pela IA ou desconhecido;
 *  - não existe proveniência "medido": não há áudio, RTA, SPL nem frequência medida neste produto;
 *  - o modelo de IA só ESCOLHE entre candidatos montados pelo servidor, com valores vindos de conhecimento versionado; nunca digita números;
 *  - sem evidência suficiente, a resposta correta é pedir uma verificação, não inventar um ajuste.
 */

// Vocabulários fechados do motor de diagnóstico, repetidos aqui de propósito: este módulo não importa a base de conhecimento (só o adaptador faz isso).
export const symptomSchema = z.enum(['embolado', 'estridente', 'abafado', 'magro', 'desequilibrio', 'microfonia', 'sibilancia', 'clip', 'ruido', 'monitoracao', 'ganho', 'processamento']);
export const instrumentSchema = z.enum(['cavaco', 'violao', 'surdo', 'tanta', 'pandeiro', 'vozes']);

// ───────── parâmetros: espelham o registro real (core/params.ts), nada além dele
export const parameterKind = z.enum(['level_main', 'level_aux1', 'eq_band_gain', 'eq_band_freq', 'eq_band_q', 'hpf_freq', 'hpf_slope', 'eq_bypass']);
export type ParameterKind = z.infer<typeof parameterKind>;
/** Conceitos que um técnico poderia pedir mas que o MixAI NÃO representa hoje. Só aparecem em recusas, nunca em ajustes. */
export const unsupportedParameter = z.enum(['input_gain', 'compressor', 'gate', 'phantom', 'de_esser', 'afs']);
export type UnsupportedParameter = z.infer<typeof unsupportedParameter>;

export const parameterSchema = z.strictObject({ kind: parameterKind, band: z.number().int().min(1).max(4).optional() }).superRefine((p, c) => {
  const banded = p.kind.startsWith('eq_band_');
  if (banded && p.band === undefined) c.addIssue({ code: 'custom', message: 'Parâmetro de banda exige a banda.' });
  if (!banded && p.band !== undefined) c.addIssue({ code: 'custom', message: 'Somente parâmetros de banda têm banda.' });
});
export type Parameter = z.infer<typeof parameterSchema>;

export interface ParameterRule {
  unit: 'dB' | 'Hz' | 'Q' | 'dB/oct' | 'bool';
  min?: number; max?: number; allowed?: readonly number[];
  /** Existe na biblioteca da mesa e o MixAI já o envia (hoje só nível). EQ/HPF são simulados no LAB. */
  capability: 'library_verified' | 'simulated_only';
  /** O servidor consegue LER o valor atual (nível/mute). EQ/HPF não são observados: só o operador informa. */
  observable: boolean;
  /** O núcleo D (v1) aceita este parâmetro como item de plano: somente `level_delta` de ±3 dB. */
  draftableInD: boolean;
}
export const PARAMETER_RULES: Readonly<Record<ParameterKind, ParameterRule>> = {
  level_main: { unit: 'dB', max: LIMITS.level.max, capability: 'library_verified', observable: true, draftableInD: true },
  level_aux1: { unit: 'dB', max: LIMITS.level.max, capability: 'library_verified', observable: true, draftableInD: true },
  eq_band_gain: { unit: 'dB', ...LIMITS.eqGain, capability: 'simulated_only', observable: false, draftableInD: false },
  eq_band_freq: { unit: 'Hz', ...LIMITS.eqFreq, capability: 'simulated_only', observable: false, draftableInD: false },
  eq_band_q: { unit: 'Q', ...LIMITS.eqQ, capability: 'simulated_only', observable: false, draftableInD: false },
  hpf_freq: { unit: 'Hz', ...LIMITS.hpfFreq, capability: 'simulated_only', observable: false, draftableInD: false },
  hpf_slope: { unit: 'dB/oct', allowed: LIMITS.hpfSlopes, capability: 'simulated_only', observable: false, draftableInD: false },
  eq_bypass: { unit: 'bool', capability: 'simulated_only', observable: false, draftableInD: false },
};
/** Limite do núcleo D para um passo de nível (contracts.ts do D: −3…+3 dB, não nulo). */
export const D_LEVEL_STEP = { min: -3, max: 3 } as const;

// ───────── proveniência do valor
const num = z.number().finite();
const unit = z.enum(['dB', 'Hz', 'Q', 'dB/oct', 'bool']);
const valueOf = z.union([num, z.boolean(), z.literal('-inf')]);
export const observedValue = z.strictObject({ provenance: z.literal('observed'), value: valueOf, unit, revision: z.number().int().nonnegative(), origin: z.literal('lab_state') });
export const operatorReportedValue = z.strictObject({ provenance: z.literal('operator_reported'), value: valueOf, unit, reportId: Id });
export const unknownValue = z.strictObject({ provenance: z.literal('unknown'), reason: z.enum(['not_observable', 'not_reported', 'lab_state_unavailable']) });
export const aiSuggestedValue = z.strictObject({
  provenance: z.literal('ai_suggested'), mode: z.enum(['delta', 'absolute']), value: num, unit,
  basis: z.literal('editorial_trial'), knowledgeId: z.string().min(3).max(80), validation: z.literal('unvalidated'),
});
/** Valor atual: nunca "sugerido pela IA". */
export const currentValue = z.discriminatedUnion('provenance', [observedValue, operatorReportedValue, unknownValue]);
export type CurrentValue = z.infer<typeof currentValue>;
export type AiSuggestedValue = z.infer<typeof aiSuggestedValue>;
export const isKnown = (v: CurrentValue): v is Exclude<CurrentValue, { provenance: 'unknown' }> => v.provenance !== 'unknown';

// ───────── evidência e conhecimento
export const evidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operator_report'), id: Id, symptom: symptomSchema }),
  z.strictObject({ kind: z.literal('musician_report'), id: Id, symptom: symptomSchema, verified: z.literal(false) }),
  /** Estado de controle lido pelo servidor (nível/mute). Não é áudio. */
  z.strictObject({ kind: z.literal('lab_observation'), parameter: z.enum(['level_main', 'level_aux1']), revision: z.number().int().nonnegative(), audio: z.literal(false) }),
  z.strictObject({ kind: z.literal('knowledge'), knowledgeId: z.string().min(3).max(80) }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;
export const knowledgeRef = z.strictObject({
  id: z.string().min(3).max(80), sourceId: z.string().min(2).max(40), locator: Text, version: z.string().min(1).max(120),
  consultedOn: z.iso.date(), validationStatus: z.enum(['editorial_unvalidated', 'theory']),
});
export type KnowledgeRef = z.infer<typeof knowledgeRef>;
/** O que falta saber. Vocabulário fechado: a IA pede UMA verificação desta lista. */
export const missingInfo = z.enum(['current_value', 'listening_comparison', 'isolation_check', 'capture_check', 'hpf_state', 'band_frequency', 'level_reading', 'role_confirmation']);
export type MissingInfo = z.infer<typeof missingInfo>;
export const uncertainty = z.strictObject({
  /** Nunca "baixa": nada aqui foi medido nem ouvido pelo sistema. */
  level: z.enum(['medium', 'high', 'very_high']), reasons: z.array(Text).min(1).max(6), missing: z.array(missingInfo).max(8),
});

// ───────── resultado (3 formas)
const flags = {
  schemaVersion: z.literal(1), scope: z.literal('lab_simulation'),
  authorization: z.literal('not_granted'), execution: z.literal('not_executable'), realWrites: z.literal(false),
  requiresHumanReview: z.literal(true), measurements: z.literal('unavailable'),
};
const requirement = z.strictObject({ parameter: parameterSchema, equals: num, current: currentValue });
const binding = z.strictObject({ serverId: Id, stateRevision: z.number().int().nonnegative(), contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export const adjustmentSchema = z.strictObject({
  ...flags, kind: z.literal('adjustment'), id: Id,
  channel: z.number().int().min(1).max(12), destination: Scope, parameter: parameterSchema,
  current: currentValue, proposed: aiSuggestedValue,
  /** Valores de OUTROS parâmetros que precisam estar assim para a mudança significar o que a justificativa diz (ex.: frequência da banda). */
  requires: z.array(requirement).max(3),
  rationale: Text, evidence: z.array(evidenceSchema).min(2).max(8), knowledge: z.array(knowledgeRef).min(1).max(4),
  risks: z.array(Text).min(1).max(6), preconditions: z.array(Text).min(1).max(6),
  verification: Text, stopConditions: z.array(Text).min(1).max(6),
  rollback: z.strictObject({ automatic: z.literal(false), previous: currentValue, instruction: Text }),
  uncertainty, binding,
}).superRefine((a, c) => {
  const rule = PARAMETER_RULES[a.parameter.kind], p = a.proposed;
  const bad = (message: string) => c.addIssue({ code: 'custom', message });
  if (p.unit !== rule.unit) bad('Unidade diverge do parâmetro.');
  if (!isKnown(a.current)) bad('Ajuste exige valor atual conhecido (observado ou informado); sem ele a resposta é um pedido de verificação.');
  if (a.rollback.previous.provenance !== a.current.provenance || JSON.stringify(a.rollback.previous) !== JSON.stringify(a.current)) bad('A reversão deve apontar para o valor atual registrado.');
  if (!a.evidence.some(e => e.kind === 'operator_report' || e.kind === 'musician_report')) bad('Falta relato humano.');
  if (!a.evidence.some(e => e.kind === 'knowledge')) bad('Falta conhecimento citado.');
  const cited = new Set(a.knowledge.map(k => k.id));
  for (const e of a.evidence) if (e.kind === 'knowledge' && !cited.has(e.knowledgeId)) bad('Evidência cita conhecimento ausente da lista.');
  if (!cited.has(p.knowledgeId)) bad('Valor sugerido sem fonte listada.');
  if (a.uncertainty.level === 'medium' && a.uncertainty.missing.length) bad('Incerteza média não pode ter informação faltando.');
  if (a.parameter.kind === 'level_main' || a.parameter.kind === 'level_aux1') {
    if (a.parameter.kind === 'level_main' !== (a.destination === 'PA')) bad('Destino diverge do parâmetro de nível.');
    if (p.mode !== 'delta' || p.value === 0 || p.value < D_LEVEL_STEP.min || p.value > D_LEVEL_STEP.max) bad('Nível: passo relativo não nulo de −3 a +3 dB.');
    if (a.current.provenance === 'observed' && typeof a.current.value === 'number' && a.current.value + p.value > (rule.max ?? 10)) bad('O passo ultrapassa o máximo do fader.');
    if (a.current.provenance !== 'observed') bad('Nível atual deve ser observado no estado LAB.');
  } else {
    if (p.mode !== 'absolute') bad('EQ/HPF: valor absoluto.');
    if (rule.min !== undefined && p.value < rule.min || rule.max !== undefined && p.value > rule.max) bad('Valor fora dos limites do parâmetro.');
    if (rule.allowed && !rule.allowed.includes(p.value)) bad('Valor não permitido para o parâmetro.');
    if (a.current.provenance === 'observed') bad('EQ/HPF não são observados pelo servidor; o valor atual vem do operador.');
    if (a.current.provenance === 'operator_reported' && a.current.value === p.value) bad('Sugestão igual ao valor atual.');
  }
  for (const r of a.requires) if (!isKnown(r.current)) bad('Pré-requisito sem valor atual conhecido.');
});
export type Adjustment = z.infer<typeof adjustmentSchema>;

export const verificationRequestSchema = z.strictObject({
  ...flags, kind: z.literal('verification_request'), id: Id,
  channel: z.number().int().min(1).max(12), destination: Scope, reason: missingInfo,
  request: Text, why: Text, knowledge: z.array(knowledgeRef).min(1).max(4),
  stopConditions: z.array(Text).min(1).max(6), uncertainty,
});
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;
export const refusalSchema = z.strictObject({
  ...flags, kind: z.literal('refusal'),
  reason: z.enum(['safety_stop', 'unsupported_parameter', 'insufficient_evidence', 'invalid_model_output', 'no_candidate']),
  unsupported: unsupportedParameter.optional(), message: Text,
});
export const recommendationSchema = z.discriminatedUnion('kind', [adjustmentSchema, verificationRequestSchema, refusalSchema]);
export type Recommendation = z.infer<typeof recommendationSchema>;

// ───────── o que um modelo de IA pode devolver: escolher, nunca digitar
export const modelSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('select'), candidate: z.string().regex(/^c[1-4]$/) }),
  z.strictObject({ kind: z.literal('abstain'), reason: z.enum(['insufficient_evidence', 'needs_verification', 'unsafe']), verification: z.string().regex(/^v[1-3]$/).optional() }),
]);
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** Entrada TIPADA: nada de texto livre do operador; o relato chega classificado, como no planejador C. */
export const recommendationInputSchema = z.strictObject({
  mode: z.literal('LAB'), serverId: Id, stateRevision: z.number().int().nonnegative(),
  channel: z.number().int().min(1).max(12), instrument: instrumentSchema, role: z.enum(['lead', 'backing', 'instrument', 'unknown']),
  destination: Scope, symptom: symptomSchema,
  report: z.strictObject({ id: Id, kind: z.enum(['operator_report', 'musician_report']), symptom: symptomSchema }),
  isolation: z.enum(['alone', 'ensemble', 'unknown']).optional(), comparison: z.enum(['target_only', 'both', 'unknown']).optional(),
  feedback: z.enum(['active', 'contained', 'unknown']).optional(),
  /** Confirmações do operador (checkboxes), sempre declaradas — nunca inferidas. */
  confirmed: z.strictObject({ capture: z.boolean().optional(), role: z.boolean().optional() }).optional(),
  /** Nível lido do estado LAB pelo servidor (nunca pelo cliente). */
  observedLevel: z.strictObject({ value: z.union([num, z.literal('-inf')]), revision: z.number().int().nonnegative() }).optional(),
  /** Valores de EQ/HPF que o OPERADOR leu na interface oficial da mesa. */
  operatorEq: z.array(z.strictObject({ parameter: parameterSchema, value: num, reportId: Id })).max(8).optional(),
  /** Pedido explícito de um conceito sem suporte (ex.: "comprime o surdo"). */
  requested: unsupportedParameter.optional(),
});
export type RecommendationInput = z.infer<typeof recommendationInputSchema>;
