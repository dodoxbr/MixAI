#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from './core/app.js';
import { createMcpServer } from './mcp/server.js';

// Atenção: num servidor MCP via stdio, a saída padrão é do protocolo. Mensagens vão para stderr.
const info = (msg: string) => process.stderr.write(`[mixai] ${msg}\n`);

async function main() {
  const { loaded, mixer, controller } = await createApp();
  const mode = loaded.config.mixer.mode;
  info(
    `modo: ${mode === 'mock' ? 'mesa simulada (memória)' : mode === 'lab' ? `LABORATÓRIO (${loaded.labFile})` : `mesa real em ${loaded.config.mixer.ip}`}`,
  );
  // Laboratório: grava o que estiver pendente em qualquer saída (inclusive quando o Claude Desktop fecha).
  process.on('exit', () => mixer.flush?.());

  // Conecta já na partida, mas não derruba o servidor se a mesa estiver fora:
  // a tool mixer_status tenta de novo.
  try {
    await mixer.connect();
    info(mixer.statusText());
  } catch (err) {
    info(`sem conexão por enquanto: ${(err as Error).message}`);
  }

  const server = createMcpServer(controller);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await mixer.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  transport.onclose = () => void shutdown();
}

main().catch((err) => {
  info(`erro fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
