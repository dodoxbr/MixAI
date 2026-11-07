import { z } from 'zod';
import type { ChannelMap } from '../core/channels.js';
import type { Expectation, MixController, Result, UndoPreview } from '../core/controller.js';
import { parseKey, type ParamKey } from '../core/revisions.js';
import type { Role } from './auth.js';
import { musicianHasPA, type AccessPolicy } from './policy.js';

const target = z.union([z.string().min(1).max(60), z.number().int().min(1).max(64)]);
const db = z.number().min(-100).max(10);
const delta = z.number().min(-40).max(20);

/**
 * Comandos aceitos pelo servidor (HTTP e WebSocket). Os mesmos verbos das 11 tools MCP, mais o
 * reset do laboratório (só operador). NÃO existe campo de confirmação: confirmar é uma ação
 * separada (`approve`), exclusiva de operador autenticado.
 */
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('musician_identity') }).strict(),
  z.object({ type: z.literal('musician_sessions') }).strict(),
  z.object({ type: z.literal('musician_bind'), sessionId: z.string().regex(/^[a-f0-9]{16}$/), musicianId: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1).max(60), channels: z.array(z.number().int().min(1).max(12)).min(1).max(12), mute: z.boolean() }).strict(),
  z.object({ type: z.literal('musician_revoke'), sessionId: z.string().regex(/^[a-f0-9]{16}$/) }).strict(),
  z.object({ type: z.literal('list_names') }).strict(),
  z.object({ type: z.literal('mix_state'), aux: target.optional() }).strict(),
  z.object({ type: z.literal('history'), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal('list_snapshots') }).strict(),
  z
    .object({ type: z.literal('set_level'), channel: target, aux: target.optional(), db: db.optional(), deltaDB: delta.optional() })
    .strict(),
  z.object({ type: z.literal('set_mute'), channels: z.array(target).min(1).max(32), muted: z.boolean(), aux: target.optional() }).strict(),
  z.object({ type: z.literal('set_master'), db: db.optional(), deltaDB: delta.optional() }).strict(),
  z.object({ type: z.literal('undo'), steps: z.number().int().min(1).max(10).optional() }).strict(),
  z.object({ type: z.literal('load_snapshot'), show: z.string().min(1).max(100), snapshot: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('reset_lab') }).strict(),
  z.object({ type: z.literal('set_lab_eq'), channel: z.number().int().min(1).max(12), values: z.record(z.string(), z.union([z.number(), z.boolean()])).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 15) }).strict(),
  z.object({ type: z.literal('reset_lab_eq'), channel: z.number().int().min(1).max(12) }).strict(),
  // ---------- cenas do MixAI (E5): só operador; carregar só no LAB e com aprovação ----------
  z.object({ type: z.literal('scene_list') }).strict(),
  z.object({ type: z.literal('scene_get'), id: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('scene_save'), name: z.string().max(200), description: z.string().max(2000).optional() }).strict(),
  z.object({ type: z.literal('scene_duplicate'), id: z.string().min(1).max(64), name: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal('scene_update'), id: z.string().min(1).max(64), name: z.string().max(200).optional(), description: z.string().max(2000).optional() }).strict(),
  z.object({ type: z.literal('scene_delete'), id: z.string().min(1).max(64), expectedName: z.string().max(200) }).strict(),
  z.object({ type: z.literal('scene_export'), id: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('scene_import'), json: z.string().min(1).max(256 * 1024) }).strict(),
  z.object({ type: z.literal('scene_compare'), id: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('scene_load'), id: z.string().min(1).max(64), previewId: z.string().min(1).max(64) }).strict(),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];

/** Comandos que mudam a mesa (os outros são consultas). */
export const WRITE_COMMANDS: ReadonlySet<CommandType> = new Set(['set_level', 'set_mute', 'set_master', 'undo', 'load_snapshot', 'reset_lab', 'scene_load', 'set_lab_eq', 'reset_lab_eq']);

export function isSceneCommand(cmd: Command): cmd is Extract<Command, { type: `scene_${string}` }> {
  return cmd.type.startsWith('scene_');
}

/**
 * Quando um desfazer pedido por este perfil precisa de aprovação humana.
 * - Operador: nunca (ele é o humano).
 * - Assistente: se a reversão mexe no master ou numa alteração crítica (master, passo grande,
 *   mute em grupo — o que já tinha precisado de aprovação), ou se desfaria algo feito por uma
 *   pessoa (operador/músico). Desfazer os próprios ajustes simples continua direto.
 */
