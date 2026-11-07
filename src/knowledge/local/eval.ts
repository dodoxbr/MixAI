import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { extractChunks, sourceIdFor } from './ingest.js';
import { FileKnowledgeStore, type Passage } from './store.js';
import { excerpt, normalize } from './text.js';

/**
 * Avaliação de relevância da busca. Compara modelos de embedding e modos de busca com perguntas
 * reais e critérios de conteúdo, SEM tocar na base de produção: monta um índice temporário.
 * Só lê documentos e fala com o Ollama local; nada aqui conhece a mesa.
 */
const caseSchema = z.object({
  id: z.string().min(1).max(60),
  topic: z.string().min(1).max(60),
  query: z.string().min(2).max(300),
  /** Basta UM destes trechos de texto (sem acento, minúsculas) aparecer no trecho recuperado. */
  anyOf: z.array(z.string().min(2).max(80)).min(1).max(20),
  /** Restringe às fontes do catálogo, quando a pergunta só tem resposta em um documento. */
  sources: z.array(z.string()).optional(),
}).strict();
const setSchema = z.object({ schemaVersion: z.literal(1), description: z.string(), cases: z.array(caseSchema).min(1).max(200) }).strict();
export type RelevanceCase = z.infer<typeof caseSchema>;

export function parseRelevance(raw: unknown): RelevanceCase[] {
  return setSchema.parse(raw).cases;
}
export function loadRelevance(path: string): RelevanceCase[] {
  return parseRelevance(JSON.parse(readFileSync(path, 'utf8')));
}

export function isRelevant(c: RelevanceCase, text: string, sourceId: string): boolean {
  if (c.sources && !c.sources.includes(sourceId)) return false;
  const t = normalize(text);
  return c.anyOf.some((needle) => t.includes(normalize(needle)));
}

export interface EvalChunk { sourceId: string; locator: string; text: string }

/** Lê a pasta de ingestão com o MESMO extrator e divisor da ingestão real. */
export async function loadCorpus(inbox: string, catalogIds: ReadonlySet<string>): Promise<EvalChunk[]> {
  const out: EvalChunk[] = [];
  for (const file of readdirSync(inbox).sort()) {
    const dot = file.lastIndexOf('.');
    const ext = dot < 0 ? '' : file.slice(dot).toLowerCase();
    if (!['.md', '.txt', '.pdf'].includes(ext) || !statSync(join(inbox, file)).isFile()) continue;
    const { id } = sourceIdFor(file, catalogIds);
    const { chunks } = await extractChunks(new Uint8Array(readFileSync(join(inbox, file))), ext);
    for (const c of chunks) out.push({ sourceId: id, locator: c.locator, text: c.text });
  }
  return out;
}

export interface EvalEmbedder {
  name: string;
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][] | undefined>;
}

/** "auto@0.5" = modo auto com limiar 0.5: varre limiares sem reindexar. */
export type EvalMethod = 'keyword' | 'vector' | 'auto' | 'hybrid' | `auto@${number}` | `hybrid@${number}`;
export interface MethodReport {
  method: EvalMethod;
  hit1: number;
  hit3: number;
  hitK: number;
  mrr: number;
  precisionK: number;
  byTopic: Record<string, { cases: number; hitK: number }>;
  misses: string[];
}
export interface EvalReport {
  embedder: string;
  dimensions?: number;
  chunks: number;
  cases: number;
  k: number;
  minScore: number;
  indexMs: number;
  queryMs: number;
  methods: MethodReport[];
  /** Cosseno do 1º resultado vetorial: separa "achou algo relevante" de "achou qualquer coisa". */
  scoreStats?: { relevantTop1: number[]; otherTop1: number[]; suggestedMinScore?: number };
}

const BATCH = 16;
const round = (n: number) => Number(n.toFixed(3));
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : undefined);

