/** Controlled offline comparison; does NOT recreate the private ROG/PostgreSQL corpus. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/core/config.js';
import { evalLive, loadRelevance, runEval, type EvalChunk } from '../src/knowledge/local/eval.js';
import { readPackFromDir } from '../src/knowledge/local/pack.js';
import { extractChunks } from '../src/knowledge/local/ingest.js';
import { technicalCorpus } from '../src/knowledge/local/technical-corpus.js';

export async function evaluateTechnicalCorpus() {
  // Unmodified prior seed is the only small, redistributable local corpus committed to this repo.
  // Its case narratives are a controlled baseline, NOT the 367 PDF chunks on the ROG.
  const pack = readPackFromDir(join(PROJECT_ROOT, 'knowledge/seed/banda-v1_2'));
  const baseline: EvalChunk[] = [];
  for (const c of pack.cases.cases) {
    const text = `# ${c.title}\n\n${[...c.investigation, ...c.hypotheses, c.safety].join(' ')}`;
    const { chunks } = await extractChunks(Buffer.from(text), '.md');
    baseline.push(...chunks.map(x => ({ ...x, sourceId: `baseline-${c.id}` })));
  }
  const original = loadRelevance(join(PROJECT_ROOT, 'knowledge/eval/relevance-ptbr.json'));
  const additional = loadRelevance(join(PROJECT_ROOT, 'knowledge/eval/field-cases-ptbr.json'));
  const evaluate = (chunks: EvalChunk[], cases: typeof original) => runEval({ chunks, cases, k: 4, methods: ['keyword'] });
  const visible = async (chunks: EvalChunk[], cases: typeof original) => {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-visible-'));
    try {
      const store = new FileKnowledgeStore(join(dir, 'eval.json')); await store.init();
      for (const [i, c] of chunks.entries()) await store.replaceDocument({ sourceId: c.sourceId, fileName: `chunk-${i}.md`, sha256: String(i), bytes: 0, chunks: [{ ordinal: 0, text: c.text, locator: c.locator }] });
      return await evalLive(q => store.search(q, undefined, 4), cases, 4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const [displayedBefore, displayedAfter, displayedAdditionalBefore, displayedAdditionalAfter] = await Promise.all([visible(baseline, original), visible([...baseline, ...technicalCorpus()], original), visible(baseline, additional), visible([...baseline, ...technicalCorpus()], additional)]);
  const [before, after, extraBefore, extraAfter] = await Promise.all([
    evaluate(baseline, original), evaluate([...baseline, ...technicalCorpus()], original),
    evaluate(baseline, additional), evaluate([...baseline, ...technicalCorpus()], additional),
  ]);
  return { schemaVersion: 1, scope: 'controlled_seed_keyword_only', libraryVersion: '1.0.0',
    limitation: 'Não reproduz o corpus privado do ROG, vetores Gemini/Ollama ou respostas de IA. Acerto de busca não mede correção técnica; julgamento automático usa critérios de conteúdo preexistentes.',
    before, after, displayedBefore, displayedAfter, displayedAdditionalBefore, displayedAdditionalAfter, additionalBefore: extraBefore, additionalAfter: extraAfter };
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const report = await evaluateTechnicalCorpus();
  const text = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2]) writeFileSync(process.argv[2], text); else process.stdout.write(text);
}
