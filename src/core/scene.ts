import { z } from 'zod';
import type { ChannelMap } from './channels.js';
import type { ParamRegistry, ParamSpec } from './params.js';
import { asParamKey, parseKey, sameValue, type ParamKey, type ParamValue } from './revisions.js';
import { decodeValue, encodeValue } from './state.js';
import type { MixerCapabilities } from '../mixer/types.js';

/**
 * CENAS DO MIXAI (E5). Uma cena do MixAI NÃO é um snapshot nativo da Soundcraft: é um arquivo
 * do MixAI com ParamKey → valor, o perfil do equipamento e o status de cada parâmetro, pronto
 * para comparação e — só no LABORATÓRIO, com aprovação humana — carregamento.
 *
 * Formato (schemaVersion 2), um arquivo por cena em data/scenes/<id>.json:
 *  - valores especiais: −∞ é gravado como "-inf" (JSON não tem Infinity; nada se perde);
 *  - status por parâmetro, para a futura comparação com a Ui16 real (D9):
 *    compatible (validado na mesa física) · incompatible (não existe/não é enviado à mesa real) ·
 *    unknown (existe na biblioteca, ainda não validado na mesa física).
 */
export const SCENE_SCHEMA_VERSION = 2;
export const SCENE_KIND = 'mixai-scene';
export const MAX_SCENE_PARAMS = 2000;

const EncodedValue = z.union([z.number(), z.boolean(), z.literal('-inf')]);
export const ParamCompatSchema = z.enum(['compatible', 'incompatible', 'unknown']);
export type ParamCompat = z.infer<typeof ParamCompatSchema>;

export const DeviceProfileSchema = z
  .object({
    model: z.string().regex(/^[a-z0-9-]{2,20}$/, 'modelo inválido'),
    inputs: z.number().int().min(1).max(64),
    aux: z.number().int().min(1).max(32),
  })
  .strict();
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

export const SceneNameSchema = z
  .string()
  .trim()
  .min(1, 'o nome não pode ficar vazio')
  .max(60, 'nome com mais de 60 caracteres')
  .refine((s) => !/[\u0000-\u001f]/.test(s), 'nome com caracteres de controle');
export const SceneDescriptionSchema = z.string().trim().max(500, 'descrição com mais de 500 caracteres');
export const SceneIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'identificador inválido');

