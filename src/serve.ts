#!/usr/bin/env node
/**
 * Servidor único do MixAI (E2): dono da mesa, do estado, das confirmações e dos usuários.
 * O assistente (MCP), as telas e os celulares são todos clientes dele.
 *
 *   npm run serve:lab    laboratório, http://127.0.0.1:8790
 *   npm run serve:real   mesa física, http://127.0.0.1:8791
 */
import { loadConfig } from './core/config.js';
import { OwnerLockError } from './core/owner-lock.js';
import { startServer } from './server/start.js';

const info = (msg: string) => process.stderr.write(`[mixai-server] ${msg}\n`);

async function main() {
  const loaded = loadConfig();
  const mode = loaded.config.mixer.mode;
  info(
    `modo: ${mode === 'lab' ? `LABORATÓRIO (${loaded.labFile})` : mode === 'mock' ? 'simulador em memória' : `MESA REAL em ${loaded.config.mixer.ip}`}`,
  );
  const server = await startServer(loaded, { log: info });
  info(server.app.mixer.statusText());
  for (const url of server.urls) info(`escutando em ${url}`);
  const auth = server.core.auth.configured();
  if (!auth.operator) info('ATENÇÃO: PIN do operador não configurado. Rode "npm run pin -- operador".');
  if (!auth.musician) info('PIN dos músicos não configurado (opcional). Rode "npm run pin -- musico".');
  if (server.urls.length === 1) info('acesso só neste notebook (para os celulares, configure server.lan no config.yaml).');

  const shutdown = async () => {
    info('desligando...');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err instanceof OwnerLockError) info(err.message);
  else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') info(`a porta já está em uso: já existe um servidor do MixAI rodando? (${(err as Error).message})`);
  else info(`erro fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
