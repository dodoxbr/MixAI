import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ProviderId } from './provider.js';

/**
 * Escolha do operador para o provedor do resumo, em data/knowledge/provider.json (fora do Git).
 * Guarda só o nome do provedor: nunca chave, URL ou texto. Arquivo corrompido é ignorado (vale o
 * padrão da configuração) e nunca derruba o servidor.
 */
const schema = z.strictObject({ version: z.literal(1), chat: z.enum(['ollama', 'gemini']) });

export function readChatPreference(path: string): ProviderId | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data.chat : undefined;
  } catch {
    return undefined;
  }
}

export function writeChatPreference(path: string, chat: ProviderId): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, chat }), { mode: 0o600 });
  renameSync(tmp, path);
}
