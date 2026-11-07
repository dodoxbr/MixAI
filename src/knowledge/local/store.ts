import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Assignment, CasesPack, CatalogEntry, MicModel, MicPack } from './pack.js';
import { mentionedModels } from './models.js';
import { cosine, excerpt, fuse, tokens } from './text.js';

export interface ChunkIn { ordinal: number; text: string; locator: string; embedding?: number[] }
export interface DocumentIn { sourceId: string; fileName: string; sha256: string; bytes: number; chunks: ChunkIn[] }
export interface DocumentRow { id: string; sourceId: string; fileName: string; sha256: string; bytes: number; chunks: number; embedded: number; ingestedAt: string }
export interface SourceRow extends CatalogEntry { documents: number; local: boolean }
export interface Passage { sourceId: string; documentId: string; locator: string; excerpt: string; score: number; method: 'vector' | 'keyword' | 'hybrid'; /** Modelos de microfone citados no trecho inteiro (ex.: P3, P5). */ models?: string[]; caution?: string }
/** auto = vetor e, se nada passar do limiar, palavras (padrão antigo); hybrid = fusão dos dois (RRF). */
export type SearchMode = 'auto' | 'hybrid';
export interface SearchOptions { mode?: SearchMode; minScore?: number }
export const DEFAULT_MIN_SCORE = 0.3;
export interface MicrophoneState {
  verifiedModel: string | null;
  bandMicModel: string;
  safety: string;
  models: Record<string, MicModel>;
  assignments: Record<string, Assignment>;
}
export interface StoreHealth { ok: boolean; detail: string }

/** Contrato único dos dois backends (arquivo e PostgreSQL). Nenhum método toca na mesa. */
export interface KnowledgeStore {
  readonly kind: 'file' | 'postgres';
  init(): Promise<void>;
  health(): Promise<StoreHealth>;
  importPack(catalog: CatalogEntry[], microphones: MicPack, cases: CasesPack): Promise<void>;
  listSources(): Promise<SourceRow[]>;
  ensureSource(entry: CatalogEntry): Promise<void>;
  getMicrophones(): Promise<MicrophoneState>;
  setAssignment(channel: string, assignment: Assignment): Promise<void>;
  listCases(): Promise<CasesPack['cases']>;
  listDocuments(): Promise<DocumentRow[]>;
  findDocument(sourceId: string, fileName: string): Promise<DocumentRow | undefined>;
  replaceDocument(doc: DocumentIn): Promise<DocumentRow>;
  deleteDocument(id: string): Promise<boolean>;
  search(query: string, embedding: number[] | undefined, limit: number, opts?: SearchOptions): Promise<Passage[]>;
  close(): Promise<void>;
}

const FILE_VERSION = 1;
const stateSchema = z.object({
  version: z.literal(FILE_VERSION),
  sources: z.record(z.string(), z.any()),
  microphones: z.any().nullable(),
  cases: z.array(z.any()),
  documents: z.array(z.object({
    id: z.string(), sourceId: z.string(), fileName: z.string(), sha256: z.string(), bytes: z.number(), ingestedAt: z.string(),
    chunks: z.array(z.object({ ordinal: z.number(), text: z.string(), locator: z.string(), embedding: z.array(z.number()).optional() })),
  })),
});
type FileState = z.infer<typeof stateSchema>;

/** JSON em data/knowledge (fora do Git). Gravação atômica; arquivo corrompido nunca é sobrescrito. */
export class FileKnowledgeStore implements KnowledgeStore {
  readonly kind = 'file' as const;
  private state: FileState = { version: FILE_VERSION, sources: {}, microphones: null, cases: [], documents: [] };
  private seq = 0;
  constructor(private readonly path: string, private readonly clock: () => number = Date.now) {}

