import type { Command } from './commands.js';
import type { Principal, Role } from './auth.js';

/**
 * O que o perfil MÚSICO pode fazer (config: server.musicianAccess).
 * - fones_only (padrão): só o retorno compartilhado dos fones (AUX dos músicos).
 * - pa_without_master: fones + canais individuais do PA (volume em passos pequenos e mute de
 *   um canal por vez). Nunca o master, cenas/snapshots, aprovações, ganho/phantom/EQ.
 */
export type MusicianAccess = 'fones_only' | 'pa_without_master';

export interface AccessPolicy {
  musicianAux: number;
  musicianAccess: MusicianAccess;
  /**
   * Maior mudança de volume de um canal do PA que o músico faz SEM aprovação (dB, máx. 3).
   * Acima disso o pedido vira cartão de aprovação do operador (nada muda antes do "Aprovar").
   */
  musicianPaStepDB: number;
}

export const DEFAULT_POLICY: AccessPolicy = { musicianAux: 1, musicianAccess: 'fones_only', musicianPaStepDB: 3 };

/** Limite máximo aceito para musicianPaStepDB (a configuração não pode afrouxar além disso). */
export const MUSICIAN_PA_STEP_MAX_DB = 3;

export function musicianHasPA(policy: AccessPolicy): boolean {
  return policy.musicianAccess === 'pa_without_master';
}

/** Comando de volume ou mute num canal do PA (sem AUX). */
export function touchesPA(cmd: Command): boolean {
  return (cmd.type === 'set_level' || cmd.type === 'set_mute') && cmd.aux === undefined;
}

/**
 * Limite de passo que vale para este pedido, além do limite geral (safety.maxStepDB).
 * Músico no PA → musicianPaStepDB (nunca acima de 3 dB). undefined = só o limite geral.
 */
export function stepLimitFor(role: Role, cmd: Command, policy: AccessPolicy): { maxStepDB: number; stepRule: string } | undefined {
  if (role !== 'musician' || !musicianHasPA(policy) || cmd.type !== 'set_level' || cmd.aux !== undefined) return undefined;
  return {
    maxStepDB: Math.min(policy.musicianPaStepDB, MUSICIAN_PA_STEP_MAX_DB),
    stepRule: 'limite do músico no PA; precisa do operador',
  };
}

/**
 * Quem fez a alteração, para o histórico: perfil + sessão. O PIN do músico é COMPARTILHADO,
 * então "músico · sessão 3fa2c1" identifica um aparelho/login, não uma pessoa.
 */
export function actorOf(p: Principal): string {
  if (p.role === 'agent') return 'assistente (MCP)';
  const who = p.role === 'operator' ? 'operador' : 'músico';
  return `${who} · sessão ${p.id.slice(0, 6)}`;
}
