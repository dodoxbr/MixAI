#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from './core/app.js';
import { createMcpServer } from './mcp/server.js';

// Atenção: num servidor MCP via stdio, a saída padrão é do protocolo. Mensagens vão para stderr.
const info = (msg: string) => process.stderr.write(`[mixai] ${msg}\n`);

async function main() {
  const { loaded, mixer, controller } = createApp();
  info(`modo: ${loaded.config.mixer.mode === 'mock' ? 'mesa simulada' : `mesa real em ${loaded.config.mixer.ip}`}`);

  // Conecta já na partida, mas não derruba o servidor se a mesa estiver fora:
  // a tool mixer_status tenta de novo.
  try {
    await mixer.connect();
    info(mixer.statusText());
  } catch (err) {
    info(`sem conexão por enquanto: ${(err as Error).message}`);
  }

  const server = createMcpServer(controller);
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await mixer.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  info(`erro fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
