import { z } from 'zod';
import type { Intent, ParseOutcome } from '../assistant/intent.js';

/**
 * Única saída aceita da IA: a chamada da ferramenta "propor_ajuste", validada aqui.
 * Não existe campo para ganho, phantom, EQ, snapshot ou qualquer outro parâmetro físico:
 * o que não está no esquema não passa. Nada aqui executa: vira proposta com "Aplicar".
 */
const destino = z.enum(['PA', 'FONES']);
const motivo = z.string().max(200).optional();

const Proposta = z.discriminatedUnion('tipo', [
  z
    .object({
      tipo: z.literal('volume'),
      canal: z.number().int().min(1).max(64),
      destino,
      delta_db: z.number().min(-12).max(12).optional(),
      db: z.number().min(-100).max(10).optional(),
      motivo,
    })
    .strict()
    .refine((v) => (v.delta_db === undefined) !== (v.db === undefined), 'informe delta_db OU db'),
  z.object({ tipo: z.literal('mute'), canais: z.array(z.number().int().min(1).max(64)).min(1).max(6), destino, mutar: z.boolean(), motivo }).strict(),
  z
    .object({ tipo: z.literal('master'), delta_db: z.number().min(-12).max(12).optional(), db: z.number().min(-100).max(10).optional(), motivo })
    .strict()
    .refine((v) => (v.delta_db === undefined) !== (v.db === undefined), 'informe delta_db OU db'),
  z.object({ tipo: z.literal('desfazer'), motivo }).strict(),
]);

export const AiOutputSchema = z
  .object({
    acao: z.enum(['propor', 'perguntar', 'responder']),
    propostas: z.array(Proposta).max(3).optional(),
    pergunta: z.string().min(1).max(200).optional(),
    opcoes: z.array(z.string().min(1).max(120)).max(6).optional(),
    resposta: z.string().min(1).max(500).optional(),
  })
  .strict();

export type AiOutput = z.infer<typeof AiOutputSchema>;

/** JSON Schema enviado à API (espelha o esquema acima). */
export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    acao: { type: 'string', enum: ['propor', 'perguntar', 'responder'], description: 'propor = ajustes; perguntar = falta informação; responder = só texto.' },
    propostas: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tipo: { type: 'string', enum: ['volume', 'mute', 'master', 'desfazer'] },
          canal: { type: 'integer', description: 'Número do canal (só os da lista).' },
          canais: { type: 'array', items: { type: 'integer' } },
          destino: { type: 'string', enum: ['PA', 'FONES'] },
          delta_db: { type: 'number', description: 'Mudança relativa, entre -12 e 12.' },
          db: { type: 'number', description: 'Valor absoluto em dB.' },
          mutar: { type: 'boolean' },
          motivo: { type: 'string', description: 'Por que este ajuste, em uma frase curta.' },
        },
        required: ['tipo'],
      },
    },
    pergunta: { type: 'string' },
    opcoes: { type: 'array', items: { type: 'string' }, description: 'Pedidos completos que a pessoa pode tocar para responder.' },
    resposta: { type: 'string' },
  },
  required: ['acao'],
} as const;

/**
 * Converte a saída validada em intenções. Recusa canal fora da lista cadastrada (a IA não
 * inventa canais) e pedido sem o que a ação exige.
 */
export function toOutcome(out: AiOutput, knownChannels: number[]): { ok: true; outcome: ParseOutcome } | { ok: false; why: string } {
  if (out.acao === 'responder') {
    return out.resposta ? { ok: true, outcome: { kind: 'answer', text: out.resposta } } : { ok: false, why: 'resposta vazia' };
  }
  if (out.acao === 'perguntar') {
    if (!out.pergunta) return { ok: false, why: 'pergunta vazia' };
    return {
      ok: true,
      outcome: { kind: 'clarify', question: out.pergunta, options: (out.opcoes ?? []).map((t) => ({ label: t, text: t })) },
    };
  }
  if (!out.propostas?.length) return { ok: false, why: 'nenhuma proposta' };
  const intents: Intent[] = [];
  for (const p of out.propostas) {
    const dest = (d: 'PA' | 'FONES') => (d === 'FONES' ? 'fones' : 'pa') as 'pa' | 'fones';
    if (p.tipo === 'volume') {
      if (!knownChannels.includes(p.canal)) return { ok: false, why: `canal ${p.canal} não cadastrado` };
      intents.push({ type: 'level', channel: p.canal, dest: dest(p.destino), deltaDB: p.delta_db, db: p.db, reason: p.motivo });
    } else if (p.tipo === 'mute') {
      const bad = p.canais.find((c) => !knownChannels.includes(c));
      if (bad !== undefined) return { ok: false, why: `canal ${bad} não cadastrado` };
      intents.push({ type: 'mute', channels: [...new Set(p.canais)], dest: dest(p.destino), muted: p.mutar, reason: p.motivo });
    } else if (p.tipo === 'master') {
      intents.push({ type: 'master', deltaDB: p.delta_db, db: p.db, reason: p.motivo });
    } else {
      intents.push({ type: 'undo', reason: p.motivo });
    }
  }
  return { ok: true, outcome: { kind: 'intents', intents } };
}
