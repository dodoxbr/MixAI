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

async function pdfChunks(bytes: Uint8Array): Promise<RawChunk[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  return pages.flatMap((page, i) => chunkText(page, `p.${i + 1}`));
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
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const existing = await deps.store.findDocument(sourceId, file);
      if (existing?.sha256 === sha256 && (existing.embedded > 0 || !canEmbed)) { items.push({ file, sourceId, status: 'unchanged', chunks: existing.chunks, embedded: existing.embedded }); continue; }
      if (local) await deps.store.ensureSource(deps.makeSource(sourceId, file));
      const raw = ext === '.pdf' ? await pdfChunks(new Uint8Array(bytes)) : textChunks(bytes.toString('utf8'), ext);
      if (!raw.length) { items.push({ file, sourceId, status: 'skipped', reason: 'sem texto extraível' }); continue; }
      if (raw.length > MAX_CHUNKS) { items.push({ file, sourceId, status: 'skipped', reason: 'documento grande demais para a base local' }); continue; }
      const chunks: ChunkIn[] = raw.map((c, i) => ({ ordinal: i, text: c.text, locator: c.locator }));
      let embedded = 0;
      if (canEmbed) {
        for (let i = 0; i < chunks.length; i += BATCH) {
          const part = chunks.slice(i, i + BATCH);
          const vectors = await deps.ollama!.embed(part.map((c) => c.text));
          if (!vectors) break; // serviço caiu: o resto fica só com busca por palavras
          part.forEach((c, k) => { c.embedding = vectors[k]; });
          embedded += part.length;
        }
      }
      await deps.store.replaceDocument({ sourceId, fileName: file, sha256, bytes: bytes.length, chunks });
      items.push({ file, sourceId, status: 'ingested', chunks: chunks.length, embedded });
    } catch (err) {
      // Mensagem curta: sem caminho local, sem conteúdo do arquivo.
      items.push({ file, sourceId, status: 'failed', reason: err instanceof Error ? err.message.slice(0, 120).replace(/[A-Za-z]:[\\/][^\s]*/g, '[caminho]') : 'erro' });
    }
  }
  return { inbox: 'data/knowledge/inbox', items, embeddings: canEmbed ? 'available' : 'unavailable' };
}
