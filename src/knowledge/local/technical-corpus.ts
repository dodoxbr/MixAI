import { createHash } from 'node:crypto';
import { technicalArticles, FIELD_LIBRARY_VERSION } from '../sound-engineer/index.js';
import { sources } from '../sound-engineer/sources.js';
import { chunkText } from './text.js';
import type { KnowledgeStore } from './store.js';

/** Separate source namespace: does not replace manuals, the microphone pack or operator documents. */
export const TECHNICAL_SOURCE_ID = 'mixai-technical-v1';
export function technicalCorpus() {
  // Existing passage UI shows 420 characters. Keep substantive chunks readable in full;
  // use the existing splitter's supported size, without changing PDF ingestion/ranking.
  return technicalArticles.flatMap(a => chunkText(`${a.title}. ${a.text}\n\nOrigem: síntese editorial MixAI v${a.version}; teoria, não validada em ensaio. Fontes: ${a.references.map(r => `${sources[r.source].title}, ${r.locator}; ${sources[r.source].url}`).join(' | ')}`, `${a.id}@${a.version}`, 400, 0)
    .map(c => ({ ...c, sourceId: TECHNICAL_SOURCE_ID, articleId: a.id })));
}
/** Explicit opt-in, idempotent import using the existing store, never a provider or mixer. */
export async function importTechnicalCorpus(store: KnowledgeStore) {
  await store.ensureSource({ id: TECHNICAL_SOURCE_ID, title: 'MixAI — sínteses técnicas citadas (teoria)',
    url: 'https://github.com/dodoxbr/MixAI/blob/main/docs/sound-engineer/ISSUE-65-LIBRARY.md',
    description: 'Adaptação editorial em português de fontes identificadas; não é manual do fabricante nem evidência acústica.', verifiedOnline: '2026-11-08', downloaded: false });
  let imported = 0, unchanged = 0;
  const corpus = technicalCorpus();
  for (const a of technicalArticles) {
    const chunks = corpus.filter(c => c.articleId === a.id).map((c, ordinal) => ({ ordinal, text: c.text, locator: c.locator }));
    const text = chunks.map(c => c.text).join('\n');
    const fileName = `${a.id}.md`, sha256 = createHash('sha256').update(FIELD_LIBRARY_VERSION).update(text).digest('hex');
    if ((await store.findDocument(TECHNICAL_SOURCE_ID, fileName))?.sha256 === sha256) { unchanged++; continue; }
    await store.replaceDocument({ sourceId: TECHNICAL_SOURCE_ID, fileName, sha256, bytes: Buffer.byteLength(text), chunks }); imported++;
  }
  return { libraryVersion: FIELD_LIBRARY_VERSION, imported, unchanged, embeddings: 'not_generated' as const };
}
/** Reversible removal is restricted to this source namespace, preserving all earlier corpus. */
export async function removeTechnicalCorpus(store: KnowledgeStore) {
  const docs = (await store.listDocuments()).filter(d => d.sourceId === TECHNICAL_SOURCE_ID);
  let removed = 0; for (const d of docs) if (await store.deleteDocument(d.id)) removed++;
  return { removed };
}
