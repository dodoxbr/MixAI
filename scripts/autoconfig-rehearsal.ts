/** Offline contract rehearsal; these responses are fixtures, NOT live Gemini/Qwen quality. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { autoConfigCases, bandKnowledgeAdapter, TechnicalPlanner, type PlannerProvider } from '../src/autoconfig/index.js';

export async function rehearseAutoConfig() {
  const names = new ChannelMap(parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), { inputs: 12, aux: 6 });
  const knowledge = bandKnowledgeAdapter(names);
  const report = [];
  for (const selected of ['gemini', 'ollama']) {
    const provider: PlannerProvider = { id: selected, external: selected === 'gemini', generate: async () => ({ text: JSON.stringify({ kind: 'proposal', candidate: 's1', evidence: ['e1'] }) }) };
    const p = new TechnicalPlanner({ knowledge, providers: [provider], policy: () => ({ enabled: true, active: true, selected, externalConsent: true, revision: 1 }) });
    for (const c of autoConfigCases) {
      const r = await p.plan(c.input);
      report.push({ modelFixture: selected === 'gemini' ? 'Gemini (fake)' : 'Qwen3/Ollama (fake)', case: c.id, status: r.kind,
        grounded: r.kind === 'proposal' && r.proposal.suggestions.every(s => s.candidate.references.length > 0 && s.candidate.preconditions.length > 0),
        validationAndRollback: r.kind === 'proposal' && r.proposal.suggestions.every(s => !!s.candidate.verification && !!s.rollback.instruction && !s.rollback.automatic),
        numericTarget: r.kind === 'proposal' ? r.proposal.suggestions[0].targetValue : null, measurements: r.measurements,
        authorization: r.authorization, execution: r.execution });
      const unsafe = await p.plan({ ...c.input, mode: 'REAL' });
      report.push({ modelFixture: selected === 'gemini' ? 'Gemini (fake)' : 'Qwen3/Ollama (fake)', case: `${c.id}-real-refused`, status: unsafe.kind,
        refusedCorrectly: unsafe.kind === 'refusal', execution: unsafe.execution });
    }
  }
  return { schemaVersion: 1, mode: 'offline_fixtures_only', limitation: 'Qualidade de contrato/fundamentação, não comparação de fluência ou qualidade de modelos reais. Nenhum serviço, segredo ou equipamento usado.', results: report };
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const text = JSON.stringify(await rehearseAutoConfig(), null, 2) + '\n';
  if (process.argv[2]) writeFileSync(process.argv[2], text); else process.stdout.write(text);
}