export function undoApproval(role: Role): ((entries: UndoPreview[]) => string | undefined) | undefined {
  if (role !== 'agent') return undefined;
  return (entries) => {
    if (entries.some((e) => e.critical || e.keys.includes('master.level'))) {
      return 'reverte uma alteração crítica (master, passo grande ou mute em grupo)';
    }
    if (entries.some((e) => e.origin === 'operator' || e.origin === 'musician')) {
      return 'desfaria uma alteração feita por uma pessoa na tela';
    }
    return undefined;
  };
}

/**
 * Executa no controlador. `confirmationId` só é passado pelo fluxo de aprovação do servidor.
 * `role` = quem PEDIU o comando (fica no desfazer e define a política de desfazer).
 */
export async function dispatch(
  c: MixController,
  cmd: Command,
  confirmationId?: string,
  role?: Role,
  expect?: Expectation,
  extra: { actor?: string; maxStepDB?: number; stepRule?: string } = {},
): Promise<Result> {
  const { actor, maxStepDB, stepRule } = extra;
  switch (cmd.type) {
    case 'status':
      return c.ensureConnected();
    case 'list_names':
      return c.listNames();
    case 'mix_state':
      return c.mixState(cmd.aux);
    case 'history':
      return c.history(cmd.limit ?? 20);
    case 'list_snapshots':
      return c.listSnapshots();
    case 'set_level':
      return c.setLevel({ channel: cmd.channel, aux: cmd.aux, db: cmd.db, deltaDB: cmd.deltaDB, confirmationId, origin: role, actor, maxStepDB, stepRule, expect });
    case 'set_mute':
      return c.setMute({ channels: cmd.channels, muted: cmd.muted, aux: cmd.aux, confirmationId, origin: role, actor, expect });
    case 'set_master':
      return c.setMaster({ db: cmd.db, deltaDB: cmd.deltaDB, confirmationId, origin: role, actor, expect });
    case 'undo':
      return c.undo(cmd.steps ?? 1, { confirmationId, approvalReason: role ? undoApproval(role) : undefined, expect, actor });
    case 'load_snapshot':
      return c.loadSnapshot({ show: cmd.show, snapshot: cmd.snapshot, confirmationId, actor });
    case 'set_lab_eq':
      return c.editLabEq(cmd.channel, cmd.values, { origin: role, actor, expect });
    case 'reset_lab_eq':
      return c.editLabEq(cmd.channel, undefined, { origin: role, actor, expect });
    case 'reset_lab':
      return c.resetLab();
    default:
      // Cenas são executadas pelo ScenesService (ServerCore), nunca por aqui.
      return { ok: false, code: 'INVALID', message: `Comando ${cmd.type} não é executado diretamente no controlador.` };
  }
}

export type Denial = { code: 'FORBIDDEN'; message: string };

const MUSICIAN_ALLOWED: ReadonlySet<CommandType> = new Set(['status', 'list_names', 'mix_state', 'set_level', 'set_mute']);

/**
 * Autorização no servidor (o frontend nunca decide). Pode reescrever o comando
 * (ex.: consulta do músico vai para o AUX dele). Devolve o comando autorizado ou a recusa.
 *
 * Músico (server.musicianAccess):
 * - fones_only: só o AUX dos músicos (fones);
 * - pa_without_master: fones + canais individuais do PA (volume e mute de UM canal por vez).
 *   O limite de passo do PA (3 dB) é aplicado no controlador (stepLimitFor), inclusive para
 *   valores absolutos; acima dele vira aprovação do operador.
 * Sempre negado ao músico: master, cenas/snapshots, desfazer, histórico, reset, aprovações
 * (estas nem são comando) e qualquer parâmetro físico (não existem no esquema).
 */
