import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider, ProviderHealth } from '../src/knowledge/local/provider.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { importTechnicalCorpus, removeTechnicalCorpus, technicalCorpus, TECHNICAL_SOURCE_ID } from '../src/knowledge/local/technical-corpus.js';
import { technicalArticles } from '../src/knowledge/sound-engineer/index.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const DIMS = 8;
async function newStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-techemb-'));
  dirs.push(dir);
  const store = new FileKnowledgeStore(join(dir, 'db.json'));
  await store.init();
  return store;
}
/** Provedor falso: registra cada texto enviado e permite derrubar o serviço no meio. */
function fakeEmbedder(opts: { up?: () => boolean; external?: boolean; failOn?: (call: number, texts: string[]) => boolean } = {}) {
  const sent: string[][] = [];
  let call = 0;
  const provider: AiProvider = {
    id: opts.external ? 'gemini' : 'ollama', external: !!opts.external,
    health: async (): Promise<ProviderHealth> => (opts.up?.() ?? true) ? { reachable: true, embedModel: true, chatModel: true, detail: 'ok' } : { reachable: false, embedModel: false, chatModel: false, detail: 'fora' },
    embed: async (texts) => { call++; sent.push(texts); if (opts.failOn?.(call, texts)) return undefined; return texts.map((_, i) => new Array(DIMS).fill(0.1 + i * 0.001)); },
    generateDetailed: async () => ({ failure: 'unavailable' }),
  };
  return { provider, sent, calls: () => call };
}
const totalChunks = () => technicalCorpus().length;
const rows = async (store: FileKnowledgeStore) => (await store.listDocuments()).filter((d) => d.sourceId === TECHNICAL_SOURCE_ID);

