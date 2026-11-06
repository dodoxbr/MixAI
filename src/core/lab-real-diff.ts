import { z } from 'zod';
import { ParamRegistry, type Capability } from './params.js';
import { asParamKey, parseKey, type ParamKey } from './revisions.js';
import { DeviceProfileSchema, SceneSchema, diffValues, type DeviceProfile, type Scene } from './scene.js';
import { decodeValue, encodeValue, snapshotToWire, type MixerStateSnapshot, type WireStateValue } from './state.js';
import type { LinkState } from '../mixer/types.js';

export type Support = 'supported' | 'unsupported' | 'unknown';
export type PortraitOrigin = 'lab_scene' | 'lab_state' | 'fixture' | 'fake_socket' | 'real_readonly';
export interface ComparisonParam {
  value: WireStateValue;
  revision: number | null;
  /** Declaração do produtor, nunca inferida da quantidade de AUX no perfil. */
  support: Support;
}
export interface ComparisonPortrait {
  mode: 'lab' | 'mock' | 'real';
  device: DeviceProfile;
  origin: PortraitOrigin;
  capturedAt: string;
  revision: number | null;
  freshness: 'fresh' | 'stale';
  available: boolean;
  link: LinkState;
  params: Record<string, ComparisonParam>;
}
export interface LabRealDiffInput {
  lab: ComparisonPortrait;
  real: ComparisonPortrait;
  /** Relógio explícito: comparação determinística, sem consultar hora/rede/arquivos. */
  comparedAt: string;
  maxAgeMs?: number;
  ceilings?: { channel: number; aux: number; master: number };
}

const Revision = z.number().int().nonnegative().safe().nullable();
const Key = z.string().max(64).refine((s) => s === s.trim() && !!asParamKey(s));
const Value = z.discriminatedUnion('status', [
  z.object({ status: z.literal('known'), value: z.union([z.number().finite(), z.boolean(), z.literal('-inf')]) }),
  z.object({ status: z.literal('unknown') }), z.object({ status: z.literal('unavailable') }),
]);
const PortraitSchema = z.object({
  mode: z.enum(['lab', 'mock', 'real']), device: DeviceProfileSchema.refine((d) => d.model === d.model.trim()),
  origin: z.enum(['lab_scene', 'lab_state', 'fixture', 'fake_socket', 'real_readonly']),
  capturedAt: z.iso.datetime(), revision: Revision, freshness: z.enum(['fresh', 'stale']),
  available: z.boolean(), link: z.enum(['DISCONNECTED', 'CONNECTING', 'SYNCING', 'DEGRADED_READ_ONLY', 'READY', 'LOST', 'STOPPED']),
  params: z.record(Key, z.object({ value: Value, revision: Revision, support: z.enum(['supported', 'unsupported', 'unknown']) }))
    .refine((p) => Object.keys(p).length <= 2000),
});
const OptionsSchema = z.object({
  comparedAt: z.iso.datetime(), maxAgeMs: z.number().finite().nonnegative().default(30_000),
  ceilings: z.object({ channel: z.number().finite().max(10), aux: z.number().finite().max(10), master: z.number().finite().max(10) })
    .default({ channel: 0, aux: 0, master: 0 }),
});

/** Fronteira tipada/validada; erros não reproduzem conteúdo potencialmente secreto. */
function portrait(raw: ComparisonPortrait): ComparisonPortrait {
  const parsed = PortraitSchema.safeParse(raw);
  if (!parsed.success) throw new Error('E8A_INVALID_PORTRAIT: retrato inválido');
  return parsed.data;
}

