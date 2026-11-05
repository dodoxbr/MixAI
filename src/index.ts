#!/usr/bin/env node
/**
 * MCP do MixAI (Claude Desktop). A partir da E2 é só um CLIENTE do servidor único:
 * não monta mesa, laboratório nem controlador. Se o servidor não estiver rodando, as tools
 * respondem SERVER_UNAVAILABLE e nada acontece na mesa.
 */
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, PROJECT_ROOT, serverPort } from './core/config.js';
import { RemoteBackend } from './mcp/remote.js';
import { createMcpServer } from './mcp/server.js';

// Atenção: num servidor MCP via stdio, a saída padrão é do protocolo. Mensagens vão para stderr.
const info = (msg: string) => process.stderr.write(`[mixai] ${msg}\n`);

async function main() {
  const loaded = loadConfig();
  const mode = loaded.config.mixer.mode;
  const port = serverPort(loaded.config);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = loaded.dataDir ?? join(PROJECT_ROOT, 'data');
  const backend = new RemoteBackend({ baseUrl, mode, tokenFile: join(dataDir, `agent-${mode}.token`) });
  info(`cliente do servidor MixAI (modo ${mode.toUpperCase()}) em ${baseUrl}`);

  const server = createMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  transport.onclose = shutdown;
}

main().catch((err) => {
  info(`erro fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
