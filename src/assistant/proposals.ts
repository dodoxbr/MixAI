import { randomBytes } from 'node:crypto';
import type { MixController } from '../core/controller.js';
import { paramKey, type ParamKey } from '../core/revisions.js';
import { auxBus, MASTER } from '../mixer/types.js';
import type { Principal } from '../server/auth.js';
import { authorizeCommand, type Command } from '../server/commands.js';
import { stepLimitFor, type AccessPolicy } from '../server/policy.js';
import type { Intent } from './intent.js';

/** Cartão de proposta mostrado na tela (nada foi alterado ainda). */
export interface ProposalCard {
  id: string;
  source: 'local' | 'ai' | 'feedback';
  title: string;
  /** Canal(is) afetado(s), pelos nomes da banda. */
  channel: string;
  destination: 'PA' | 'FONES' | 'MASTER' | 'DESFAZER';
  current: string;
  change: string;
  result: string;
  reason?: string;
  /** true = depois de Aplicar ainda vai para o cartão de aprovação do operador (E2). */
  needsApproval: boolean;
  expiresAt: string;
}

export interface Proposal {
  card: ProposalCard;
  ownerId: string;
  intent: Intent;
  /** Comando exato que será executado (valores absolutos: o resultado é o que o cartão mostra). */
  command: Command;
  /** Revisões dos parâmetros usados no cálculo: se mudarem, a proposta é recalculada. */
  bound: Array<[ParamKey, number]>;
  undoId?: number;
  expiresAtMs: number;
  /** Para "Não melhorou": como voltar ao valor anterior. */
  revert?: Intent;
}

export type BuildResult = { ok: true; proposal: Proposal } | { ok: false; code: 'FORBIDDEN' | 'NOTHING' | 'UNKNOWN_VALUE' | 'INVALID'; message: string };

