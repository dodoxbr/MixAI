import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { setup } from './helpers.js';

async function connected() {
  const ctx = await setup();
  const server = createMcpServer(ctx.controller);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
  };
  return { ...ctx, client, call };
}

describe('servidor MCP', () => {
  it('expõe as tools previstas e as instruções', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(client.getInstructions()).toContain('pagode');
    // Nenhuma tool mexe em ganho de entrada ou phantom.
    expect(tools.some((t) => /gain|ganho|phantom/i.test(t.name))).toBe(false);
  });

  it('fluxo completo: estado, ajuste, retorno, confirmação e desfazer', async () => {
    const { call, mixer } = await connected();

    expect((await call('mixer_status')).text).toContain('simulada');
    const state = await call('get_mix_state');
    expect(state.text).toContain('"name": "Cavaco"');

    const up = await call('set_channel_level', { channel: 'voz 2', delta_db: 2 });
    expect(up.isError).toBe(false);
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-8);

    await call('set_aux_send', { channel: 'voz 1', aux: 'retorno do cavaco', delta_db: 3 });
    expect(await mixer.getLevelDB(1, auxBus(2))).toBe(-17);

    const big = await call('set_master_level', { delta_db: 2 });
    expect(big.isError).toBe(false); // pedir confirmação não é erro
    expect(big.text).toContain('confirm=true');
    expect(await mixer.getMasterDB()).toBe(-6);

    await call('undo_last', { steps: 2 });
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-10);
    expect(await mixer.getLevelDB(1, auxBus(2))).toBe(-20);

    const log = await call('get_action_log');
    expect(log.text).toContain('undo');
  });

  it('erros voltam como isError com mensagem em português', async () => {
    const { call } = await connected();
    const r = await call('set_channel_level', { channel: 'trombone', db: -5 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Não reconheci');
  });

  it('valida os parâmetros (db fora da faixa)', async () => {
    const { call, mixer } = await connected();
    const r = await call('set_channel_level', { channel: 'voz 1', db: 40 });
    expect(r.isError).toBe(true);
    expect(mixer.writes).toHaveLength(0);
  });

  it('-Infinity vira "-inf" no JSON', async () => {
    const { call, mixer } = await connected();
    await mixer.setLevelDB(5, MASTER, -Infinity);
    const r = await call('get_mix_state');
    expect(r.text).toContain('"levelDB": "-inf"');
  });
});