export async function runEval(deps: { chunks: EvalChunk[]; cases: RelevanceCase[]; embedder?: EvalEmbedder; k?: number; minScore?: number; methods?: EvalMethod[]; sweep?: number[] }): Promise<EvalReport> {
  const k = deps.k ?? 4;
  const minScore = deps.minScore ?? 0.3;
  const dir = mkdtempSync(join(tmpdir(), 'mixai-eval-'));
  try {
    const store = new FileKnowledgeStore(join(dir, 'eval.json'));
    await store.init();
    const full = new Map<string, string>(); // trecho recuperado → texto inteiro, para julgar relevância
    const t0 = Date.now();
    let dimensions: number | undefined;
    const bySource = new Map<string, EvalChunk[]>();
    for (const c of deps.chunks) bySource.set(c.sourceId, [...(bySource.get(c.sourceId) ?? []), c]);
    for (const [sourceId, list] of bySource) {
      const vectors: Array<number[] | undefined> = [];
      if (deps.embedder) {
        for (let i = 0; i < list.length; i += BATCH) {
          const part = list.slice(i, i + BATCH);
          const v = await deps.embedder.embed(part.map((c) => c.text), 'document');
          part.forEach((_, j) => vectors.push(v?.[j]));
        }
        dimensions ??= vectors.find(Boolean)?.length;
      }
      await store.replaceDocument({
        sourceId, fileName: `${sourceId}.eval`, sha256: sourceId, bytes: 0,
        chunks: list.map((c, i) => ({ ordinal: i, text: c.text, locator: c.locator, ...(vectors[i] ? { embedding: vectors[i]! } : {}) })),
      });
      for (const c of list) full.set(`${sourceId}\u0000${c.locator}\u0000${excerpt(c.text)}`, c.text);
    }
    const indexMs = Date.now() - t0;

    const methods: EvalMethod[] = deps.methods ?? (deps.embedder ? ['keyword', 'vector', 'auto', 'hybrid', ...(deps.sweep ?? []).map((s) => `auto@${s}` as const)] : ['keyword']);
    const ranks: Record<string, Array<{ c: RelevanceCase; rank: number; relevantInTopK: number }>> = Object.fromEntries(methods.map((m) => [m, []]));
    const relevantTop: number[] = [];
    const otherTop: number[] = [];
    let queryMs = 0;
    for (const c of deps.cases) {
      const q0 = Date.now();
      const emb = deps.embedder ? (await deps.embedder.embed([c.query], 'query'))?.[0] : undefined;
      queryMs += Date.now() - q0;
      for (const method of methods) {
        let found: Passage[];
        if (method === 'keyword') found = await store.search(c.query, undefined, k);
        else if (method === 'vector') found = emb ? await store.search(c.query, emb, k, { mode: 'auto', minScore: -1 }) : [];
        else {
          const [mode, at] = method.split('@') as ['auto' | 'hybrid', string | undefined];
          found = await store.search(c.query, emb, k, { mode, minScore: at === undefined ? minScore : Number(at) });
        }
        const flags = found.map((p) => isRelevant(c, full.get(`${p.sourceId}\u0000${p.locator}\u0000${p.excerpt}`) ?? p.excerpt, p.sourceId));
        const first = flags.indexOf(true);
        ranks[method]!.push({ c, rank: first < 0 ? 0 : first + 1, relevantInTopK: flags.filter(Boolean).length / Math.max(1, Math.min(k, found.length || 1)) });
        if (method === 'vector' && found[0]) (flags[0] ? relevantTop : otherTop).push(found[0].score);
      }
    }
    const reports: MethodReport[] = methods.map((method) => {
      const rs = ranks[method]!;
      const n = rs.length;
      const byTopic: MethodReport['byTopic'] = {};
      for (const { c, rank } of rs) {
        const t = (byTopic[c.topic] ??= { cases: 0, hitK: 0 });
        t.cases++;
        if (rank) t.hitK++;
      }
      return {
        method,
        hit1: round(rs.filter((r) => r.rank === 1).length / n),
        hit3: round(rs.filter((r) => r.rank >= 1 && r.rank <= 3).length / n),
        hitK: round(rs.filter((r) => r.rank >= 1).length / n),
        mrr: round(rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n),
        precisionK: round(rs.reduce((s, r) => s + r.relevantInTopK, 0) / n),
        byTopic,
        misses: rs.filter((r) => !r.rank).map((r) => r.c.id),
      };
    });
    const rel = median(relevantTop);
    const oth = median(otherTop);
    return {
      embedder: deps.embedder?.name ?? 'nenhum (só palavras)', ...(dimensions ? { dimensions } : {}),
      chunks: deps.chunks.length, cases: deps.cases.length, k, minScore, indexMs, queryMs: Math.round(queryMs / Math.max(1, deps.cases.length)), methods: reports,
      ...(deps.embedder ? { scoreStats: { relevantTop1: relevantTop.map(round), otherTop1: otherTop.map(round), ...(rel !== undefined && oth !== undefined ? { suggestedMinScore: round((rel + oth) / 2 - 0.05) } : {}) } } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Avalia a base REAL (o que o operador usa) por uma função de busca: julga só pelo trecho exibido. */
export async function evalLive(search: (q: string) => Promise<Array<{ sourceId: string; excerpt: string }>>, cases: RelevanceCase[], k = 4): Promise<MethodReport> {
  const rs: Array<{ c: RelevanceCase; rank: number; frac: number }> = [];
  for (const c of cases) {
    const found = (await search(c.query)).slice(0, k);
    const flags = found.map((p) => isRelevant(c, p.excerpt, p.sourceId));
    const first = flags.indexOf(true);
    rs.push({ c, rank: first < 0 ? 0 : first + 1, frac: flags.filter(Boolean).length / Math.max(1, found.length) });
  }
  const n = rs.length;
  const byTopic: MethodReport['byTopic'] = {};
  for (const { c, rank } of rs) { const t = (byTopic[c.topic] ??= { cases: 0, hitK: 0 }); t.cases++; if (rank) t.hitK++; }
  return {
    method: 'auto',
    hit1: round(rs.filter((r) => r.rank === 1).length / n), hit3: round(rs.filter((r) => r.rank >= 1 && r.rank <= 3).length / n), hitK: round(rs.filter((r) => r.rank >= 1).length / n),
    mrr: round(rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n), precisionK: round(rs.reduce((s, r) => s + r.frac, 0) / n), byTopic, misses: rs.filter((r) => !r.rank).map((r) => r.c.id),
  };
}
