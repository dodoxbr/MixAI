#!/usr/bin/env node
/**
 * Base de conhecimento local: diagnóstico do ambiente, importação do pacote, ingestão e busca.
 * Não conecta à mesa e não inicia o servidor. Uso: npm run knowledge -- <comando>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { loadConfig } from './core/config.js';
import { join } from 'node:path';
import { evalLive, loadCorpus, loadRelevance, runEval, type EvalReport, type MethodReport } from './knowledge/local/eval.js';
import { openLocalKnowledge } from './knowledge/local/index.js';
import { inboxPath } from './knowledge/local/open.js';
import { OllamaClient } from './knowledge/local/ollama.js';
import { readPackFromDir } from './knowledge/local/pack.js';
import { PROJECT_ROOT } from './core/config.js';

export const KNOWLEDGE_HELP = `MixAI — base de conhecimento local (somente leitura de documentos; não toca na mesa).
  npm run knowledge -- doctor                 verifica Docker, PostgreSQL, Ollama e a base
  npm run knowledge -- import-technical       indexa sínteses técnicas versionadas e gera embeddings com o provedor da coleção (idempotente; repete para completar pendentes)
  npm run knowledge -- remove-technical       remove só essas sínteses, preservando manuais
  npm run knowledge -- import-seed            importa o pacote base versionado (knowledge/seed)
  npm run knowledge -- import-zip ARQUIVO.zip importa um pacote .zip (catalog, microfones, casos)
  npm run knowledge -- ingest                 ingere .md/.txt/.pdf de data/knowledge/inbox
  npm run knowledge -- search "texto"         busca trechos na base
  npm run knowledge -- eval [opções]          mede a relevância da busca (índice temporário; não altera a base)
      --embed-model M --dims N [--query-prefix P --doc-prefix P] --k 4 --min-score 0.3 --sweep 0.45,0.5,0.55 --json ARQUIVO
      --live   avalia a base real em uso (sem reindexar)
Requer "knowledge: {enabled: true}" no config/config.local.yaml.`;

function docker(): string {
  try {
    return execFileSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  } catch {
    return 'não encontrado (opcional: sem Docker a base usa arquivo local)';
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);
function printMethod(write: (s: string) => void, m: MethodReport): void {
  write(`  ${m.method.padEnd(8)} Hit@1 ${pct(m.hit1)}  Hit@3 ${pct(m.hit3)}  Hit@k ${pct(m.hitK)}  MRR ${m.mrr.toFixed(2)}  Prec@k ${pct(m.precisionK)}  sem acerto: ${m.misses.length ? m.misses.join(', ') : '—'}`);
}
export function printEval(write: (s: string) => void, r: EvalReport): void {
  write(`Modelo: ${r.embedder}${r.dimensions ? ` (${r.dimensions} dim)` : ''} · ${r.chunks} trechos · ${r.cases} perguntas · k=${r.k} · limiar ${r.minScore}`);
  write(`Tempo: indexar ${(r.indexMs / 1000).toFixed(1)} s · ${r.queryMs} ms por pergunta`);
  for (const m of r.methods) printMethod(write, m);
  const topics = Object.keys(r.methods[0]?.byTopic ?? {});
  write('  Acerto@k por tema: ' + topics.map((t) => `${t} ${r.methods.map((m) => `${m.byTopic[t]!.hitK}/${m.byTopic[t]!.cases}`).join('|')}`).join(' · '));
  if (r.scoreStats) {
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
    write(`  Cosseno do 1º vetorial: relevantes mediana ${med(r.scoreStats.relevantTop1) ?? '—'} (n=${r.scoreStats.relevantTop1.length}) · outros mediana ${med(r.scoreStats.otherTop1) ?? '—'} (n=${r.scoreStats.otherTop1.length})${r.scoreStats.suggestedMinScore !== undefined ? ` · limiar sugerido ≈ ${r.scoreStats.suggestedMinScore}` : ''}`);
  }
}

async function runEvalCommand(args: string[], write: (s: string) => void): Promise<number> {
  const loaded = loadConfig();
  const o = loaded.config.knowledge.ollama;
  const k = Number(flag(args, '--k') ?? 4);
  const minScore = Number(flag(args, '--min-score') ?? o.minScore);
  const cases = loadRelevance(join(PROJECT_ROOT, 'knowledge', 'eval', 'relevance-ptbr.json'));
  let report: EvalReport | undefined;
  if (args.includes('--live')) {
    const live = await openLocalKnowledge(loaded, { log: write });
    if (!live) { write('knowledge.enabled está desligado.'); return 1; }
    try {
      const m = await evalLive(async (q) => (await live.search(q)).passages, cases, k);
      write(`Base REAL em uso (${(await live.status()).chunks} trechos; julgado pelo trecho exibido)`);
      printMethod(write, m);
      write('  Acerto@k por tema: ' + Object.entries(m.byTopic).map(([t, v]) => `${t} ${v.hitK}/${v.cases}`).join(' · '));
      return 0;
    } finally { await live.close(); }
  }
  const model = flag(args, '--embed-model') ?? o.embedModel;
  const dims = Number(flag(args, '--dims') ?? o.embedDimensions);
  const queryPrefix = flag(args, '--query-prefix') ?? o.queryPrefix;
  const documentPrefix = flag(args, '--doc-prefix') ?? o.documentPrefix;
  const ollama = new OllamaClient({ url: o.url, embedModel: model, chatModel: o.chatModel, embedDimensions: dims, timeoutMs: Math.max(o.timeoutMs, 60_000), queryPrefix, documentPrefix });
  const health = await ollama.health(true);
  if (!health.reachable || !health.embedModel) { write(`Ollama sem o modelo ${model}: rode "ollama pull ${model}".`); return 1; }
  const catalogIds = new Set(readPackFromDir(join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2')).catalog.map((c) => c.id));
  const chunks = await loadCorpus(inboxPath(loaded.dataDir ?? join(PROJECT_ROOT, 'data'), loaded.config.knowledge.inboxDir), catalogIds);
  const sweep = (flag(args, '--sweep') ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n < 1);
  report = await runEval({ chunks, cases, k, minScore, sweep, embedder: { name: `${model}${queryPrefix || documentPrefix ? ' + prefixos' : ''}`, embed: (t, kind) => ollama.embed(t, kind) } });
  printEval(write, report);
  const out = flag(args, '--json');
  if (out) { (await import('node:fs')).writeFileSync(out, JSON.stringify(report, null, 2)); write(`Relatório salvo em ${out}`); }
  return 0;
}

export async function runKnowledgeCli(args: string[], write: (s: string) => void = console.log): Promise<number> {
  const [cmd, arg] = args;
  if (!cmd || cmd === '--help') { write(KNOWLEDGE_HELP); return cmd ? 0 : 1; }
  try {
    if (cmd === 'eval') return await runEvalCommand(args.slice(1), write);
    const loaded = loadConfig();
    if (!loaded.config.knowledge.enabled) {
      write('knowledge.enabled está desligado. Ligue em config/config.local.yaml:\n  knowledge:\n    enabled: true');
      return 1;
    }
    const k = await openLocalKnowledge(loaded, { log: write });
    if (!k) return 1;
    try {
      if (cmd === 'doctor') {
        const s = await k.status();
        write(`Docker:    ${docker()}`);
        write(`Base:      ${s.store.kind}${s.store.fallbackFrom ? ` (caiu de ${s.store.fallbackFrom})` : ''} — ${s.store.ok ? 'ok' : 'com problema'}: ${s.store.detail}`);
        write(`Ollama:    ${s.ollama.reachable ? 'acessível' : 'indisponível'} (embeddings: ${s.ollama.embedModel ? 'sim' : 'não'}, chat: ${s.ollama.chatModel ? 'sim' : 'não'}) — ${s.ollama.detail}`);
        write(`Conteúdo:  ${s.sources} fonte(s), ${s.documents} documento(s), ${s.chunks} trecho(s), ${s.embeddedChunks} com embedding`);
        write(`Modo:      ${s.mode} — ${s.note}`);
        return 0;
      }
      if (cmd === 'import-technical') { write(JSON.stringify(await k.importTechnical())); return 0; }
      if (cmd === 'remove-technical') { write(JSON.stringify(await k.removeTechnical())); return 0; }
      if (cmd === 'import-seed') { write(JSON.stringify(await k.importSeed())); return 0; }
      if (cmd === 'import-zip') {
        if (!arg || statSync(arg).size > 5 * 1024 * 1024) { write('Informe um .zip de até 5 MB.'); return 1; }
        write(JSON.stringify(await k.importZip(new Uint8Array(readFileSync(arg))))); return 0;
      }
      if (cmd === 'ingest') {
        const report = await k.ingest();
        for (const i of report.items) write(`${i.status.padEnd(9)} ${i.file}${i.chunks !== undefined ? ` (${i.chunks} trechos, ${i.embedded ?? 0} com embedding)` : ''}${i.reason ? ` — ${i.reason}` : ''}`);
        write(`Embeddings: ${report.embeddings === 'available' ? 'disponíveis' : 'indisponíveis (busca por palavras)'}`);
        return report.items.some((i) => i.status === 'failed') ? 1 : 0;
      }
      if (cmd === 'search') {
        const r = await k.search(args.slice(1).join(' '));
        write(`modo: ${r.mode}${r.reason ? ` — ${r.reason}` : ''}`);
        for (const p of r.passages) write(`- [${p.title} ${p.locator}] ${p.excerpt}`);
        return 0;
      }
      write(KNOWLEDGE_HELP);
      return 1;
    } finally {
      await k.close();
    }
  } catch (err) {
    // Mensagem curta: nunca inclui senha, SQL ou conteúdo de documentos.
    write(`Falhou: ${err instanceof Error ? err.message.slice(0, 160).replace(/[\r\n]+/g, ' ') : 'erro'}`);
    return 1;
  }
}

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = await runKnowledgeCli(process.argv.slice(2));
