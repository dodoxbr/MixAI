import { z } from 'zod';
import type { ChannelMap } from '../core/channels.js';
import type { MixController, Result } from '../core/controller.js';
import { parseKey, type ParamKey } from '../core/revisions.js';
import type { Role } from './auth.js';

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
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];

/** Comandos que mudam a mesa (os outros são consultas). */
export const WRITE_COMMANDS: ReadonlySet<CommandType> = new Set(['set_level', 'set_mute', 'set_master', 'undo', 'load_snapshot', 'reset_lab']);

/** Executa no controlador. `confirmationId` só é passado pelo fluxo de aprovação do servidor. */
export async function dispatch(c: MixController, cmd: Command, confirmationId?: string): Promise<Result> {
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
      return c.setLevel({ channel: cmd.channel, aux: cmd.aux, db: cmd.db, deltaDB: cmd.deltaDB, confirmationId });
    case 'set_mute':
      return c.setMute({ channels: cmd.channels, muted: cmd.muted, aux: cmd.aux, confirmationId });
    case 'set_master':
      return c.setMaster({ db: cmd.db, deltaDB: cmd.deltaDB, confirmationId });
    case 'undo':
      return c.undo(cmd.steps ?? 1);
    case 'load_snapshot':
      return c.loadSnapshot({ show: cmd.show, snapshot: cmd.snapshot, confirmationId });
    case 'reset_lab':
      return c.resetLab();
  }
}

export type Denial = { code: 'FORBIDDEN'; message: string };

const MUSICIAN_ALLOWED: ReadonlySet<CommandType> = new Set(['status', 'list_names', 'mix_state', 'set_level', 'set_mute']);

/**
 * Autorização no servidor (o frontend nunca decide). Pode reescrever o comando
 * (ex.: consulta do músico vai para o AUX dele). Devolve o comando autorizado ou a recusa.
 */
export function authorizeCommand(
  role: Role,
  cmd: Command,
  names: ChannelMap,
  musicianAux: number,
): { ok: true; command: Command } | ({ ok: false } & Denial) {
  if (role === 'operator') return { ok: true, command: cmd };
  if (role === 'agent') {
    if (cmd.type === 'reset_lab') return deny('O reset do laboratório é só para o operador, pela tela.');
    return { ok: true, command: cmd };
  }
  // músico
  const fones = names.aux.list().find((a) => a.number === musicianAux)?.name ?? `AUX ${musicianAux}`;
  const onlyFones = `Músico só pode ajustar o retorno compartilhado dos fones (${fones}). PA e master são do operador.`;
  if (!MUSICIAN_ALLOWED.has(cmd.type)) return deny(onlyFones);
  if (cmd.type === 'mix_state') {
    if (cmd.aux === undefined) return { ok: true, command: { ...cmd, aux: musicianAux } };
    return resolvesTo(names, cmd.aux, musicianAux) ? { ok: true, command: cmd } : deny(onlyFones);
  }
  if (cmd.type === 'set_level' || cmd.type === 'set_mute') {
    if (cmd.aux === undefined || !resolvesTo(names, cmd.aux, musicianAux)) return deny(onlyFones);
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

/** Parâmetros que cada perfil pode ver no estado. */
export function visibleKey(role: Role, musicianAux: number): (key: ParamKey) => boolean {
  if (role !== 'musician') return () => true;
  return (key) => {
    const p = parseKey(key);
    return p.kind === 'channel' && p.aux === musicianAux;
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
    default:
      return cmd.type;
  }
}