  async init(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) return;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')); } catch { throw new Error('knowledge.json corrompido: nada foi sobrescrito. Mova o arquivo e importe de novo.'); }
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) throw new Error('knowledge.json com formato inesperado: nada foi sobrescrito.');
    this.state = parsed.data;
  }
  private save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.path);
  }
  async health(): Promise<StoreHealth> { return { ok: true, detail: 'arquivo local' }; }
  async importPack(catalog: CatalogEntry[], microphones: MicPack, cases: CasesPack): Promise<void> {
    for (const entry of catalog) {
      const previous = this.state.sources[entry.id] as CatalogEntry | undefined;
      this.state.sources[entry.id] = { ...entry, downloaded: previous?.downloaded || entry.downloaded };
    }
    const current = this.state.microphones as MicPack | null;
    // Reimportar nunca desfaz uma confirmação feita pelo operador na tela.
    const assignments: Record<string, Assignment> = { ...microphones.channelAssignments };
    if (current) for (const [ch, a] of Object.entries(current.channelAssignments)) if (a.evidence === 'operator_confirmed') assignments[ch] = a;
    this.state.microphones = { ...microphones, channelAssignments: assignments };
    this.state.cases = cases.cases;
    this.save();
  }
  async listSources(): Promise<SourceRow[]> {
    return Object.values(this.state.sources as Record<string, CatalogEntry & { local?: boolean }>).map((s) => ({
      ...s, local: !!s.local, documents: this.state.documents.filter((d) => d.sourceId === s.id).length,
    }));
  }
  async ensureSource(entry: CatalogEntry): Promise<void> {
    if (!this.state.sources[entry.id]) { this.state.sources[entry.id] = { ...entry, local: true }; this.save(); }
  }
  async getMicrophones(): Promise<MicrophoneState> {
    const m = this.state.microphones as MicPack | null;
    return m
      ? { verifiedModel: m.verifiedModel, bandMicModel: m.bandMicModel, safety: m.safety, models: m.candidateModels, assignments: m.channelAssignments }
      : { verifiedModel: null, bandMicModel: '', safety: '', models: {}, assignments: {} };
  }
  async setAssignment(channel: string, assignment: Assignment): Promise<void> {
    const m = this.state.microphones as MicPack | null;
    if (!m) throw new Error('Importe o pacote antes de cadastrar microfones.');
    m.channelAssignments[channel] = assignment;
    this.save();
  }
  async listCases() { return structuredClone(this.state.cases) as CasesPack['cases']; }
  private row(d: FileState['documents'][number]): DocumentRow {
    return { id: d.id, sourceId: d.sourceId, fileName: d.fileName, sha256: d.sha256, bytes: d.bytes, chunks: d.chunks.length, embedded: d.chunks.filter((c) => c.embedding).length, ingestedAt: d.ingestedAt };
  }
  async listDocuments(): Promise<DocumentRow[]> { return this.state.documents.map((d) => this.row(d)); }
  async findDocument(sourceId: string, fileName: string) {
    const d = this.state.documents.find((x) => x.sourceId === sourceId && x.fileName === fileName);
    return d ? this.row(d) : undefined;
  }
  async replaceDocument(doc: DocumentIn): Promise<DocumentRow> {
    this.state.documents = this.state.documents.filter((d) => !(d.sourceId === doc.sourceId && d.fileName === doc.fileName));
    const stored = { id: `d${this.clock().toString(36)}${(++this.seq).toString(36)}`, sourceId: doc.sourceId, fileName: doc.fileName, sha256: doc.sha256, bytes: doc.bytes, ingestedAt: new Date(this.clock()).toISOString(), chunks: doc.chunks };
    this.state.documents.push(stored);
    const src = this.state.sources[doc.sourceId] as CatalogEntry | undefined;
    if (src) src.downloaded = true;
    this.save();
    return this.row(stored);
  }
  async deleteDocument(id: string): Promise<boolean> {
    const before = this.state.documents.length;
    this.state.documents = this.state.documents.filter((d) => d.id !== id);
    if (this.state.documents.length !== before) this.save();
    return this.state.documents.length !== before;
  }
  private vector(embedding: number[], limit: number, minScore: number): Passage[] {
    const rows = this.state.documents.flatMap((d) => d.chunks.map((c) => ({ d, c })));
    return rows.filter(({ c }) => c.embedding?.length === embedding.length)
      .map(({ d, c }) => ({ d, c, score: cosine(embedding, c.embedding!) })).filter((x) => x.score > minScore)
      .sort((x, y) => y.score - x.score).slice(0, limit)
      .map(({ d, c, score }) => ({ sourceId: d.sourceId, documentId: d.id, locator: c.locator, excerpt: excerpt(c.text), models: [...mentionedModels(c.text)].sort(), score: Number(score.toFixed(4)), method: 'vector' as const }));
  }
  private keyword(query: string, limit: number): Passage[] {
    const rows = this.state.documents.flatMap((d) => d.chunks.map((c) => ({ d, c })));
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const df = new Map<string, number>();
    const prepared = rows.map(({ d, c }) => {
      const toks = tokens(c.text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of new Set(q)) if (tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
      return { d, c, tf, len: toks.length || 1 };
    });
    const n = prepared.length || 1;
    return prepared.map(({ d, c, tf, len }) => {
      let score = 0;
      for (const t of q) {
        const f = tf.get(t) ?? 0;
        if (f) score += (f / len) * Math.log(1 + n / (df.get(t) ?? 1)) * 10;
      }
      return { d, c, score };
    }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, limit)
      .map(({ d, c, score }) => ({ sourceId: d.sourceId, documentId: d.id, locator: c.locator, excerpt: excerpt(c.text), models: [...mentionedModels(c.text)].sort(), score: Number(score.toFixed(4)), method: 'keyword' as const }));
  }
  async search(query: string, embedding: number[] | undefined, limit: number, opts: SearchOptions = {}): Promise<Passage[]> {
    const min = opts.minScore ?? DEFAULT_MIN_SCORE;
    if (opts.mode === 'hybrid') {
      const wide = Math.max(limit * 3, 12);
      return fuse(embedding ? this.vector(embedding, wide, min) : [], this.keyword(query, wide), limit);
    }
    if (embedding) {
      const found = this.vector(embedding, limit, min);
      if (found.length) return found;
    }
    return this.keyword(query, limit);
  }
  async close(): Promise<void> { /* nada aberto */ }
}