export function authorizeCommand(
  role: Role,
  cmd: Command,
  names: ChannelMap,
  policy: AccessPolicy,
): { ok: true; command: Command } | ({ ok: false } & Denial) {
  if (role === 'operator') return { ok: true, command: cmd };
  if (cmd.type.startsWith('musician_') && cmd.type !== 'musician_identity') return deny('Vínculos são exclusivos do operador.');
  if (cmd.type === 'musician_identity') return { ok: true, command: cmd };
  if (cmd.type === 'set_lab_eq' || cmd.type === 'reset_lab_eq') return deny('EQ do laboratório é exclusivo do operador.');
  if (isSceneCommand(cmd)) {
    // Cenas do MixAI: criar, administrar, importar/exportar, carregar e aprovar são só do
    // operador, pela tela. Nem o músico (em nenhum modo) nem o assistente (MCP) nesta etapa.
    return deny(
      role === 'agent'
        ? 'O assistente não gerencia, carrega nem aprova cenas do MixAI nesta etapa. Só o operador, pela tela.'
        : 'Cenas do MixAI são só do operador. O músico não cria nem carrega cenas.',
    );
  }
  if (role === 'agent') {
    if (cmd.type === 'reset_lab') return deny('O reset do laboratório é só para o operador, pela tela.');
    return { ok: true, command: cmd };
  }
  // músico
  const aux = policy.musicianAux;
  const pa = musicianHasPA(policy);
  const fones = names.aux.list().find((a) => a.number === aux)?.name ?? `AUX ${aux}`;
  const denial = pa
    ? `Músico ajusta os fones (${fones}) e canais do PA, um de cada vez. Master, cenas e aprovações são do operador.`
    : `Músico só pode ajustar o retorno compartilhado dos fones (${fones}). PA e master são do operador.`;
  if (cmd.type === 'set_master') return deny(`O MASTER é só do operador. ${denial}`);
  if (cmd.type === 'load_snapshot') return deny(`Carregar cenas/snapshots é só do operador. ${denial}`);
  if (!MUSICIAN_ALLOWED.has(cmd.type)) return deny(denial);
  if (cmd.type === 'mix_state') {
    if (cmd.aux === undefined) return pa ? { ok: true, command: cmd } : { ok: true, command: { ...cmd, aux } };
    return resolvesTo(names, cmd.aux, aux) ? { ok: true, command: cmd } : deny(denial);
  }
  if (cmd.type === 'set_level' || cmd.type === 'set_mute') {
    if (cmd.aux === undefined) {
      if (!pa) return deny(denial);
      if (cmd.type === 'set_mute' && cmd.channels.length !== 1) return deny('No PA, o músico muta ou abre UM canal por vez.');
      return { ok: true, command: cmd };
    }
    if (!resolvesTo(names, cmd.aux, aux)) return deny(denial);
  }
  return { ok: true, command: cmd };
}

function resolvesTo(names: ChannelMap, query: string | number, aux: number): boolean {
  try {
    return names.auxBus(query).number === aux;
  } catch {
    return false;
  }
}

const deny = (message: string): { ok: false } & Denial => ({ ok: false, code: 'FORBIDDEN', message });

/**
 * Parâmetros que cada perfil pode ver no estado. Músico: só volume/mute dos canais nos fones e,
 * em pa_without_master, também no PA. Nunca o master nem EQ/HPF (parâmetros físicos).
 */
export function visibleKey(role: Role, policy: AccessPolicy): (key: ParamKey) => boolean {
  if (role !== 'musician') return () => true;
  const pa = musicianHasPA(policy);
  return (key) => {
    const p = parseKey(key);
    if (p.kind !== 'channel') return false;
    return p.aux === policy.musicianAux || (pa && p.aux === undefined);
  };
}

/** Texto curto do comando, para os cartões de aprovação e o histórico. */
export function describeCommand(cmd: Command): string {
  switch (cmd.type) {
    case 'set_level':
      return `volume de ${cmd.channel}${cmd.aux !== undefined ? ` no ${cmd.aux}` : ' no PA'}`;
    case 'set_mute':
      return `${cmd.muted ? 'mutar' : 'desmutar'} ${cmd.channels.join(', ')}${cmd.aux !== undefined ? ` no ${cmd.aux}` : ' no PA'}`;
    case 'set_master':
      return 'volume do master';
    case 'load_snapshot':
      return `carregar snapshot ${cmd.show} / ${cmd.snapshot}`;
    case 'undo':
      return `desfazer ${cmd.steps ?? 1} ação(ões)`;
    case 'scene_load':
      return 'carregar cena do MixAI (laboratório)';
    default:
      return cmd.type;
  }
}
