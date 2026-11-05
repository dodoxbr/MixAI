import type { Bus } from '../mixer/types.js';

/** Identificador estável de um parâmetro da mesa (formato que a E1 vai ampliar com EQ/HPF). */
export type ParamKey =
  | `ch.${number}.main.level`
  | `ch.${number}.main.mute`
  | `ch.${number}.aux.${number}.level`
  | `ch.${number}.aux.${number}.mute`
  | 'master.level';

/** Nível em dB (-Infinity = fader todo para baixo) ou estado de mute. */
export type ParamValue = number | boolean;

/**
 * Quem gerou a revisão. `uncertain` = escrita do MixAI cujo resultado não pode ser confirmado
 * (queda de conexão perto do envio, ou erro inesperado durante o envio).
 */
export type Actor = 'mixai' | 'external' | 'resync' | 'snapshot' | 'uncertain';

export const paramKey = {
  level(channel: number, bus: Bus): ParamKey {
    return bus.kind === 'master' ? `ch.${channel}.main.level` : `ch.${channel}.aux.${bus.aux}.level`;
  },
  mute(channel: number, bus: Bus): ParamKey {
    return bus.kind === 'master' ? `ch.${channel}.main.mute` : `ch.${channel}.aux.${bus.aux}.mute`;
  },
  master(): ParamKey {
    return 'master.level';
  },
};

const KEY_RE = /^ch\.(\d+)\.(main|aux\.(\d+))\.(level|mute)$/;

export type ParsedKey =
  | { kind: 'master' }
  | { kind: 'channel'; channel: number; aux?: number; param: 'level' | 'mute' };

export function parseKey(key: ParamKey): ParsedKey {
  if (key === 'master.level') return { kind: 'master' };
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Chave de parâmetro inválida: ${key}`);
  return {
    kind: 'channel',
    channel: Number(m[1]),
    aux: m[3] ? Number(m[3]) : undefined,
    param: m[4] as 'level' | 'mute',
  };
}

/** Compara valores de parâmetro: níveis com tolerância de 0,05 dB (a mesa usa valores lineares). */
export function sameValue(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) < 0.05;
}

/**
 * Revisão global crescente + última revisão de cada parâmetro.
 * O desfazer compara revisões (nunca valores) para não apagar mudanças de outras pessoas.
 */
export class RevisionTracker {
  private global = 0;
  private perKey = new Map<ParamKey, { revision: number; actor: Actor }>();

  bump(key: ParamKey, actor: Actor): number {
    this.global += 1;
    this.perKey.set(key, { revision: this.global, actor });
    return this.global;
  }

  bumpAll(keys: Iterable<ParamKey>, actor: Actor): void {
    for (const k of keys) this.bump(k, actor);
  }

  /** 0 = parâmetro nunca alterado desde que o MixAI começou. */
  revisionOf(key: ParamKey): number {
    return this.perKey.get(key)?.revision ?? 0;
  }

  actorOf(key: ParamKey): Actor | undefined {
    return this.perKey.get(key)?.actor;
  }

  current(): number {
    return this.global;
  }
}