export const SceneSchema = z
  .object({
    schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
    kind: z.literal(SCENE_KIND),
    id: SceneIdSchema,
    name: SceneNameSchema,
    description: SceneDescriptionSchema.default(''),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deviceProfile: DeviceProfileSchema,
    /** UNVERIFIED = só no laboratório; VALIDATED_IN_REHEARSAL = ouvida num ensaio. */
    validationStatus: z.enum(['UNVERIFIED', 'VALIDATED_IN_REHEARSAL']).default('UNVERIFIED'),
    /** De onde veio (informativo). */
    source: z
      .object({ mode: z.enum(['lab', 'mock', 'real', 'import']), app: z.string().max(60) })
      .partial()
      .strict()
      .optional(),
    params: z
      .record(z.string().max(64), z.object({ value: EncodedValue, status: ParamCompatSchema.default('unknown') }).strict())
      .refine((p) => Object.keys(p).length <= MAX_SCENE_PARAMS, `mais de ${MAX_SCENE_PARAMS} parâmetros`),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

/** Status de compatibilidade de um parâmetro com a mesa REAL (pela capacidade registrada). */
export function compatOf(spec: ParamSpec | undefined): ParamCompat {
  if (!spec || spec.capability === 'simulated_only' || !spec.applicableToMixer) return 'incompatible';
  return spec.capability === 'hardware_verified' ? 'compatible' : 'unknown';
}

export function deviceProfileOf(caps: MixerCapabilities): DeviceProfile {
  return { model: caps.model, inputs: caps.inputs, aux: caps.aux };
}

export interface SceneValidation {
  ok: boolean;
  /** Código estável do primeiro problema (para a tela e os testes). */
  code?: 'INVALID_JSON' | 'SCHEMA_VERSION' | 'INVALID' | 'DEVICE_MISMATCH';
  errors: string[];
  /** Avisos que não impedem guardar (ex.: chaves de outro tamanho de mesa). */
  warnings: string[];
  /** Chaves que não existem neste perfil de mesa (preservadas, nunca aplicadas). */
  unknownKeys: string[];
  values: Map<ParamKey, ParamValue>;
  scene?: Scene;
}

const fail = (code: SceneValidation['code'], errors: string[]): SceneValidation => ({ ok: false, code, errors, warnings: [], unknownKeys: [], values: new Map() });

/**
 * Valida uma cena (objeto ou texto JSON) contra o registro de parâmetros e o perfil da mesa.
 * Nunca aplica nada: só diz se é válida e devolve os valores decodificados.
 */
export function validateScene(raw: unknown, registry: ParamRegistry, device: DeviceProfile): SceneValidation {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return fail('INVALID_JSON', [`o arquivo não é um JSON válido (${(err as Error).message})`]);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('INVALID', ['esperado um objeto JSON de cena do MixAI']);
  const head = data as { kind?: unknown; schemaVersion?: unknown };
  if (head.kind !== SCENE_KIND) {
    return fail('INVALID', ['este arquivo não é uma cena do MixAI (kind diferente de "mixai-scene"). Snapshots nativos da Soundcraft não são importados aqui.']);
  }
  if (head.schemaVersion !== SCENE_SCHEMA_VERSION) {
    const v = head.schemaVersion;
    const why =
      typeof v === 'number' && v > SCENE_SCHEMA_VERSION
        ? `foi criada por uma versão mais nova do MixAI (formato ${v}); atualize o MixAI para importá-la`
        : `formato ${JSON.stringify(v)} não é suportado (esperado ${SCENE_SCHEMA_VERSION})`;
    return fail('SCHEMA_VERSION', [`versão de formato incompatível: a cena ${why}.`]);
  }
  const parsed = SceneSchema.safeParse(data);
  if (!parsed.success) return fail('INVALID', parsed.error.issues.map((i) => `${i.path.join('.') || 'cena'}: ${i.message}`));
  const scene = parsed.data;

  if (scene.deviceProfile.model !== device.model) {
    return {
      ...fail('DEVICE_MISMATCH', [
        `equipamento incompatível: a cena é de uma Soundcraft ${scene.deviceProfile.model.toUpperCase()} e este MixAI controla uma ${device.model.toUpperCase()}.`,
      ]),
      scene,
    };
  }
  const warnings: string[] = [];
  if (scene.deviceProfile.inputs !== device.inputs || scene.deviceProfile.aux !== device.aux) {
    warnings.push(
      `a cena foi salva com ${scene.deviceProfile.inputs} entradas e ${scene.deviceProfile.aux} AUX; esta mesa tem ${device.inputs} e ${device.aux}. Parâmetros que não existem aqui ficam guardados e não são aplicados.`,
    );
  }
  const errors: string[] = [];
  const unknownKeys: string[] = [];
  const values = new Map<ParamKey, ParamValue>();
  for (const [text, entry] of Object.entries(scene.params)) {
    const key = asParamKey(text);
    if (!key) {
      errors.push(`${text}: identificador de parâmetro inválido`);
      continue;
    }
    if (!registry.has(key)) {
      unknownKeys.push(text);
      continue;
    }
    const value = decodeValue(entry.value);
    const problem = value === undefined ? `${text}: valor inválido` : registry.validate(key, value);
    if (problem) errors.push(problem);
    else values.set(key, value as ParamValue);
  }
  if (errors.length) return { ok: false, code: 'INVALID', errors, warnings, unknownKeys, values: new Map(), scene };
  if (unknownKeys.length) warnings.push(`${unknownKeys.length} parâmetro(s) não existem nesta mesa e não serão aplicados.`);
  return { ok: true, errors, warnings, unknownKeys, values, scene };
}

/** Monta uma cena (sempre com o status de cada parâmetro calculado pelo registro). */
export function buildScene(input: {
  id: string;
  name: string;
  description?: string;
  device: DeviceProfile;
  values: Map<ParamKey, ParamValue>;
  registry: ParamRegistry;
  now?: Date;
  createdAt?: Date;
  source?: Scene['source'];
}): Scene {
  const now = (input.now ?? new Date()).toISOString();
  const params: Scene['params'] = {};
  for (const [k, v] of [...input.values].sort(([a], [b]) => a.localeCompare(b))) {
    params[k] = { value: encodeValue(v), status: compatOf(input.registry.get(k)) };
  }
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    kind: SCENE_KIND,
    id: input.id,
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    createdAt: (input.createdAt ?? input.now ?? new Date()).toISOString(),
    updatedAt: now,
    deviceProfile: input.device,
    validationStatus: 'UNVERIFIED',
    source: input.source,
    params,
  };
}

/** Valores decodificados de uma cena já validada contra o registro (chaves desconhecidas fora). */
export function sceneValues(scene: Scene, registry: ParamRegistry): Map<ParamKey, ParamValue> {
  const out = new Map<ParamKey, ParamValue>();
  for (const [text, entry] of Object.entries(scene.params)) {
    const key = asParamKey(text);
    const value = decodeValue(entry.value);
    if (key && registry.has(key) && value !== undefined) out.set(key, value);
  }
  return out;
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

// ---------- comparação para a tela (E5) ----------

export type SceneGroup = 'PA' | 'FONES' | 'MASTER' | 'OUTROS';
export type SceneChangeKind = 'level' | 'mute' | 'other';

export interface SceneDiffRow {
  key: ParamKey;
  group: SceneGroup;
  /** Nome do canal (channels.yaml) ou "CH n"; "MASTER" para o master. */
  channel: string;
  /** PA, FONES (AUX dos músicos), AUX n, MASTER, EQ, HPF. */
  destination: string;
  kind: SceneChangeKind;
  /** Valores codificados ("-inf" para −∞; null = desconhecido). */
  current: number | boolean | '-inf' | null;
  target: number | boolean | '-inf';
  /** Diferença em dB (volumes finitos); null = não se aplica (mute, −∞). */
  deltaDB: number | null;
  /** Vai ser aplicado ao carregar no LAB. false = só mostrado (ver reason). */
  applicable: boolean;
  reason?: string;
  /** Valor da cena limitado ao teto de segurança (o que será de fato aplicado). */
  clampedTo?: number;
  compat: ParamCompat;
}

export interface SceneDiff {
  rows: SceneDiffRow[];
  totals: { changes: number; applicable: number; notApplicable: number; byGroup: Record<SceneGroup, number> };
}

export interface DiffContext {
  registry: ParamRegistry;
  names: ChannelMap;
  musicianAux: number;
  /** Tetos de segurança (safety). */
  ceilings: { channel: number; aux: number; master: number };
  read: (key: ParamKey) => ParamValue | undefined;
}

export interface ParamClass {
  group: SceneGroup;
  channel: string;
  destination: string;
  kind: SceneChangeKind;
  /** Aplicável ao carregar no LAB nesta etapa. */
  applicable: boolean;
  reason?: string;
  /** Teto de segurança do volume (dB), para parâmetros de nível. */
  ceiling?: number;
}

/**
 * Classifica um parâmetro para a tela e para o carregamento. Aplicáveis no LAB nesta etapa:
 * volume e mute dos canais e AUX cadastrados no channels.yaml, e o master. EQ/HPF/bypass
 * ficam guardados na cena e aparecem como "ainda não aplicável" (sem caminho de escrita novo).
 */
export function classifyParam(key: ParamKey, ctx: Omit<DiffContext, 'read'>): ParamClass | undefined {
  const spec = ctx.registry.get(key);
  if (!spec) return undefined;
  const p = parseKey(key);
  if (p.kind === 'master') return { group: 'MASTER', channel: 'MASTER', destination: 'MASTER', kind: 'level', applicable: true, ceiling: ctx.ceilings.master };
  const ch = ctx.names.inputs.list().find((c) => c.number === p.channel);
  const out: ParamClass = { group: 'OUTROS', channel: ch?.name ?? `CH ${p.channel}`, destination: 'EQ', kind: 'other', applicable: !!ch };
  if (!ch) out.reason = 'canal fora do channels.yaml';
  if (p.kind === 'channel') {
    out.kind = p.param;
    if (p.aux === undefined) {
      out.group = 'PA';
      out.destination = 'PA';
      out.ceiling = ctx.ceilings.channel;
    } else {
      const aux = ctx.names.aux.list().find((a) => a.number === p.aux);
      const fones = p.aux === ctx.musicianAux;
      out.group = fones ? 'FONES' : 'OUTROS';
      out.destination = fones ? 'FONES' : (aux?.name ?? `AUX ${p.aux}`);
      out.ceiling = ctx.ceilings.aux;
      if (!aux && out.applicable) {
        out.applicable = false;
        out.reason = 'AUX fora do channels.yaml';
      }
    }
  } else {
    out.destination = p.kind === 'hpf' ? 'HPF' : 'EQ';
    out.applicable = false;
    out.reason = 'EQ/HPF: guardado na cena, ainda não aplicável';
  }
  if (spec.capability === 'simulated_only' && out.applicable) {
    out.applicable = false;
    out.reason = 'parâmetro só do laboratório';
  }
  return out;
}

/** Valor que será de fato aplicado: volume acima do teto de segurança é limitado ao teto. */
export function safeTarget(value: ParamValue, cls: ParamClass): { value: ParamValue; clampedTo?: number } {
  if (cls.kind === 'level' && typeof value === 'number' && cls.ceiling !== undefined && value > cls.ceiling) {
    return { value: cls.ceiling, clampedTo: cls.ceiling };
  }
  return { value };
}

/** Parâmetros que um carregamento aplicaria (todos os aplicáveis da cena, já com os tetos). */
export function loadTargets(target: Map<ParamKey, ParamValue>, ctx: Omit<DiffContext, 'read'>): Array<{ key: ParamKey; label: string; to: ParamValue }> {
  const out: Array<{ key: ParamKey; label: string; to: ParamValue }> = [];
  for (const [key, raw] of target) {
    const cls = classifyParam(key, ctx);
    if (!cls?.applicable) continue;
    out.push({ key, label: cls.group === 'MASTER' ? 'MASTER' : `${cls.channel} ${cls.destination}${cls.kind === 'mute' ? ' (mute)' : ''}`, to: safeTarget(raw, cls).value });
  }
  return out;
}

/** Ordem estável: PA, FONES, MASTER, OUTROS; dentro, por canal. */
const GROUP_ORDER: Record<SceneGroup, number> = { PA: 0, FONES: 1, MASTER: 2, OUTROS: 3 };

function sortRows<T extends { group: SceneGroup; key: ParamKey }>(rows: T[]): T[] {
  return rows.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || channelNo(a.key) - channelNo(b.key) || a.key.localeCompare(b.key));
}

/**
 * Compara a cena com o estado atual e devolve SÓ o que difere, com o que será aplicado.
 * Não aplica nada.
 */
export function sceneDiff(target: Map<ParamKey, ParamValue>, ctx: DiffContext): SceneDiff {
  const rows: SceneDiffRow[] = [];
  for (const [key, raw] of target) {
    const cls = classifyParam(key, ctx);
    if (!cls) continue;
    const { value: t, clampedTo } = safeTarget(raw, cls);
    const c = ctx.read(key);
    if (c !== undefined && sameValue(c, t)) continue; // só o que realmente difere
    let { applicable, reason } = cls;
    if (c === undefined && applicable) {
      applicable = false;
      reason = 'valor atual desconhecido';
    }
    const finite = (v: ParamValue | undefined) => typeof v === 'number' && Number.isFinite(v);
    rows.push({
      key,
      group: cls.group,
      channel: cls.channel,
      destination: cls.destination,
      kind: cls.kind,
      current: c === undefined ? null : encodeValue(c),
      target: encodeValue(raw),
      deltaDB: cls.kind === 'level' && finite(c) && finite(t) ? Math.round(((t as number) - (c as number)) * 2) / 2 : null,
      applicable,
      reason,
      clampedTo,
      compat: compatOf(ctx.registry.get(key)),
    });
  }
  sortRows(rows);
  const byGroup: Record<SceneGroup, number> = { PA: 0, FONES: 0, MASTER: 0, OUTROS: 0 };
  for (const r of rows) byGroup[r.group]++;
  const applicable = rows.filter((r) => r.applicable).length;
  return { rows, totals: { changes: rows.length, applicable, notApplicable: rows.length - applicable, byGroup } };
}

export interface SceneViewRow {
  key: ParamKey;
  group: SceneGroup;
  channel: string;
  destination: string;
  kind: SceneChangeKind;
  value: number | boolean | '-inf';
  applicable: boolean;
  reason?: string;
  compat: ParamCompat;
}

/** Parâmetros guardados na cena, organizados para a tela ("ver a cena"). */
export function sceneView(scene: Scene, ctx: Omit<DiffContext, 'read'>): { rows: SceneViewRow[]; unknownKeys: string[] } {
  const rows: SceneViewRow[] = [];
  const unknownKeys: string[] = [];
  for (const [text, entry] of Object.entries(scene.params)) {
    const key = asParamKey(text);
    const cls = key ? classifyParam(key, ctx) : undefined;
    if (!key || !cls) {
      unknownKeys.push(text);
      continue;
    }
    rows.push({ key, group: cls.group, channel: cls.channel, destination: cls.destination, kind: cls.kind, value: entry.value, applicable: cls.applicable, reason: cls.reason, compat: entry.status });
  }
  return { rows: sortRows(rows), unknownKeys };
}

function channelNo(key: ParamKey): number {
  const m = /^ch\.(\d+)\./.exec(key);
  return m ? Number(m[1]) : 0;
}
