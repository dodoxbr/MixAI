import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Result } from '../core/controller.js';
import { jsonSafe } from '../core/log.js';
import type { MixBackend } from './backend.js';

export const SERVER_INSTRUCTIONS = `Você opera uma mesa de som Soundcraft Ui16 de uma banda de pagode pelo MixAI.
Regras:
- Use os nomes da banda ("voz 2", "cavaco", "surdo", "retorno do cavaco"). Na dúvida, chame list_channels.
- Antes de ajustes relativos importantes, veja o estado atual com get_mix_state.
- Prefira passos pequenos: "um pouco" = 2 dB, "mais" = 3 dB, "bastante" = 5 dB.
- Pedido sobre o que os músicos ouvem no fone = retorno (set_aux_send). O AUX 1 "Fones" é UMA mix compartilhada: mudar ali muda o fone de TODOS. Pedido sobre o som do público = PA (set_channel_level).
- Ações críticas devolvem code=NEEDS_CONFIRMATION: NADA foi alterado e o pedido foi para a tela do OPERADOR, que aprova ou recusa (vale 60 s). Você NÃO pode confirmar: confirmation_id enviado por você é recusado (FORBIDDEN). Diga ao usuário o que vai mudar e que precisa ser aprovado na tela do MixAI; depois confira com get_mix_state ou get_action_log.
- Se vier FORBIDDEN, a operação não é permitida para você; explique e não insista.
- Se vier SERVER_UNAVAILABLE, o servidor do MixAI não está rodando no notebook: peça para iniciá-lo. Você não controla a mesa sem ele.
- Na mesa real, "enviado" não é "confirmado": a Ui16 não confirma comandos. Não diga que a mesa aplicou; diga que foi enviado.
- Se vier PARTIAL, diga exatamente o que foi e o que NÃO foi enviado. Se vier NO_CONNECTION, RESYNCING, DEGRADED_READ_ONLY ou CONTROL_STOPPED, não tente de novo em loop; informe o usuário.
- Depois de cada mudança, diga em uma frase o que mudou e pergunte se melhorou. Se piorou, use undo_last.
- Você não ouve o som: baseie-se no que o usuário descreve e no estado da mesa. Não invente canais.`;

function reply(result: Result) {
  const lines = [`[${result.code}] ${result.message}`];
  if (result.data) lines.push(JSON.stringify(jsonSafe(result.data), null, 2));
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    isError: !result.ok && !result.needsConfirmation,
  };
}

const levelFields = {
  db: z.number().min(-100).max(10).optional().describe('Valor absoluto em dB. Use -100 para abaixar tudo.'),
  delta_db: z.number().min(-40).max(20).optional().describe('Mudança relativa em dB: +3 sobe, -3 desce.'),
  confirm: z
    .boolean()
    .optional()
    .describe('Obsoleto: sozinho NÃO executa. Use confirmation_id.'),
  confirmation_id: z
    .string()
    .max(64)
    .optional()
    .describe('Não use: a confirmação é feita só pelo operador, na tela do MixAI. Enviado pelo assistente, é recusado.'),
};

/**
 * Cria o servidor MCP com as 11 tools do MixAI. Em produção o backend é o cliente HTTP do
 * servidor único (RemoteBackend); nos testes pode ser o próprio controlador.
 */
