import { isAbsolute, join, resolve, sep } from 'node:path';
import type { AppConfig, LoadedConfig } from '../../core/config.js';
import { PROJECT_ROOT } from '../../core/config.js';
import { GeminiClient } from './gemini.js';
import { OllamaClient } from './ollama.js';
import { readChatPreference, writeChatPreference } from './preference.js';
import type { AiProvider, ProviderId } from './provider.js';
import { createPgClient, PgKnowledgeStore, type SqlClient } from './pg-store.js';
import { LocalKnowledge } from './service.js';
import { FileKnowledgeStore, type KnowledgeStore } from './store.js';

export interface OpenDeps { fetch?: typeof fetch; geminiFetch?: typeof fetch; pgClient?: SqlClient; clock?: () => number; log?: (msg: string) => void }

/** Pasta de ingestão sempre dentro de data/: caminho relativo, sem "..", sem atalhos. */
export function inboxPath(dataDir: string, rel: string): string {
  const base = resolve(dataDir);
  const full = resolve(base, rel);
  if (isAbsolute(rel) || (full !== base && !full.startsWith(base + sep))) throw new Error('knowledge.inboxDir deve ficar dentro de data/.');
  return full;
}

/**
 * Monta a base local a partir da configuração. Retorna undefined com `knowledge.enabled: false`
 * (comportamento idêntico ao de antes). Se store=postgres falhar, cai para o arquivo local e
 * informa o motivo no status; o MixAI nunca deixa de subir por causa da base.
 */
export async function openLocalKnowledge(loaded: LoadedConfig, deps: OpenDeps = {}): Promise<LocalKnowledge | undefined> {
  const k: AppConfig['knowledge'] = loaded.config.knowledge;
  if (!k.enabled) return undefined;
  const dataDir = loaded.dataDir ?? join(PROJECT_ROOT, 'data');
  const clock = deps.clock ?? Date.now;
  const ollama = new OllamaClient({ url: k.ollama.url, embedModel: k.ollama.embedModel, chatModel: k.ollama.chatModel, embedDimensions: k.ollama.embedDimensions, timeoutMs: k.ollama.timeoutMs, generateTimeoutMs: k.ollama.narrativeTimeoutMs, queryPrefix: k.ollama.queryPrefix, documentPrefix: k.ollama.documentPrefix }, deps.fetch ?? fetch, clock);

  // Gemini (serviço externo): só existe com knowledge.gemini.enabled; a chave vem só de secrets/ambiente.
  const gemini = k.gemini.enabled
    ? new GeminiClient({ chatModel: k.gemini.chatModel, embedModel: k.gemini.embedModel, embedDimensions: k.gemini.embedDimensions, timeoutMs: k.gemini.timeoutMs, generateTimeoutMs: k.gemini.narrativeTimeoutMs, maxOutputTokens: k.gemini.maxOutputTokens, thinkingLevel: k.gemini.thinkingLevel }, loaded.secrets?.geminiApiKey, deps.geminiFetch ?? fetch, clock)
    : undefined;
  const embedder: AiProvider = k.embedProvider === 'gemini' && gemini ? gemini : ollama;
  const embedDimensions = embedder.id === 'gemini' ? k.gemini.embedDimensions : k.ollama.embedDimensions;
  const prefFile = join(dataDir, 'knowledge', 'provider.json');
  let chat: ProviderId = readChatPreference(prefFile) ?? k.chatProvider;
  if (chat === 'gemini' && !(gemini && gemini.configured)) {
    deps.log?.('Base de conhecimento: o Gemini foi escolhido mas não está habilitado ou sem chave; usando o Ollama local.');
    chat = 'ollama';
  }

  let store: KnowledgeStore | undefined;
  let fallbackFrom: string | undefined;
  const collection = k.collection;
  const schema = collection === 'default' ? 'public' : `kb_${collection}`;
  if (k.store === 'postgres') {
    const password = loaded.secrets?.postgresPassword;
    try {
      if (!password && !deps.pgClient) throw new Error('senha ausente (MIXAI_PG_PASSWORD ou postgresPassword em secrets.yaml)');
      const client = deps.pgClient ?? createPgClient({ host: k.postgres.host, port: k.postgres.port, database: k.postgres.database, user: k.postgres.user, password: password!, schema });
      const pg = new PgKnowledgeStore(client, embedDimensions, clock, schema);
      await pg.init();
      store = pg;
    } catch (err) {
      // A mensagem não inclui host, usuário nem senha.
      fallbackFrom = `postgres (${err instanceof Error ? err.message.split('\n')[0]!.slice(0, 80).replace(/password|senha=\S+/gi, '…') : 'erro'})`;
      deps.log?.(`Base de conhecimento: PostgreSQL indisponível, usando arquivo local.`);
    }
  }
  if (!store) {
    const file = new FileKnowledgeStore(join(dataDir, 'knowledge', collection === 'default' ? 'knowledge.json' : `knowledge-${collection}.json`), clock);
    await file.init();
    store = file;
  }
  return new LocalKnowledge({
    store, ollama: embedder,
    chatProviders: [ollama, ...(gemini ? [gemini] : [])],
    chat,
    onChatProvider: (id) => { try { writeChatPreference(prefFile, id); } catch { deps.log?.('Base de conhecimento: não foi possível gravar a escolha do provedor.'); } },
    inboxDir: inboxPath(dataDir, k.inboxDir),
    seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'),
    maxDocumentBytes: k.maxDocumentMB * 1024 * 1024,
    maxPassages: k.maxPassages,
    narrative: k.ollama.narrative,
    search: k.search,
    minScore: k.ollama.minScore,
    retrieval: k.retrieval,
    narrativeTimeoutMs: k.ollama.narrativeTimeoutMs,
    log: deps.log,
    storeFallbackFrom: fallbackFrom,
  });
}
