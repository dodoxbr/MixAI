import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { evaluateTechnicalCorpus } from '../scripts/eval-technical-knowledge.js';
import { PROJECT_ROOT } from '../src/core/config.js';
import { loadRelevance } from '../src/knowledge/local/eval.js';
import { technicalCorpus } from '../src/knowledge/local/technical-corpus.js';

it('reproduz avaliação offline separando relevância do trecho exibido de correção técnica', async () => {
  const prior = readFileSync(join(PROJECT_ROOT, 'knowledge/eval/relevance-ptbr.json'), 'utf8');
  const r = await evaluateTechnicalCorpus();
  expect(r.scope).toBe('controlled_seed_keyword_only'); expect(r.before.cases).toBe(24);
  expect(r.additionalAfter.cases).toBe(12); expect(r.after.embedder).toBe('nenhum (só palavras)');
  expect(r.displayedAfter.hitK).toBeGreaterThan(r.displayedBefore.hitK);
  expect(r.displayedAfter.byTopic['voz abafada']!.hitK).toBeGreaterThan(r.displayedBefore.byTopic['voz abafada']!.hitK);
  expect(r.displayedAfter.hitK).toBeLessThan(1); // unresolved original cases are reported, not relabeled
  expect(r.displayedAdditionalAfter.hitK).toBeGreaterThan(r.displayedAdditionalBefore.hitK);
  expect(loadRelevance(join(PROJECT_ROOT, 'knowledge/eval/relevance-ptbr.json'))).toHaveLength(24);
  expect(readFileSync(join(PROJECT_ROOT, 'knowledge/eval/relevance-ptbr.json'), 'utf8')).toBe(prior);
  expect(technicalCorpus().every(c => c.text.length <= 420)).toBe(true);
  expect(r.limitation).toContain('não mede correção técnica');
});
