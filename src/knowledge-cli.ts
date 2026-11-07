#!/usr/bin/env node
/**
 * Base de conhecimento local: diagnóstico do ambiente, importação do pacote, ingestão e busca.
 * Não conecta à mesa e não inicia o servidor. Uso: npm run knowledge -- <comando>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { loadConfig } from './core/config.js';
import { openLocalKnowledge } from './knowledge/local/index.js';

export const KNOWLEDGE_HELP = `MixAI — base de conhecimento local (somente leitura de documentos; não toca na mesa).
  npm run knowledge -- doctor                 verifica Docker, PostgreSQL, Ollama e a base
  npm run knowledge -- import-seed            importa o pacote base versionado (knowledge/seed)
  npm run knowledge -- import-zip ARQUIVO.zip importa um pacote .zip (catalog, microfones, casos)
  npm run knowledge -- ingest                 ingere .md/.txt/.pdf de data/knowledge/inbox
  npm run knowledge -- search "texto"         busca trechos na base
Requer "knowledge: {enabled: true}" no config/config.local.yaml.`;

function docker(): string {
  try {
    return execFileSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  } catch {
    return 'não encontrado (opcional: sem Docker a base usa arquivo local)';
  }
}

export async function runKnowledgeCli(args: string[], write: (s: string) => void = console.log): Promise<number> {
  const [cmd, arg] = args;
  if (!cmd || cmd === '--help') { write(KNOWLEDGE_HELP); return cmd ? 0 : 1; }
  try {
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
