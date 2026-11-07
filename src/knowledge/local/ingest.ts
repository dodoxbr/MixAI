import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogEntry } from './pack.js';
import type { OllamaClient } from './ollama.js';
import type { ChunkIn, KnowledgeStore } from './store.js';
import { chunkText, cleanText, type RawChunk } from './text.js';

export type IngestStatus = 'ingested' | 'unchanged' | 'skipped' | 'failed';
export interface IngestItem { file: string; sourceId?: string; status: IngestStatus; chunks?: number; embedded?: number; reason?: string }
export interface IngestReport { inbox: string; items: IngestItem[]; embeddings: 'available' | 'unavailable' }

/**
 * Versão do pipeline de extração e divisão. Entra no hash do documento: quando o divisor ou os filtros
 * melhoram, os documentos já ingeridos são reindexados sozinhos na próxima ingestão.
 */
export const INGEST_VERSION = 'chunker-2';

/**
 * Tabela de códigos de modelos (ex.: "BETA58A SM58 PG48 KSM9") não ajuda a responder nada e polui a
 * busca. Trecho em que quase todas as "palavras" são códigos com número é descartado.
 */
export function mostlyCodes(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const codes = words.filter((w) => /^[A-Z0-9][A-Z0-9-]{2,}$/.test(w) && /\d/.test(w)).length;
  return codes / words.length > 0.4;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EXT = new Set(['.md', '.txt', '.pdf']);
const MAX_CHUNKS = 3000;
const BATCH = 16;

/** `akg-p3.pdf` ou `akg-p3__manual.pdf` → fonte `akg-p3`. Sem par no catálogo → fonte local própria. */
export function sourceIdFor(file: string, known: ReadonlySet<string>): { id: string; local: boolean } {
  const base = file.slice(0, file.lastIndexOf('.'));
  const head = base.split('__')[0]!.toLowerCase();
  if (known.has(head)) return { id: head, local: false };
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'documento';
  return { id: `local-${slug}`, local: true };
}

/** Página com menos que isto provavelmente é imagem/capa: avisamos, mas NÃO fazemos OCR. */
const SPARSE_PAGE_CHARS = 100;

async function pdfChunks(bytes: Uint8Array): Promise<{ chunks: RawChunk[]; pages: number; sparse: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  return {
    chunks: pages.flatMap((page, i) => chunkText(page, `p.${i + 1}`)),
    pages: pages.length,
    sparse: pages.filter((p) => cleanText(p).length < SPARSE_PAGE_CHARS).length,
  };
}

function textChunks(content: string, ext: string): RawChunk[] {
  if (ext !== '.md') return chunkText(content, 'texto');
  // Markdown: o locator é o último título visto.
  const out: RawChunk[] = [];
  let heading = 'início';
  let buf: string[] = [];
  const flush = () => { if (buf.length) out.push(...chunkText(buf.join('\n'), heading)); buf = []; };
  for (const line of content.split(/\r?\n/)) {
    const m = /^#{1,4}\s+(.{1,80})$/.exec(line);
    if (m) { flush(); heading = cleanText(m[1]!); } else buf.push(line);
  }
  flush();
  return out;
}

/** Texto → trechos, para .md, .txt e .pdf. Mesmo caminho da ingestão e da avaliação de busca. */
export async function extractChunks(bytes: Uint8Array, ext: string): Promise<{ chunks: RawChunk[]; note?: string }> {
  if (ext === '.pdf') {
    const pdf = await pdfChunks(new Uint8Array(bytes));
    return { chunks: pdf.chunks, ...(pdf.sparse ? { note: `${pdf.sparse} de ${pdf.pages} página(s) quase sem texto (imagem?): sem OCR automático` } : {}) };
  }
  return { chunks: textChunks(Buffer.from(bytes).toString('utf8'), ext) };
}

/**
 * Ingere os arquivos de UMA pasta (sem recursão, sem links simbólicos, nomes restritos, tamanho
 * limitado). O conteúdo é tratado como dado não confiável: vira trechos, nunca instruções.
 */
export async function ingestInbox(deps: {
  inbox: string; store: KnowledgeStore; ollama?: OllamaClient; maxBytes: number; catalogIds: ReadonlySet<string>;
  makeSource(id: string, file: string): CatalogEntry;
}): Promise<IngestReport> {
  mkdirSync(deps.inbox, { recursive: true });
  const items: IngestItem[] = [];
  const probe = deps.ollama ? await deps.ollama.health() : undefined;
  const canEmbed = !!probe?.reachable && probe.embedModel;
  for (const file of readdirSync(deps.inbox).sort()) {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (file === '.gitkeep') continue;
    if (!NAME_RE.test(file) || !EXT.has(ext)) { items.push({ file: file.slice(0, 100), status: 'skipped', reason: 'nome ou tipo não permitido (use .md, .txt ou .pdf)' }); continue; }
    const full = join(deps.inbox, file);
    const st = lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) { items.push({ file, status: 'skipped', reason: 'não é arquivo comum' }); continue; }
    if (st.size > deps.maxBytes) { items.push({ file, status: 'skipped', reason: 'maior que o limite configurado' }); continue; }
    const { id: sourceId, local } = sourceIdFor(file, deps.catalogIds);
    try {
      const bytes = readFileSync(full);
      const sha256 = createHash('sha256').update(bytes).update(INGEST_VERSION).digest('hex');
      const existing = await deps.store.findDocument(sourceId, file);
      // Só é "inalterado" se todos os trechos têm embedding (ou se não há como gerar agora): lacunas são reparadas.
      if (existing?.sha256 === sha256 && (existing.embedded >= existing.chunks || !canEmbed)) { items.push({ file, sourceId, status: 'unchanged', chunks: existing.chunks, embedded: existing.embedded }); continue; }
      if (local) await deps.store.ensureSource(deps.makeSource(sourceId, file));
      const extracted = await extractChunks(bytes, ext);
      const raw = extracted.chunks.filter((c) => !mostlyCodes(c.text));
      const dropped = extracted.chunks.length - raw.length;
      const pdfNote = [extracted.note, dropped ? `${dropped} trecho(s) de tabela de códigos ignorado(s)` : undefined].filter(Boolean).join('; ') || undefined;
      if (!raw.length) { items.push({ file, sourceId, status: 'skipped', reason: 'sem texto extraível' }); continue; }
      if (raw.length > MAX_CHUNKS) { items.push({ file, sourceId, status: 'skipped', reason: 'documento grande demais para a base local' }); continue; }
      const chunks: ChunkIn[] = raw.map((c, i) => ({ ordinal: i, text: c.text, locator: c.locator }));
      let embedded = 0;
      if (canEmbed) {
        for (let i = 0; i < chunks.length; i += BATCH) {
          const part = chunks.slice(i, i + BATCH);
          const texts = part.map((c) => c.text);
          const vectors = (await deps.ollama!.embed(texts)) ?? (await deps.ollama!.embed(texts)); // uma nova tentativa por lote
          if (!vectors) break; // serviço caiu: o resto fica só com busca por palavras
          part.forEach((c, k) => { c.embedding = vectors[k]; });
          embedded += part.length;
        }
      }
      await deps.store.replaceDocument({ sourceId, fileName: file, sha256, bytes: bytes.length, chunks });
      items.push({ file, sourceId, status: 'ingested', chunks: chunks.length, embedded, ...(pdfNote ? { reason: pdfNote } : {}) });
    } catch (err) {
      // Mensagem curta: sem caminho local, sem conteúdo do arquivo.
      items.push({ file, sourceId, status: 'failed', reason: err instanceof Error ? err.message.slice(0, 120).replace(/[A-Za-z]:[\\/][^\s]*/g, '[caminho]') : 'erro' });
    }
  }
  return { inbox: 'data/knowledge/inbox', items, embeddings: canEmbed ? 'available' : 'unavailable' };
}