/** Adapta uma cena E5 sem alterar seu formato ou confiar no selo de ensaio como prova física. */
export function portraitFromScene(scene: Scene): ComparisonPortrait {
  const parsed = SceneSchema.safeParse(scene);
  if (!parsed.success || parsed.data.source?.mode === 'real') throw new Error('E8A_INVALID_LAB_SCENE');
  const s = parsed.data;
  return portrait({ mode: 'lab', origin: 'lab_scene', device: s.deviceProfile, capturedAt: s.updatedAt,
    revision: null, freshness: 'fresh', available: true, link: 'READY',
    params: Object.fromEntries(Object.entries(s.params).map(([key, p]) => [key, {
      value: { status: 'known', value: p.value }, revision: null,
      support: p.status === 'incompatible' ? 'unsupported' : 'unknown',
    }])),
  });
}

/** Só transforma dados já fornecidos. Não recebe MixerAdapter nem chama connect/read/write. */
export function portraitFromSnapshot(snapshot: MixerStateSnapshot, metadata: {
  device: DeviceProfile; origin: Exclude<PortraitOrigin, 'lab_scene'>; capturedAt: string;
  freshness: 'fresh' | 'stale'; support?: Partial<Record<ParamKey, Support>>;
}): ComparisonPortrait {
  const wire = snapshotToWire(snapshot);
  return portrait({ mode: wire.mode, device: metadata.device, origin: metadata.origin,
    capturedAt: metadata.capturedAt, revision: wire.revision, freshness: metadata.freshness,
    available: wire.available, link: wire.link,
    params: Object.fromEntries(Object.entries(wire.params).map(([key, p]) => [key, {
      value: p.value, revision: p.revision, support: metadata.support?.[key as ParamKey] ?? 'unknown',
    }])),
  });
}

export const COMPARISON_KINDS = ['equal', 'different', 'unknown', 'unsupported', 'device_mismatch', 'missing_in_lab', 'missing_in_real'] as const;
export type ComparisonKind = typeof COMPARISON_KINDS[number];
const explanations = {
  equal: 'MUTE idêntico ou níveis fornecidos iguais com tolerância menor que 0,05 dB.',
  different: 'Valores fornecidos diferentes; nenhuma alteração é proposta ou executada.',
  missing_in_lab: 'Parâmetro ausente do retrato LAB; ausência não é zero.',
  missing_in_real: 'Parâmetro ausente do retrato REAL; ausência não é zero.',
  device_mismatch: 'Modelo ou dimensões dos perfis incompatíveis; comparação de valores bloqueada.',
  unsupported: 'Parâmetro fora do perfil, somente simulado ou declarado não suportado.',
  support_unknown: 'Suporte no retrato REAL não foi declarado; o perfil não prova saídas físicas.',
  stale: 'Retrato vencido ou marcado como stale; valor antigo não é leitura atual.',
  unavailable: 'Retrato/ligação indisponível; valor retido não é leitura atual.',
  unknown: 'Valor ainda desconhecido em pelo menos um retrato.',
  invalid_value: 'Tipo, faixa ou revisão do valor incompatível com o registro/retrato.',
} as const;
export type ComparisonReason = keyof typeof explanations;
export interface ComparisonCell {
  status: 'known' | 'unknown' | 'unavailable' | 'missing' | 'invalid';
  value: number | boolean | '-inf' | null;
  revision: number | null;
}
export interface LabRealDiffRow {
  key: ParamKey;
  kind: ComparisonKind;
  reason: ComparisonReason;
  explanation: string;
  lab: ComparisonCell;
  real: ComparisonCell;
  capability: Capability | 'unregistered';
  deltaDB: number | null;
  ceiling: number | null;
  aboveCeiling: { lab: boolean | null; real: boolean | null };
  applicable: false;
}
export interface LabRealDiffReport {
  schemaVersion: 1;
  kind: 'mixai-lab-real-readonly-diff';
  comparedAt: string;
  maxAgeMs: number;
  applicable: false;
  hardwareVerified: false;
  deviceCompatible: boolean;
  lab: Omit<ComparisonPortrait, 'params'>;
  real: Omit<ComparisonPortrait, 'params'>;
  rows: LabRealDiffRow[];
  totals: Record<ComparisonKind, number>;
}