describe('import-technical com embeddings do provedor da coleção', () => {
  it('gera vetores para todos os trechos e registra documentos, trechos e embeddings', async () => {
    const store = await newStore();
    const e = fakeEmbedder();
    const r = await importTechnicalCorpus(store, e.provider);
    expect(r).toMatchObject({ imported: technicalArticles.length, unchanged: 0, repaired: 0, chunks: totalChunks(), embedded: totalChunks(), pending: 0, embeddings: 'complete', provider: 'ollama' });
    const docs = await rows(store);
    expect(docs).toHaveLength(technicalArticles.length);
    expect(docs.every((d) => d.embedded === d.chunks && d.chunks > 0)).toBe(true);
    expect(docs.reduce((n, d) => n + d.embedded, 0)).toBe(totalChunks());
  });

  it('é idempotente: a segunda execução não regrava nem chama o provedor', async () => {
    const store = await newStore();
    const e = fakeEmbedder();
    await importTechnicalCorpus(store, e.provider);
    const callsAfterFirst = e.calls();
    const again = await importTechnicalCorpus(store, e.provider);
    expect(again).toMatchObject({ imported: 0, unchanged: technicalArticles.length, repaired: 0, embeddings: 'complete', pending: 0 });
    expect(e.calls()).toBe(callsAfterFirst);
  });

  it('provedor indisponível: documentos preservados e embeddings marcados como pendentes; depois é reparado', async () => {
    const store = await newStore();
    let up = false;
    const e = fakeEmbedder({ up: () => up });
    const first = await importTechnicalCorpus(store, e.provider);
    expect(first).toMatchObject({ imported: technicalArticles.length, embedded: 0, pending: totalChunks(), embeddings: 'pending' });
    expect(e.calls()).toBe(0); // nem tenta embeddar sem saúde
    expect((await rows(store)).every((d) => d.embedded === 0 && d.chunks > 0)).toBe(true); // busca por palavras continua possível
    // ainda fora do ar: nada muda e nada é apagado
    const still = await importTechnicalCorpus(store, e.provider);
    expect(still).toMatchObject({ imported: 0, unchanged: technicalArticles.length, pending: totalChunks(), embeddings: 'pending' });
    // volta: só repara (não reimporta)
    up = true;
    const repaired = await importTechnicalCorpus(store, e.provider);
    expect(repaired).toMatchObject({ imported: 0, repaired: technicalArticles.length, embedded: totalChunks(), pending: 0, embeddings: 'complete' });
    expect((await importTechnicalCorpus(store, e.provider)).unchanged).toBe(technicalArticles.length);
  });

  it('queda no meio é retomável: só os documentos sem vetor são refeitos na execução seguinte', async () => {
    const store = await newStore();
    // Alguns documentos nunca conseguem vetor nesta rodada (nem na nova tentativa por lote), como numa queda parcial.
    const bad = new Set(technicalCorpus().filter((c) => technicalArticles.findIndex((a) => a.id === c.articleId) % 3 === 1).map((c) => c.text));
    const e = fakeEmbedder({ failOn: (_n, texts) => texts.some((t) => bad.has(t)) });
    const first = await importTechnicalCorpus(store, e.provider);
    expect(first.imported).toBe(technicalArticles.length);
    expect(first.pending).toBeGreaterThan(0);
    expect(first.embedded).toBeGreaterThan(0);
    expect(first.embeddings).toBe('partial');
    const withVectors = (await rows(store)).filter((d) => d.embedded >= d.chunks).length;
    expect(withVectors).toBeGreaterThan(0);
    expect(withVectors).toBeLessThan(technicalArticles.length);
    // Provedor estável de novo: repara apenas o que faltava.
    const stable = fakeEmbedder();
    const second = await importTechnicalCorpus(store, stable.provider);
    expect(second).toMatchObject({ imported: 0, pending: 0, embeddings: 'complete' });
    expect(second.repaired).toBe(technicalArticles.length - withVectors);
    expect(second.unchanged).toBe(withVectors);
    expect(stable.sent.flat().length).toBeLessThan(totalChunks()); // não reenviou o que já tinha vetor
  });

  it('preserva todas as outras fontes e documentos; a remoção continua restrita ao corpus técnico', async () => {
    const store = await newStore();
    await store.replaceDocument({ sourceId: 'shure-live', fileName: 'manual.md', sha256: 'old', bytes: 1, chunks: [{ ordinal: 0, text: 'Posicionamento de microfones.', locator: 'p1', embedding: new Array(DIMS).fill(0.5) }] });
    await store.replaceDocument({ sourceId: 'local-ensaio', fileName: 'privado.md', sha256: 'x', bytes: 1, chunks: [{ ordinal: 0, text: 'SEGREDO-DA-BANDA', locator: 'p1' }] });
    const before = (await store.listDocuments()).filter((d) => d.sourceId !== TECHNICAL_SOURCE_ID);
    const e = fakeEmbedder();
    await importTechnicalCorpus(store, e.provider);
    expect((await store.listDocuments()).filter((d) => d.sourceId !== TECHNICAL_SOURCE_ID)).toEqual(before);
    expect(e.sent.flat().join('\n')).not.toContain('SEGREDO-DA-BANDA');
    expect((await removeTechnicalCorpus(store)).removed).toBe(technicalArticles.length);
    expect(await store.listDocuments()).toEqual(before);
  });

  it('provedor externo recebe só o corpus técnico público e versionado, nunca documento do operador', async () => {
    const store = await newStore();
    await store.replaceDocument({ sourceId: 'local-ensaio', fileName: 'privado.md', sha256: 'x', bytes: 1, chunks: [{ ordinal: 0, text: 'SEGREDO-DA-BANDA contrato e cachê', locator: 'p1' }] });
    const e = fakeEmbedder({ external: true });
    const r = await importTechnicalCorpus(store, e.provider);
    expect(r).toMatchObject({ embeddings: 'complete', provider: 'gemini' });
    const allowed = new Set(technicalCorpus().map((c) => c.text));
    for (const text of e.sent.flat()) expect(allowed.has(text)).toBe(true);
    expect(e.sent.flat().join('\n')).not.toMatch(/SEGREDO-DA-BANDA|cachê/);
  });

  it('sem provedor: grava os trechos e informa que não há embeddings (comportamento anterior preservado)', async () => {
    const store = await newStore();
    const r = await importTechnicalCorpus(store);
    expect(r).toMatchObject({ imported: technicalArticles.length, chunks: totalChunks(), embedded: 0, pending: totalChunks(), embeddings: 'none' });
    expect(r.provider).toBeUndefined();
  });

  it('o provedor recebe os trechos como documento (e nunca recebe a pergunta nem configuração)', async () => {
    const store = await newStore();
    const kinds: Array<string | undefined> = [];
    const e = fakeEmbedder();
    const original = e.provider.embed.bind(e.provider);
    e.provider.embed = vi.fn(async (texts, kind) => { kinds.push(kind); return original(texts, kind); });
    await importTechnicalCorpus(store, e.provider);
    expect(new Set(kinds)).toEqual(new Set(['document']));
  });
});
