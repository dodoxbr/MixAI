import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { z } from 'zod';

/**
 * Pacote de conhecimento (MixAI_Base_Conhecimento_*): catálogo de fontes, fichas de microfone e
 * casos de diagnóstico teóricos. É DADO, nunca instrução: nada aqui é comando nem autorização.
 */
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const caseId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const catalogEntrySchema = z.strictObject({
  id,
  title: z.string().min(1).max(200),
  url: z.string().max(500).refine((u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } }, 'apenas https'),
  description: z.string().min(1).max(300),
  verifiedOnline: day,
  downloaded: z.boolean(),
});
export const catalogSchema = z.array(catalogEntrySchema).min(1).max(200).superRefine((items, ctx) => {
  if (new Set(items.map((i) => i.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: 'ids de fonte duplicados' });
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const micModelSchema = z.strictObject({
  model: z.string().min(1).max(100),
  pattern: z.enum(['cardioid', 'supercardioid', 'hypercardioid', 'omnidirectional', 'figure8']),
  responseHz: z.tuple([z.number().positive(), z.number().positive()]),
  sensitivityMvPa: z.number().positive(),
  impedanceOhm: z.number().positive(),
  recommendedLoadOhm: z.number().positive(),
  connector: z.string().min(1).max(60),
  sourceId: id,
  status: z.enum(['manufacturer_specification', 'unverified']),
});
export type MicModel = z.infer<typeof micModelSchema>;

export const evidenceKindSchema = z.enum(['operator_report', 'operator_confirmed', 'unconfirmed']);
export const assignmentSchema = z.strictObject({
  musician: z.string().min(1).max(60),
  modelId: id.nullable(),
  role: z.enum(['lead', 'backing', 'instrument']),
  evidence: evidenceKindSchema,
});
export type Assignment = z.infer<typeof assignmentSchema>;

export const micPackSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bandMicModel: z.string().min(1).max(200),
  verifiedModel: id.nullable(),
  candidateModels: z.record(id, micModelSchema),
  channelAssignments: z.record(z.string().regex(/^CH(?:[1-9]|1[0-2])$/), assignmentSchema),
  safety: z.string().min(1).max(600),
  confirmationSource: z.string().min(1).max(60),
}).superRefine((pack, ctx) => {
  const known = new Set(Object.keys(pack.candidateModels));
  if (pack.verifiedModel && !known.has(pack.verifiedModel)) ctx.addIssue({ code: 'custom', message: 'verifiedModel não está em candidateModels' });
  for (const [ch, a] of Object.entries(pack.channelAssignments)) {
    if (a.modelId && !known.has(a.modelId)) ctx.addIssue({ code: 'custom', message: `${ch}: modelo desconhecido` });
    // Modelo de microfone nunca é presumido: sem confirmação do operador, fica sem modelo.
    if (a.evidence === 'unconfirmed' && a.modelId) ctx.addIssue({ code: 'custom', message: `${ch}: modelo sem evidência` });
    if (a.evidence !== 'unconfirmed' && !a.modelId) ctx.addIssue({ code: 'custom', message: `${ch}: evidência sem modelo` });
  }
});
export type MicPack = z.infer<typeof micPackSchema>;

export const casesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  validation: z.string().min(1).max(60),
  measurement: z.literal('unavailable'),
  execution: z.literal('not_executable'),
  cases: z.array(z.strictObject({
    id: caseId,
    title: z.string().min(1).max(120),
    investigation: z.array(z.string().min(1).max(300)).min(1).max(10),
    hypotheses: z.array(z.string().min(1).max(400)).min(1).max(10),
    safety: z.string().min(1).max(300),
    sources: z.array(id).max(10),
  })).min(1).max(50),
});
export type CasesPack = z.infer<typeof casesSchema>;

export interface KnowledgePack { catalog: CatalogEntry[]; microphones: MicPack; cases: CasesPack }

const FILES = { catalog: 'catalog.json', microphones: 'microphone-models.json', cases: 'diagnostic-cases.json' } as const;
const MAX_ENTRY_BYTES = 256 * 1024;

/** Valida o pacote inteiro e os vínculos entre os arquivos. Lança com a lista de problemas. */
export function parsePack(raw: { catalog: unknown; microphones: unknown; cases: unknown }): KnowledgePack {
  const catalog = catalogSchema.parse(raw.catalog);
  const microphones = micPackSchema.parse(raw.microphones);
  const cases = casesSchema.parse(raw.cases);
  const sourceIds = new Set(catalog.map((c) => c.id));
  const problems: string[] = [];
  for (const [mid, m] of Object.entries(microphones.candidateModels)) if (!sourceIds.has(m.sourceId)) problems.push(`modelo ${mid}: fonte ${m.sourceId} fora do catálogo`);
  for (const c of cases.cases) for (const s of c.sources) if (!sourceIds.has(s)) problems.push(`caso ${c.id}: fonte ${s} fora do catálogo`);
  if (problems.length) throw new Error(`Pacote inconsistente: ${problems.join('; ')}`);
  return { catalog, microphones, cases };
}

function parseJson(name: string, text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${name}: JSON inválido`); }
}

/** Lê o pacote de uma pasta com catalog.json, microphone-models.json e diagnostic-cases.json. */
export function readPackFromDir(dir: string): KnowledgePack {
  const read = (file: string) => parseJson(file, readFileSync(join(dir, file), 'utf8'));
  return parsePack({ catalog: read(FILES.catalog), microphones: read(FILES.microphones), cases: read(FILES.cases) });
}

/**
 * Lê o .zip inteiro em MEMÓRIA, só os 3 arquivos esperados (por nome-base), com teto de tamanho.
 * Nada é gravado em disco, então nomes maliciosos de entrada ("../") não têm efeito.
 */
export function readPackFromZip(zip: Uint8Array): KnowledgePack {
  if (zip.byteLength > 5 * 1024 * 1024) throw new Error('Pacote grande demais (máximo 5 MB).');
  const names = new Set<string>(Object.values(FILES));
  const out = unzipSync(zip, {
    filter: (entry) => {
      const parts = entry.name.split('/').filter(Boolean);
      return names.has(parts.at(-1) ?? '') && !parts.includes('..') && parts.length <= 3 && entry.originalSize <= MAX_ENTRY_BYTES;
    },
  });
  const text = (base: string) => {
    const keys = Object.keys(out).filter((k) => k.split('/').pop() === base);
    if (keys.length !== 1) throw new Error(keys.length ? `Pacote com mais de um ${base}` : `Pacote sem ${base}`);
    return new TextDecoder().decode(out[keys[0]!]);
  };
  return parsePack({
    catalog: parseJson('catalog.json', text('catalog.json')),
    microphones: parseJson('microphone-models.json', text('microphone-models.json')),
    cases: parseJson('diagnostic-cases.json', text('diagnostic-cases.json')),
  });
}