function cell(p: ComparisonParam | undefined, registry: ParamRegistry, key: ParamKey, globalRevision: number | null): ComparisonCell {
  if (!p) return { status: 'missing', value: null, revision: null };
  if (p.value.status !== 'known') return { status: p.value.status, value: null, revision: p.revision };
  const value = decodeValue(p.value.value);
  if (value === undefined || (registry.has(key) && registry.validate(key, value)) ||
    (globalRevision !== null && p.revision !== null && p.revision > globalRevision)) {
    return { status: 'invalid', value: null, revision: p.revision };
  }
  return { status: 'known', value: encodeValue(value), revision: p.revision };
}
function ageReason(p: ComparisonPortrait, now: number, maxAgeMs: number): ComparisonReason | undefined {
  const age = now - Date.parse(p.capturedAt);
  if (p.freshness === 'stale' || age < 0 || (p.origin !== 'lab_scene' && age > maxAgeMs)) return 'stale';
  if (!p.available || !['READY', 'DEGRADED_READ_ONLY'].includes(p.link)) return 'unavailable';
  return undefined;
}
function metadata(p: ComparisonPortrait): Omit<ComparisonPortrait, 'params'> {
  const { params: _params, ...rest } = p;
  return rest;
}

/** Núcleo puro E8A: retratos fornecidos, união de chaves e nenhuma referência a adaptadores. */
export function compareLabReal(input: LabRealDiffInput): LabRealDiffReport {
  const lab = portrait(input.lab), real = portrait(input.real);
  const options = OptionsSchema.safeParse(input);
  if (!options.success) throw new Error('E8A_INVALID_OPTIONS');
  if (lab.mode === 'real' || !['lab_scene', 'lab_state', 'fixture'].includes(lab.origin) ||
    real.mode !== 'real' || !['fixture', 'fake_socket', 'real_readonly'].includes(real.origin)) throw new Error('E8A_INVALID_ORIGIN');
  const { comparedAt, maxAgeMs, ceilings } = options.data;
  const registry = new ParamRegistry(lab.device);
  const realRegistry = new ParamRegistry(real.device);
  const deviceCompatible = ['ui12', 'ui16', 'ui24'].includes(lab.device.model) &&
    lab.device.model === real.device.model && lab.device.inputs === real.device.inputs && lab.device.aux === real.device.aux;
  const stale = ageReason(lab, Date.parse(comparedAt), maxAgeMs) ?? ageReason(real, Date.parse(comparedAt), maxAgeMs);
  const rows: LabRealDiffRow[] = [];
  const keys = [...new Set([...Object.keys(lab.params), ...Object.keys(real.params)])].sort() as ParamKey[];
  for (const key of keys) {
    const l = lab.params[key], r = real.params[key];
    const spec = registry.get(key);
    const lc = cell(l, registry, key, lab.revision), rc = cell(r, realRegistry, key, real.revision);
    let kind: ComparisonKind, reason: ComparisonReason;
    if (!deviceCompatible) { kind = reason = 'device_mismatch'; }
    else if (!spec || !realRegistry.has(key) || spec.capability === 'simulated_only' || !spec.applicableToMixer ||
      l?.support === 'unsupported' || r?.support === 'unsupported') { kind = reason = 'unsupported'; }
    else if (!l) { kind = reason = 'missing_in_lab'; }
    else if (!r) { kind = reason = 'missing_in_real'; }
    else if (stale) { kind = 'unknown'; reason = stale; }
    else if (lc.status === 'invalid' || rc.status === 'invalid') { kind = 'unknown'; reason = 'invalid_value'; }
    else if (lc.status === 'unavailable' || rc.status === 'unavailable') { kind = 'unknown'; reason = 'unavailable'; }
    else if (lc.status !== 'known' || rc.status !== 'known') { kind = reason = 'unknown'; }
    else if (r.support !== 'supported') { kind = 'unknown'; reason = 'support_unknown'; }
    else {
      // Reutiliza a comparação E5; nunca usa seus loadTargets nem seus caminhos de aplicação.
      const result = diffValues(() => decodeValue(rc.value), new Map([[key, decodeValue(lc.value)!]]), registry)[0]!;
      kind = result.kind === 'equal' ? 'equal' : 'different'; reason = kind;
    }
    const p = parseKey(key);
    const ceiling = spec?.kind !== 'level' ? null : p.kind === 'master' ? ceilings.master : p.kind === 'channel' && p.aux !== undefined ? ceilings.aux : ceilings.channel;
    const comparable = kind === 'equal' || kind === 'different';
    const deltaDB = comparable && typeof lc.value === 'number' && typeof rc.value === 'number' ? Number((lc.value - rc.value).toFixed(6)) : null;
    const above = (c: ComparisonCell) => ceiling === null || c.status !== 'known' ? null : c.value === '-inf' ? false : typeof c.value === 'number' ? c.value > ceiling : null;
    rows.push({ key, kind, reason, explanation: explanations[reason], lab: lc, real: rc,
      capability: spec?.capability ?? 'unregistered', deltaDB, ceiling,
      aboveCeiling: { lab: above(lc), real: above(rc) }, applicable: false });
  }
  const totals = Object.fromEntries(COMPARISON_KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length])) as Record<ComparisonKind, number>;
  return { schemaVersion: 1, kind: 'mixai-lab-real-readonly-diff', comparedAt, maxAgeMs, applicable: false,
    hardwareVerified: false, deviceCompatible, lab: metadata(lab), real: metadata(real), rows, totals };
}

