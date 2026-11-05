import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

// Prova de isolamento: o MCP (cliente) não pode nem CARREGAR a mesa, o laboratório ou o controlador.
const probe = vi.hoisted(() => ({ loaded: [] as string[] }));
for (const mod of ['../src/mixer/real.js', '../src/mixer/lab.js', '../src/mixer/simulated.js', '../src/core/controller.js', 'soundcraft-ui-connection']) {
  vi.doMock(mod, async (importOriginal) => {
    probe.loaded.push(mod);
    return importOriginal();
  });
}

const { RemoteBackend } = await import('../src/mcp/remote.js');
const { createMcpServer } = await import('../src/mcp/server.js');

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function mcpWith(backend: InstanceType<typeof RemoteBackend>) {
  const server = createMcpServer(backend);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '1.0.0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
  };
}

describe('MCP como cliente: sem servidor', () => {
  it('sem servidor rodando: erro claro em todas as tools, nenhuma conexão física e nada da mesa carregado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-mcp-'));
    const port = await freePort();
    const call = await mcpWith(
      new RemoteBackend({ baseUrl: `http://127.0.0.1:${port}`, mode: 'lab', tokenFile: join(dir, 'agent-lab.token') }),
    );
    for (const [tool, args] of [
      ['mixer_status', {}],
      ['set_channel_level', { channel: 'voz 1', delta_db: 2 }],
      ['set_master_level', { delta_db: -1 }],
      ['list_channels', {}],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('[SERVER_UNAVAILABLE]');
      expect(r.text).toContain('npm run serve:lab');
    }
    // Token antigo presente, mas servidor parado (ECONNREFUSED): mesma resposta.
    writeFileSync(join(dir, 'agent-lab.token'), 'token-velho');
    const r = await call('set_channel_level', { channel: 'voz 1', delta_db: 2 });
    expect(r.text).toContain('[SERVER_UNAVAILABLE]');
    expect(r.text).toContain('não está rodando');
    expect(probe.loaded).toEqual([]);
  });

  it('as 11 tools continuam as mesmas', async () => {
    const server = createMcpServer(new RemoteBackend({ baseUrl: 'http://127.0.0.1:1', mode: 'lab', tokenFile: 'x' }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_action_log',
      'get_mix_state',
      'list_channels',
      'list_snapshots',
      'load_snapshot',
      'mixer_status',
      'mute_channel',
      'set_aux_send',
      'set_channel_level',
      'set_master_level',
      'undo_last',
    ]);
    expect(client.getInstructions()).toContain('tela do OPERADOR');
  });
});