const SILENCE_DB = -80;
const roundHalf = (db: number) => (Number.isFinite(db) ? Math.round(db * 2) / 2 : db);
export function fmtDb(db: number): string {
  if (!Number.isFinite(db)) return db < 0 ? '−∞ dB' : '+∞ dB';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} dB`;
}
const fmtDelta = (d: number) => `${d > 0 ? '+' : '−'}${Math.abs(d)} dB`;

/**
 * Transforma intenções em propostas. Calcula o valor resultante com as MESMAS regras do
 * controlador (teto, fundo −∞, arredondamento), mas não altera nada.
 */
export class ProposalBuilder {
  constructor(
    private controller: MixController,
    private policy: AccessPolicy,
    private ttlMs: number,
    private clock: () => number = Date.now,
    private channelAccess: (p: Principal, cmd: Command) => boolean = () => true,
  ) {}

  build(p: Principal, intent: Intent, source: ProposalCard['source']): BuildResult {
    const names = this.controller.names;
    const lim = this.controller.limits();
    const read = (key: ParamKey) => this.controller.state.snapshot([key]).params[key]!;
    const id = randomBytes(6).toString('hex');
    const expiresAtMs = this.clock() + this.ttlMs;
    const base = { id, source, reason: intent.reason, expiresAt: new Date(expiresAtMs).toISOString() };
    const aux = (dest: 'pa' | 'fones') => (dest === 'fones' ? this.policy.musicianAux : undefined);
    const destName = (dest: 'pa' | 'fones') => (dest === 'fones' ? 'FONES' : 'PA');
    const check = (command: Command): BuildResult | undefined => {
      if (!this.channelAccess(p, command)) return { ok: false, code: 'FORBIDDEN', message: 'Canal não vinculado a esta sessão no LAB. Peça ao operador.' };
      const auth = authorizeCommand(p.role, command, names, this.policy);
      return auth.ok ? undefined : { ok: false, code: 'FORBIDDEN', message: auth.message };
    };
    const nameOf = (n: number) => names.inputs.list().find((c) => c.number === n)?.name;

    switch (intent.type) {
      case 'level': {
        const name = nameOf(intent.channel);
        if (!name) return { ok: false, code: 'INVALID', message: `O canal ${intent.channel} não está cadastrado.` };
        const a = aux(intent.dest);
        const key = paramKey.level(intent.channel, a ? auxBus(a) : MASTER);
        const st = read(key);
        if (st.value.status !== 'known') return unknown(name, st.value.status);
        const current = st.value.value as number;
        const ceiling = a ? lim.maxAuxSendDB : lim.maxChannelLevelDB;
        const { target, clamped } = plan(current, intent, ceiling, lim.relativeFloorDB);
        const command: Command = { type: 'set_level', channel: intent.channel, aux: a, db: Number.isFinite(target) ? target : -100 };
        const denied = check(command);
        if (denied) return denied;
        if (target === roundHalf(current)) return { ok: false, code: 'NOTHING', message: `${name} (${destName(intent.dest)}) já está em ${fmtDb(current)}.` };
        const step = Math.abs((Number.isFinite(target) ? target : lim.relativeFloorDB) - (Number.isFinite(current) ? current : lim.relativeFloorDB));
        return {
          ok: true,
          proposal: {
            card: {
              ...base,
              title: `${intent.dest === 'fones' ? 'Fones' : 'PA'}: ${name}`,
              channel: name,
              destination: destName(intent.dest),
              current: fmtDb(current),
              change: intent.db !== undefined ? `para ${fmtDb(intent.db)}` : fmtDelta(intent.deltaDB ?? 0),
              result: fmtDb(target) + (clamped ? ' (teto)' : ''),
              // músico no PA: o limite é o dele (3 dB); acima, o operador aprova
              needsApproval: step > Math.min(lim.maxStepDB, stepLimitFor(p.role, command, this.policy)?.maxStepDB ?? Infinity) + 1e-9,
            },
            ownerId: p.id,
            intent,
            command,
            bound: [[key, st.revision]],
            expiresAtMs,
            revert: { type: 'level', channel: intent.channel, dest: intent.dest, db: Number.isFinite(current) ? current : -100, reason: 'voltar ao valor anterior' },
          },
        };
      }
      case 'mute': {
        const a = aux(intent.dest);
        const list = intent.channels.map((n) => ({ n, name: nameOf(n) }));
        const missing = list.find((c) => !c.name);
        if (missing) return { ok: false, code: 'INVALID', message: `O canal ${missing.n} não está cadastrado.` };
        const keys = intent.channels.map((n) => paramKey.mute(n, a ? auxBus(a) : MASTER));
        const states = keys.map(read);
        const bad = states.findIndex((s) => s.value.status !== 'known');
        if (bad >= 0) return unknown(list[bad]!.name!, states[bad]!.value.status);
        const command: Command = { type: 'set_mute', channels: intent.channels, muted: intent.muted, aux: a };
        const denied = check(command);
        if (denied) return denied;
        const changing = list.filter((_, i) => (states[i]!.value as { value: boolean }).value !== intent.muted);
        const names = list.map((c) => c.name).join(', ');
        if (!changing.length) return { ok: false, code: 'NOTHING', message: `${names} já ${intent.muted ? 'está(ão) mutado(s)' : 'está(ão) aberto(s)'} no ${destName(intent.dest)}.` };
        return {
          ok: true,
          proposal: {
            card: {
              ...base,
              title: `${intent.dest === 'fones' ? 'Fones' : 'PA'}: ${intent.muted ? 'mutar' : 'abrir'} ${names}`,
              channel: names,
              destination: destName(intent.dest),
              current: list.map((c, i) => `${c.name}: ${(states[i]!.value as { value: boolean }).value ? 'mutado' : 'aberto'}`).join(' · '),
              change: intent.muted ? 'mutar' : 'abrir (tirar o mute)',
              result: intent.muted ? 'mutado' : 'aberto',
              needsApproval: intent.muted && intent.channels.length > lim.bulkMuteConfirmAbove,
            },
            ownerId: p.id,
            intent,
            command,
            bound: keys.map((k, i) => [k, states[i]!.revision]),
            expiresAtMs,
            revert: { type: 'mute', channels: changing.map((c) => c.n), dest: intent.dest, muted: !intent.muted, reason: 'voltar como estava' },
          },
        };
      }
      case 'master': {
        const key = paramKey.master();
        const st = read(key);
        if (st.value.status !== 'known') return unknown('o master', st.value.status);
        const current = st.value.value as number;
        const { target, clamped } = plan(current, intent, lim.maxMasterLevelDB, lim.relativeFloorDB);
        const command: Command = { type: 'set_master', db: Number.isFinite(target) ? target : -100 };
        const denied = check(command);
        if (denied) return denied;
        if (target === roundHalf(current)) return { ok: false, code: 'NOTHING', message: `O master já está em ${fmtDb(current)}.` };
        return {
          ok: true,
          proposal: {
            card: {
              ...base,
              title: 'MASTER (som geral)',
              channel: 'Master',
              destination: 'MASTER',
              current: fmtDb(current),
              change: intent.db !== undefined ? `para ${fmtDb(intent.db)}` : fmtDelta(intent.deltaDB ?? 0),
              result: fmtDb(target) + (clamped ? ' (teto)' : ''),
              needsApproval: true, // o master sempre passa pela aprovação do operador (E2)
            },
            ownerId: p.id,
            intent,
            command,
            bound: [[key, st.revision]],
            expiresAtMs,
            revert: { type: 'master', db: Number.isFinite(current) ? current : -100, reason: 'voltar ao valor anterior' },
          },
        };
      }
      case 'undo': {
        const command: Command = { type: 'undo', steps: 1 };
        const denied = check(command);
        if (denied) return denied;
        const top = this.controller.peekUndo();
        if (!top) return { ok: false, code: 'NOTHING', message: 'Não há nada para desfazer.' };
        const states = top.keys.map(read);
        return {
          ok: true,
          proposal: {
            card: {
              ...base,
              title: 'Desfazer o último ajuste',
              channel: top.description.split(':')[0] ?? '',
              destination: 'DESFAZER',
              current: top.description,
              change: 'desfazer',
              result: 'volta ao valor anterior',
              needsApproval: false,
            },
            ownerId: p.id,
            intent,
            command,
            bound: top.keys.map((k, i) => [k, states[i]!.revision]),
            undoId: top.id,
            expiresAtMs,
          },
        };
      }
    }
  }

  /** As revisões (e a entrada do desfazer) ainda são as mesmas do cálculo? */
  isCurrent(pr: Proposal): boolean {
    const keys = pr.bound.map(([k]) => k);
    const snap = this.controller.state.snapshot(keys);
    if (pr.bound.some(([k, rev]) => snap.params[k]?.revision !== rev)) return false;
    if (pr.undoId !== undefined && this.controller.peekUndo()?.id !== pr.undoId) return false;
    return true;
  }
}

function unknown(name: string, status: string): BuildResult {
  return {
    ok: false,
    code: 'UNKNOWN_VALUE',
    message:
      status === 'unavailable'
        ? `Sem leitura da mesa agora: não dá para calcular a proposta para ${name}.`
        : `Ainda não sei o valor atual de ${name}; não dá para calcular a proposta.`,
  };
}

/** Mesmas regras do controlador: −∞ abaixo de −80, teto, piso relativo, 0,5 dB. */
function plan(current: number, intent: { db?: number; deltaDB?: number }, ceiling: number, floor: number) {
  const base = Number.isFinite(current) ? current : floor;
  let target = intent.db !== undefined ? intent.db : base + (intent.deltaDB ?? 0);
  if (target <= SILENCE_DB || (intent.db === undefined && target < floor)) target = -Infinity;
  let clamped = false;
  if (target > ceiling) {
    target = ceiling;
    clamped = true;
  }
  return { target: roundHalf(target), clamped };
}
