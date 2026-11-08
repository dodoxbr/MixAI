import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Assignment, CasesPack, CatalogEntry, MicModel, MicPack } from './pack.js';
import { DEFAULT_MIN_SCORE, type DocumentIn, type DocumentRow, type KnowledgeStore, type MicrophoneState, type Passage, type SearchOptions, type SourceRow, type StoreHealth } from './store.js';
import { mentionedModels } from './models.js';
import { excerpt, fuse } from './text.js';

/** Fatia mínima do cliente PostgreSQL, para trocar por um falso nos testes. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface PgConnection { host: string; port: number; database: string; user: string; password: string; /** Schema da coleção (padrão: public). */ schema?: string }

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,40}$/;

export function createPgClient(c: PgConnection): SqlClient {
  if (c.schema && c.schema !== 'public' && !SCHEMA_RE.test(c.schema)) throw new Error('Schema inválido.');
  // O schema entra pelo search_path da conexão: as consultas não mudam e o nome é validado acima.
  const options = c.schema && c.schema !== 'public' ? `-c search_path=${c.schema},public` : undefined;
  const pool = new pg.Pool({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, options, max: 3, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10_000, statement_timeout: 15_000 });
  pool.on('error', () => undefined); // queda do servidor não derruba o processo
  return pool as unknown as SqlClient;
}

/** Vetor como literal do pgvector. Só números finitos entram: nada de texto livre no SQL. */
export function vectorLiteral(v: readonly number[]): string {
  if (!v.length || v.some((x) => !Number.isFinite(x))) throw new Error('Vetor inválido.');
  return `[${v.join(',')}]`;
}

type R = Record<string, unknown>;

/**
 * Consulta de palavras com semântica OR ("a | b | c"): perguntas naturais quase nunca contêm todas as
 * palavras de um mesmo trecho (plainto_tsquery exige todas). Só letras e números entram, então nenhum
 * operador do tsquery pode ser injetado; o valor ainda vai como parâmetro ($1). O PostgreSQL remove
 * as palavras vazias (stop words) e faz o radical em português.
 */
export function orTsQuery(query: string): string {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && w.length <= 40))];
  return words.slice(0, 12).join(' | ');
}