/** Exporta apenas dados reconstruídos/validados; não serializa objetos crus nem segredos. */
export function exportLabRealComparison(input: LabRealDiffInput, format: 'json' | 'markdown' = 'json'): string {
  const report = compareLabReal(input);
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  if (format !== 'markdown') throw new Error('E8A_INVALID_FORMAT');
  const show = (c: ComparisonCell) => c.status === 'known' ? c.value === '-inf' ? '−∞' : String(c.value) : c.status;
  const meta = (p: typeof report.lab) => `${p.origin}; ${p.device.model} (${p.device.inputs} entradas/${p.device.aux} AUX de perfil); revisão ${p.revision ?? 'não disponível'}; ${p.capturedAt}; ${p.freshness}; ${p.link}`;
  return ['# Comparação LAB × REAL — SOMENTE LEITURA', '',
    'Dados fornecidos. Hardware não validado. Nenhum item é aplicável; nenhum comando é gerado.',
    `Comparado em: ${report.comparedAt}; idade máxima: ${report.maxAgeMs} ms.`,
    `LAB: ${meta(report.lab)}`, `REAL: ${meta(report.real)}`,
    `Perfis compatíveis: ${report.deviceCompatible ? 'sim' : 'não'}.`,
    `Totais: ${COMPARISON_KINDS.map((k) => `${k}=${report.totals[k]}`).join(', ')}.`, '',
    '| Parâmetro | LAB (rev.) | REAL (rev.) | Estado | Δ LAB−REAL dB | Teto dB / excedido LAB,REAL | Explicação |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((r) => `| ${r.key} | ${show(r.lab)} (${r.lab.revision ?? '?'}) | ${show(r.real)} (${r.real.revision ?? '?'}) | ${r.kind} | ${r.deltaDB ?? '—'} | ${r.ceiling ?? '—'} / ${r.aboveCeiling.lab ?? '—'},${r.aboveCeiling.real ?? '—'} | ${r.explanation} |`),
    '', 'Checklist: [ ] conferir origem/idade [ ] investigar desconhecidos/incompatíveis [ ] revisar tetos; sem aplicação.', '',
  ].join('\n');
}