export function createMcpServer(controller: MixBackend, version = '0.4.0'): McpServer {
  const server = new McpServer({ name: 'mixai', version }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    'mixer_status',
    {
      title: 'Status da mesa',
      description: 'Mostra se a mesa está conectada, o modo (real ou simulada) e o snapshot atual. Tenta reconectar se estiver desconectada.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => reply(await controller.ensureConnected()),
  );

  server.registerTool(
    'list_channels',
    {
      title: 'Canais e retornos',
      description: 'Lista os nomes da banda para os canais (entradas) e os retornos (AUX).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => reply(await controller.listNames()),
  );

  server.registerTool(
    'get_mix_state',
    {
      title: 'Estado da mix',
      description: 'Volume (dB) e mute de cada canal no master, ou no retorno informado em "aux".',
      inputSchema: {
        aux: z.string().optional().describe('Retorno a consultar (ex.: "retorno do cavaco", "aux 2"). Vazio = master.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ aux }) => reply(await controller.mixState(aux)),
  );

  server.registerTool(
    'set_channel_level',
    {
      title: 'Volume do canal no som do público',
      description: 'Muda o volume de um canal na mix principal (master). Use db (absoluto) OU delta_db (relativo).',
      inputSchema: {
        channel: z.string().describe('Canal pelo nome da banda ou número (ex.: "voz 2", "cavaco", "6").'),
        ...levelFields,
      },
    },
    async ({ channel, db, delta_db, confirm, confirmation_id }) =>
      reply(await controller.setLevel({ channel, db, deltaDB: delta_db, confirm, confirmationId: confirmation_id })),
  );

  server.registerTool(
    'set_aux_send',
    {
      title: 'Volume do canal num retorno',
      description: 'Muda quanto de um canal vai para o retorno de um músico (AUX). Ex.: "sobe a voz 1 no retorno do cavaco".',
      inputSchema: {
        channel: z.string().describe('Canal que vai mudar no retorno (ex.: "voz 1").'),
        aux: z.string().describe('Retorno de quem (ex.: "retorno do cavaco", "cavaco", "aux 2").'),
        ...levelFields,
      },
    },
    async ({ channel, aux, db, delta_db, confirm, confirmation_id }) =>
      reply(await controller.setLevel({ channel, aux, db, deltaDB: delta_db, confirm, confirmationId: confirmation_id })),
  );

  server.registerTool(
    'mute_channel',
    {
      title: 'Mutar ou desmutar canais',
      description: 'Muta (muted=true) ou desmuta (muted=false) um ou mais canais, no master ou num retorno.',
      inputSchema: {
        channels: z.array(z.string()).min(1).describe('Canais pelo nome ou número.'),
        muted: z.boolean().describe('true = mutar, false = desmutar.'),
        aux: z.string().optional().describe('Retorno onde mutar. Vazio = master.'),
        confirm: levelFields.confirm,
        confirmation_id: levelFields.confirmation_id,
      },
    },
    async ({ channels, muted, aux, confirm, confirmation_id }) =>
      reply(await controller.setMute({ channels, muted, aux, confirm, confirmationId: confirmation_id })),
  );

  server.registerTool(
    'set_master_level',
    {
      title: 'Volume geral (master)',
      description: 'Muda o volume geral da mesa. Sempre pede confirmação do usuário.',
      inputSchema: levelFields,
    },
    async ({ db, delta_db, confirm, confirmation_id }) =>
      reply(await controller.setMaster({ db, deltaDB: delta_db, confirm, confirmationId: confirmation_id })),
  );

  server.registerTool(
    'undo_last',
    {
      title: 'Desfazer',
      description: 'Desfaz as últimas ações feitas pelo MixAI (padrão: a última).',
      inputSchema: { steps: z.number().int().min(1).max(10).optional().describe('Quantas ações desfazer.') },
    },
    async ({ steps }) => reply(await controller.undo(steps ?? 1)),
  );

  server.registerTool(
    'get_action_log',
    {
      title: 'Histórico de ações',
      description: 'Lista as últimas ações feitas ou recusadas na mesa.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => reply(await controller.history(limit ?? 20)),
  );

  server.registerTool(
    'list_snapshots',
    {
      title: 'Snapshots salvos',
      description: 'Lista os shows e snapshots salvos na mesa e qual está carregado.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => reply(await controller.listSnapshots()),
  );

  server.registerTool(
    'load_snapshot',
    {
      title: 'Carregar snapshot',
      description: 'Carrega um snapshot salvo (troca a mix inteira). Sempre pede confirmação do usuário.',
      inputSchema: {
        show: z.string().describe('Nome do show.'),
        snapshot: z.string().describe('Nome do snapshot.'),
        confirm: levelFields.confirm,
        confirmation_id: levelFields.confirmation_id,
      },
    },
    async ({ show, snapshot, confirm, confirmation_id }) =>
      reply(await controller.loadSnapshot({ show, snapshot, confirm, confirmationId: confirmation_id })),
  );

  return server;
}
