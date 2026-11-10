import { createHash } from 'node:crypto';
import { technicalArticles, FIELD_LIBRARY_VERSION } from '../sound-engineer/index.js';
import { sources } from '../sound-engineer/sources.js';
import { chunkText } from './text.js';
import { isPublicSource } from './privacy.js';
import type { AiProvider } from './provider.js';
import type { ChunkIn, KnowledgeStore } from './store.js';

/** Separate source namespace: does not replace manuals, the microphone pack or operator documents. */
export const TECHNICAL_SOURCE_ID = 'mixai-technical-v1';
export function technicalCorpus() {
  // Existing passage UI shows 420 characters. Keep substantive chunks readable in full;
  // use the existing splitter's supported size, without changing PDF ingestion/ranking.
  return technicalArticles.flatMap(a => chunkText(`${a.title}. ${a.text}\n\nOrigem: síntese editorial MixAI v${a.version}; teoria, não validada em ensaio. Fontes: ${a.references.map(r => `${sources[r.source].title}, ${r.locator}; ${sources[r.source].url}`).join(' | ')}`, `${a.id}@${a.version}`, 400, 0)
    .map(c => ({ ...c, sourceId: TECHNICAL_SOURCE_ID, articleId: a.id })));
}
const TECHNICAL_URL = 'https://github.com/dodoxbr/MixAI/blob/main/docs/sound-engineer/ISSUE-65-LIBRARY.md';
const EMBED_BATCH = 16;
export interface TechnicalImportReport {
  libraryVersion: string; imported: number; unchanged: number; repaired: number;
  chunks: number; embedded: number; pending: number;
  /** complete = todos os trechos têm vetor; partial/pending = há trechos só com busca por palavras (rode de novo); none = sem provedor. */
  embeddings: 'complete' | 'partial' | 'pending' | 'none';
  provider?: import('./provider.js').ProviderId; skippedExternal?: boolean;
}

/**
 * Importação opt-in e IDEMPOTENTE das sínteses técnicas, agora com embeddings do provedor configurado para a coleção.
 *  - Documento novo ou alterado: grava os trechos e os vetores que o provedor conseguir gerar.
 *  - Documento igual e completo: não faz nada (unchanged).
 *  - Documento igual com vetores faltando: REPARA só se houver provedor agora (retomável); sem provedor, preserva e
 *    informa os embeddings pendentes (nunca apaga nem substitui o que já existe).
 *  - Provedor externo: o conteúdo é público e versionado, mas só segue se a fonte for pública; do contrário fica só local.
 * Nunca toca outras fontes (manuais, pacote do microfone, documentos do operador).
 */
export async function importTechnicalCorpus(store: KnowledgeStore, embedder?: AiProvider): Promise<TechnicalImportReport> {
  await store.ensureSource({ id: TECHNICAL_SOURCE_ID, title: 'MixAI — sínteses técnicas citadas (teoria)',
    url: TECHNICAL_URL,
    description: 'Adaptação editorial em português de fontes identificadas; não é manual do fabricante nem evidência acústica.', verifiedOnline: '2026-11-08', downloaded: false });
  const externalBlocked = !!embedder?.external && !isPublicSource({ url: TECHNICAL_URL });
  const probe = embedder && !externalBlocked ? await embedder.health().catch(() => undefined) : undefined;
  const canEmbed = !!embedder && !externalBlocked && !!probe?.reachable && probe.embedModel;
  let imported = 0, unchanged = 0, repaired = 0, chunksTotal = 0, embeddedTotal = 0;
  const corpus = technicalCorpus();
  for (const a of technicalArticles) {
    const chunks: ChunkIn[] = corpus.filter(c => c.articleId === a.id).map((c, ordinal) => ({ ordinal, text: c.text, locator: c.locator }));
    const text = chunks.map(c => c.text).join('\n');
    const fileName = `${a.id}.md`, sha256 = createHash('sha256').update(FIELD_LIBRARY_VERSION).update(text).digest('hex');
    const existing = await store.findDocument(TECHNICAL_SOURCE_ID, fileName);
    const same = existing?.sha256 === sha256;
    if (same && (existing!.embedded >= existing!.chunks || !canEmbed)) {
      unchanged++; chunksTotal += existing!.chunks; embeddedTotal += existing!.embedded; continue;
    }
    let embedded = 0;
    if (canEmbed) {
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const part = chunks.slice(i, i + EMBED_BATCH);
        const texts = part.map(c => c.text);
        const vectors = (await embedder!.embed(texts, 'document')) ?? (await embedder!.embed(texts, 'document')); // uma nova tentativa por lote
        if (!vectors) break; // provedor caiu no meio: o documento é gravado e fica pendente para a próxima execução
        part.forEach((c, k) => { c.embedding = vectors[k]; });
        embedded += part.length;
      }
    }
    await store.replaceDocument({ sourceId: TECHNICAL_SOURCE_ID, fileName, sha256, bytes: Buffer.byteLength(text), chunks });
    if (same) repaired++; else imported++;
    chunksTotal += chunks.length; embeddedTotal += embedded;
  }
  const pending = chunksTotal - embeddedTotal;
  return { libraryVersion: FIELD_LIBRARY_VERSION, imported, unchanged, repaired, chunks: chunksTotal, embedded: embeddedTotal, pending,
    embeddings: !embedder || externalBlocked ? 'none' : pending === 0 ? 'complete' : embeddedTotal ? 'partial' : 'pending',
    ...(embedder ? { provider: embedder.id } : {}), ...(externalBlocked ? { skippedExternal: true } : {}) };
}
/** Reversible removal is restricted to this source namespace, preserving all earlier corpus. */
export async function removeTechnicalCorpus(store: KnowledgeStore) {
  const docs = (await store.listDocuments()).filter(d => d.sourceId === TECHNICAL_SOURCE_ID);
  let removed = 0; for (const d of docs) if (await store.deleteDocument(d.id)) removed++;
  return { removed };
}