/** PostgreSQL + pgvector. Todas as consultas são parametrizadas ($1…); dimensão vem da configuração. */
export class PgKnowledgeStore implements KnowledgeStore {
  readonly kind = 'postgres' as const;
  constructor(private readonly db: SqlClient, private readonly dimensions: number, private readonly clock: () => number = Date.now, private readonly schema: string = 'public') {
    if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 4096) throw new Error('Dimensão de embedding inválida.');
    if (schema !== 'public' && !SCHEMA_RE.test(schema)) throw new Error('Schema inválido.');
  }

  async init(): Promise<void> {
    await this.db.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
    if (this.schema !== 'public') await this.db.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`); // nome validado no construtor
    const dim = this.dimensions; // inteiro validado acima: único valor interpolado no DDL
    const ddl = [
      `CREATE TABLE IF NOT EXISTS knowledge_sources (id text PRIMARY KEY, title text NOT NULL, url text NOT NULL, description text NOT NULL, verified_online date, downloaded boolean NOT NULL DEFAULT false, local boolean NOT NULL DEFAULT false)`,
      `CREATE TABLE IF NOT EXISTS knowledge_documents (id text PRIMARY KEY, source_id text NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE, file_name text NOT NULL, sha256 text NOT NULL, bytes integer NOT NULL, ingested_at timestamptz NOT NULL DEFAULT now(), UNIQUE (source_id, file_name))`,
      `CREATE TABLE IF NOT EXISTS knowledge_chunks (id bigserial PRIMARY KEY, document_id text NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE, ordinal integer NOT NULL, locator text NOT NULL, content text NOT NULL, embedding vector(${dim}), tsv tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED)`,
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv ON knowledge_chunks USING gin (tsv)`,
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`,
      `CREATE TABLE IF NOT EXISTS microphone_models (id text PRIMARY KEY, data jsonb NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS channel_microphones (channel text PRIMARY KEY, musician text NOT NULL, model_id text REFERENCES microphone_models(id), role text NOT NULL, evidence text NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS diagnostic_cases (id text PRIMARY KEY, data jsonb NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS knowledge_meta (key text PRIMARY KEY, value jsonb NOT NULL)`,
    ];
    for (const sql of ddl) await this.db.query(sql);
  }

  async health(): Promise<StoreHealth> {
    try {
      const r = await this.db.query<{ v: string | null }>("SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'");
      if (!r.rows[0]?.v) return { ok: false, detail: 'PostgreSQL sem a extensão pgvector.' };
      // A dimensão da coluna é fixa: se a configuração mudou de modelo, a coleção precisa ser outra.
      const dim = await this.db.query<{ d: number | null }>("SELECT a.atttypmod AS d FROM pg_attribute a WHERE a.attrelid = to_regclass('knowledge_chunks') AND a.attname = 'embedding'");
      const stored = dim.rows[0]?.d;
      if (stored && stored > 0 && stored !== this.dimensions) return { ok: false, detail: `A coleção guarda vetores de ${stored} dimensões e a configuração pede ${this.dimensions}: use outra knowledge.collection.` };
      return { ok: true, detail: `PostgreSQL com pgvector ${r.rows[0].v}${this.schema !== 'public' ? ` · coleção ${this.schema}` : ''}` };
    } catch {
      return { ok: false, detail: 'PostgreSQL indisponível.' };
    }
  }

  async importPack(catalog: CatalogEntry[], microphones: MicPack, cases: CasesPack): Promise<void> {
    for (const c of catalog) {
      await this.db.query(
        `INSERT INTO knowledge_sources (id, title, url, description, verified_online, downloaded) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, description = EXCLUDED.description, verified_online = EXCLUDED.verified_online, downloaded = knowledge_sources.downloaded OR EXCLUDED.downloaded`,
        [c.id, c.title, c.url, c.description, c.verifiedOnline, c.downloaded]);
    }
    for (const [id, model] of Object.entries(microphones.candidateModels)) {
      await this.db.query('INSERT INTO microphone_models (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [id, JSON.stringify(model)]);
    }
    for (const [ch, a] of Object.entries(microphones.channelAssignments)) {
      // Reimportar nunca desfaz uma confirmação feita pelo operador.
      await this.db.query(
        `INSERT INTO channel_microphones (channel, musician, model_id, role, evidence) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (channel) DO UPDATE SET musician = EXCLUDED.musician, model_id = EXCLUDED.model_id, role = EXCLUDED.role, evidence = EXCLUDED.evidence
         WHERE channel_microphones.evidence <> 'operator_confirmed'`,
        [ch, a.musician, a.modelId, a.role, a.evidence]);
    }
    await this.db.query(`INSERT INTO knowledge_meta (key, value) VALUES ('microphones', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ verifiedModel: microphones.verifiedModel, bandMicModel: microphones.bandMicModel, safety: microphones.safety })]);
    for (const c of cases.cases) {
      await this.db.query('INSERT INTO diagnostic_cases (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [c.id, JSON.stringify(c)]);
    }
  }

  async listSources(): Promise<SourceRow[]> {
    const r = await this.db.query<R>(
      `SELECT s.id, s.title, s.url, s.description, to_char(s.verified_online, 'YYYY-MM-DD') AS verified_online, s.downloaded, s.local,
              (SELECT count(*) FROM knowledge_documents d WHERE d.source_id = s.id)::int AS documents
       FROM knowledge_sources s ORDER BY s.id`);
    return r.rows.map((x) => ({ id: String(x.id), title: String(x.title), url: String(x.url), description: String(x.description), verifiedOnline: String(x.verified_online ?? '1970-01-01'), downloaded: Boolean(x.downloaded), local: Boolean(x.local), documents: Number(x.documents) }));
  }
  async ensureSource(e: CatalogEntry): Promise<void> {
    await this.db.query('INSERT INTO knowledge_sources (id, title, url, description, verified_online, downloaded, local) VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (id) DO NOTHING', [e.id, e.title, e.url, e.description, e.verifiedOnline, e.downloaded]);
  }
  async getMicrophones(): Promise<MicrophoneState> {
    const models = await this.db.query<{ id: string; data: MicModel }>('SELECT id, data FROM microphone_models ORDER BY id');
    const assigned = await this.db.query<R>('SELECT channel, musician, model_id, role, evidence FROM channel_microphones ORDER BY channel');
    const meta = await this.db.query<{ value: { verifiedModel: string | null; bandMicModel: string; safety: string } }>(`SELECT value FROM knowledge_meta WHERE key = 'microphones'`);
    const m = meta.rows[0]?.value;
    return {
      verifiedModel: m?.verifiedModel ?? null, bandMicModel: m?.bandMicModel ?? '', safety: m?.safety ?? '',
      models: Object.fromEntries(models.rows.map((x) => [x.id, x.data])),
      assignments: Object.fromEntries(assigned.rows.map((x) => [String(x.channel), { musician: String(x.musician), modelId: (x.model_id as string | null) ?? null, role: x.role as Assignment['role'], evidence: x.evidence as Assignment['evidence'] }])),
    };
  }
  async setAssignment(channel: string, a: Assignment): Promise<void> {
    await this.db.query(
      `INSERT INTO channel_microphones (channel, musician, model_id, role, evidence) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (channel) DO UPDATE SET musician = EXCLUDED.musician, model_id = EXCLUDED.model_id, role = EXCLUDED.role, evidence = EXCLUDED.evidence`,
      [channel, a.musician, a.modelId, a.role, a.evidence]);
  }
  async listCases(): Promise<CasesPack['cases']> {
    const r = await this.db.query<{ data: CasesPack['cases'][number] }>('SELECT data FROM diagnostic_cases ORDER BY id');
    return r.rows.map((x) => x.data);
  }
  private doc(x: R): DocumentRow {
    return { id: String(x.id), sourceId: String(x.source_id), fileName: String(x.file_name), sha256: String(x.sha256), bytes: Number(x.bytes), chunks: Number(x.chunks), embedded: Number(x.embedded), ingestedAt: new Date(String(x.ingested_at)).toISOString() };
  }
  private readonly docSelect = `SELECT d.id, d.source_id, d.file_name, d.sha256, d.bytes, d.ingested_at,
      (SELECT count(*) FROM knowledge_chunks c WHERE c.document_id = d.id)::int AS chunks,
      (SELECT count(*) FROM knowledge_chunks c WHERE c.document_id = d.id AND c.embedding IS NOT NULL)::int AS embedded
    FROM knowledge_documents d`;
  async listDocuments(): Promise<DocumentRow[]> {
    return (await this.db.query<R>(`${this.docSelect} ORDER BY d.source_id, d.file_name`)).rows.map((x) => this.doc(x));
  }
  async findDocument(sourceId: string, fileName: string) {
    const r = await this.db.query<R>(`${this.docSelect} WHERE d.source_id = $1 AND d.file_name = $2`, [sourceId, fileName]);
    return r.rows[0] ? this.doc(r.rows[0]) : undefined;
  }
  async replaceDocument(doc: DocumentIn): Promise<DocumentRow> {
    const id = `d${createHash('sha256').update(`${doc.sourceId}\0${doc.fileName}`).digest('hex').slice(0, 16)}`;
    await this.db.query('DELETE FROM knowledge_documents WHERE source_id = $1 AND file_name = $2', [doc.sourceId, doc.fileName]);
    await this.db.query('INSERT INTO knowledge_documents (id, source_id, file_name, sha256, bytes, ingested_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, doc.sourceId, doc.fileName, doc.sha256, doc.bytes, new Date(this.clock()).toISOString()]);
    for (const c of doc.chunks) {
      if (c.embedding && c.embedding.length !== this.dimensions) throw new Error('Embedding com dimensão diferente da tabela.');
      await this.db.query('INSERT INTO knowledge_chunks (document_id, ordinal, locator, content, embedding) VALUES ($1,$2,$3,$4,$5::vector)', [id, c.ordinal, c.locator, c.text, c.embedding ? vectorLiteral(c.embedding) : null]);
    }
    await this.db.query('UPDATE knowledge_sources SET downloaded = true WHERE id = $1', [doc.sourceId]);
    return (await this.findDocument(doc.sourceId, doc.fileName))!;
  }
  async deleteDocument(id: string): Promise<boolean> {
    const r = await this.db.query<{ id: string }>('DELETE FROM knowledge_documents WHERE id = $1 RETURNING id', [id]);
    return r.rows.length > 0;
  }
  private async vector(embedding: number[], limit: number, minScore: number): Promise<Passage[]> {
    if (embedding.length !== this.dimensions) return [];
    const r = await this.db.query<R>(
      `SELECT c.locator, c.content, d.id AS document_id, d.source_id, 1 - (c.embedding <=> $1::vector) AS score
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL ORDER BY c.embedding <=> $1::vector LIMIT $2`, [vectorLiteral(embedding), limit]);
    return r.rows.filter((x) => Number(x.score) > minScore)
      .map((x) => ({ sourceId: String(x.source_id), documentId: String(x.document_id), locator: String(x.locator), excerpt: excerpt(String(x.content)), models: [...mentionedModels(String(x.content))].sort(), score: Number(Number(x.score).toFixed(4)), method: 'vector' as const }));
  }
  private async keyword(query: string, limit: number): Promise<Passage[]> {
    const q = orTsQuery(query.slice(0, 300));
    if (!q) return [];
    const r = await this.db.query<R>(
      `SELECT c.locator, c.content, d.id AS document_id, d.source_id, ts_rank(c.tsv, to_tsquery('portuguese', $1)) AS score
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.tsv @@ to_tsquery('portuguese', $1) ORDER BY score DESC LIMIT $2`, [q, limit]);
    return r.rows.map((x) => ({ sourceId: String(x.source_id), documentId: String(x.document_id), locator: String(x.locator), excerpt: excerpt(String(x.content)), models: [...mentionedModels(String(x.content))].sort(), score: Number(Number(x.score).toFixed(4)), method: 'keyword' as const }));
  }
  async search(query: string, embedding: number[] | undefined, limit: number, opts: SearchOptions = {}): Promise<Passage[]> {
    const min = opts.minScore ?? DEFAULT_MIN_SCORE;
    if (opts.mode === 'hybrid') {
      const wide = Math.max(limit * 3, 12);
      return fuse(embedding ? await this.vector(embedding, wide, min) : [], await this.keyword(query, wide), limit);
    }
    if (embedding) {
      const found = await this.vector(embedding, limit, min);
      if (found.length) return found;
    }
    return this.keyword(query, limit);
  }
  async close(): Promise<void> { await this.db.end().catch(() => undefined); }
}
