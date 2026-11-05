import { NameResolutionError, type ChannelMap } from './channels.js';
import type { MixController, Result } from './controller.js';

/**
 * Parser determinístico dos comandos diretos (o mesmo do console). Não usa IA e funciona offline.
 * Devolve um comando estruturado; a execução fica em `runCommand`.
 */
export type Command =
  | { kind: 'empty' }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'error'; message: string }
  | { kind: 'status' }
  | { kind: 'state'; aux?: string }
  | { kind: 'names' }
  | { kind: 'log' }
  | { kind: 'snapshots' }
  | { kind: 'undo'; steps: number }
  | { kind: 'level'; channel: string; aux?: string; deltaDB?: number; db?: number }
  | { kind: 'mute'; channels: string[]; muted: boolean; aux?: string }
  | { kind: 'master'; db: number }
  | { kind: 'load'; show: string; snapshot: string };

export const HELP = `Comandos (retorno opcional com "@", ex.: "sobe voz 1 3 @ fones"):
  status                      conexão e snapshot atual
  estado [@ retorno]          volumes e mutes
  sobe <canal> [dB]           sobe (padrão 2 dB)
  desce <canal> [dB]          desce (padrão 2 dB)
  nivel <canal> <dB>          valor absoluto (ex.: nivel cavaco -12)
  muta <canal, canal...>      muta
  abre <canal, canal...>      desmuta
  master <dB>                 volume geral (pede confirmação)
  desfazer [n]                desfaz as últimas n ações
  snapshots                   lista shows/snapshots
  carrega <show> / <snap>     carrega snapshot (pede confirmação)
  nomes                       nomes da banda
  log                         últimas ações
  ajuda | sair`;

function splitAux(rest: string): { body: string; aux?: string } {
  const i = rest.indexOf('@');
  if (i < 0) return { body: rest.trim() };
  return { body: rest.slice(0, i).trim(), aux: rest.slice(i + 1).trim() || undefined };
}

/** "voz 1 3" -> canal "voz 1", valor 3. "voz 1" -> canal "voz 1", sem valor. */
function channelAndValue(names: ChannelMap, body: string): { channel: string; value?: number } {
  const isChannel = (s: string) => {
    try {
      names.channel(s);
      return true;
    } catch (e) {
      if (e instanceof NameResolutionError) return false;
      throw e;
    }
  };
  if (isChannel(body)) return { channel: body };
  const m = body.match(/^(.*\S)\s+([+-]?\d+(?:[.,]\d+)?)$/);
  if (m) return { channel: m[1]!, value: Number(m[2]!.replace(',', '.')) };
  return { channel: body };
}

export function parseCommand(line: string, names: ChannelMap): Command {
  const [cmd = '', ...words] = line.trim().split(/\s+/);
  const rest = words.join(' ');
  switch (cmd.toLowerCase()) {
    case '':
      return { kind: 'empty' };
    case 'ajuda':
    case 'help':
      return { kind: 'help' };
    case 'sair':
    case 'exit':
      return { kind: 'quit' };
    case 'status':
      return { kind: 'status' };
    case 'estado':
      return { kind: 'state', aux: splitAux(rest).aux };
    case 'nomes':
      return { kind: 'names' };
    case 'log':
      return { kind: 'log' };
    case 'snapshots':
      return { kind: 'snapshots' };
    case 'desfazer':
      return { kind: 'undo', steps: Number(rest) || 1 };
    case 'sobe':
    case 'desce': {
      const { body, aux } = splitAux(rest);
      const { channel, value } = channelAndValue(names, body);
      const amount = Math.abs(value ?? 2) * (cmd.toLowerCase() === 'desce' ? -1 : 1);
      return { kind: 'level', channel, aux, deltaDB: amount };
    }
    case 'nivel': {
      const { body, aux } = splitAux(rest);
      const { channel, value } = channelAndValue(names, body);
      if (value === undefined) return { kind: 'error', message: 'Informe o valor em dB. Ex.: nivel cavaco -12' };
      return { kind: 'level', channel, aux, db: value };
    }
    case 'muta':
    case 'abre': {
      const { body, aux } = splitAux(rest);
      const channels = body.split(',').map((s) => s.trim()).filter(Boolean);
      return { kind: 'mute', channels, muted: cmd.toLowerCase() === 'muta', aux };
    }
    case 'master': {
      const value = Number(rest.replace(',', '.'));
      if (!rest || Number.isNaN(value)) return { kind: 'error', message: 'Informe o valor em dB. Ex.: master -3' };
      return { kind: 'master', db: value };
    }
    case 'carrega': {
      const [show, snapshot] = rest.split('/').map((s) => s.trim());
      if (!show || !snapshot) return { kind: 'error', message: 'Use: carrega <show> / <snapshot>' };
      return { kind: 'load', show, snapshot };
    }
    default:
      return { kind: 'error', message: `Comando desconhecido: ${cmd}. Digite "ajuda".` };
  }
}

/** Executa um comando estruturado. `confirmationId` só vale para comandos que pedem confirmação. */
export async function runCommand(c: MixController, cmd: Command, confirmationId?: string): Promise<Result | undefined> {
  switch (cmd.kind) {
    case 'status':
      return c.ensureConnected();
    case 'state':
      return c.mixState(cmd.aux);
    case 'names':
      return c.listNames();
    case 'log':
      return c.history(15);
    case 'snapshots':
      return c.listSnapshots();
    case 'undo':
      return c.undo(cmd.steps);
    case 'level':
      return c.setLevel({ channel: cmd.channel, aux: cmd.aux, deltaDB: cmd.deltaDB, db: cmd.db, confirmationId });
    case 'mute':
      return c.setMute({ channels: cmd.channels, muted: cmd.muted, aux: cmd.aux, confirmationId });
    case 'master':
      return c.setMaster({ db: cmd.db, confirmationId });
    case 'load':
      return c.loadSnapshot({ show: cmd.show, snapshot: cmd.snapshot, confirmationId });
    default:
      return undefined;
  }
}
