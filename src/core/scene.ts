import { z } from 'zod';
import type { ParamRegistry } from './params.js';
import { asParamKey, sameValue, type ParamKey, type ParamValue } from './revisions.js';
import { decodeValue, encodeValue } from './state.js';

/**
 * ESTRUTURA de cenas do MixAI (E1). Ainda sem tela, armazenamento ou tools: isso é a E5.
 * Uma "cena do MixAI" NÃO é um snapshot nativo da Ui16: é um conjunto ParamKey → valor,
 * com o perfil do equipamento e o status de validação, pronto para comparação e, no futuro,
 * aplicação item a item com autorização humana (D9).
 */
export const SCENE_SCHEMA_VERSION = 1;

export const SceneSchema = z.object({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  kind: z.literal('mixai-scene'),
  id: z.string().min(1),
  name: z.string().min(1),
  deviceProfile: z.string(),
  /** UNVERIFIED = só no laboratório; VALIDATED_IN_REHEARSAL = ouvida num ensaio. */
  validationStatus: z.enum(['UNVERIFIED', 'VALIDATED_IN_REHEARSAL']).default('UNVERIFIED'),
  createdAt: z.string(),
  notes: z.string().default(''),
  values: z.record(z.string(), z.union([z.number(), z.boolean(), z.literal('-inf')])),
});
export type Scene = z.infer<typeof SceneSchema>;

export interface SceneValidation {
  ok: boolean;
  errors: string[];
  /** Chaves que não existem neste perfil de mesa (ignoradas). */
  unknownKeys: string[];
  values: Map<ParamKey, ParamValue>;
}

/** Valida uma cena contra o registro de parâmetros (tipos, faixas, perfil). */
export function validateScene(raw: unknown, registry: ParamRegistry, deviceProfile: string): SceneValidation {
  const errors: string[] = [];
  const unknownKeys: string[] = [];
  const values = new Map<ParamKey, ParamValue>();
  const parsed = SceneSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), unknownKeys, values };
  }
  if (parsed.data.deviceProfile !== deviceProfile) {
    errors.push(`perfil de mesa diferente (${parsed.data.deviceProfile}, esperado ${deviceProfile})`);
  }
  for (const [text, encoded] of Object.entries(parsed.data.values)) {
    const key = asParamKey(text);
    if (!key || !registry.has(key)) {
      unknownKeys.push(text);
      continue;
    }
    const value = decodeValue(encoded);
    const problem = value === undefined ? `${text}: valor inválido` : registry.validate(key, value);
    if (problem) errors.push(problem);
    else values.set(key, value as ParamValue);
  }
  return { ok: !errors.length, errors, unknownKeys, values };
}

export function buildScene(input: {
  id: string;
  name: string;
  deviceProfile: string;
  values: Map<ParamKey, ParamValue>;
  createdAt?: Date;
  notes?: string;
}): Scene {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    kind: 'mixai-scene',
    id: input.id,
    name: input.name,
    deviceProfile: input.deviceProfile,
    validationStatus: 'UNVERIFIED',
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    notes: input.notes ?? '',
    values: Object.fromEntries([...input.values].map(([k, v]) => [k, encodeValue(v)])),
  };
}

export type DiffKind = 'equal' | 'different' | 'unknown_in_current';

export interface DiffItem {
  key: ParamKey;
  kind: DiffKind;
  current?: ParamValue;
  target?: ParamValue;
  /** Pode ser aplicado na mesa real no futuro (false = só laboratório, ex.: EQ hoje). */
  applicableToMixer: boolean;
}

/**
 * Diferença genérica entre o estado atual e um alvo (cena). Base para comparação de cenas,
 * comparação LAB × REAL (somente leitura) e, no futuro, aplicação item a item.
 * Não aplica nada.
 */
export function diffValues(
  current: (key: ParamKey) => ParamValue | undefined,
  target: Map<ParamKey, ParamValue>,
  registry: ParamRegistry,
): DiffItem[] {
  const out: DiffItem[] = [];
  for (const [key, t] of target) {
    const spec = registry.get(key);
    if (!spec) continue;
    const c = current(key);
    const kind: DiffKind = c === undefined ? 'unknown_in_current' : sameValue(c, t) ? 'equal' : 'different';
    out.push({ key, kind, current: c, target: t, applicableToMixer: spec.applicableToMixer });
  }
  return out;
}
