import type { Bus } from '../mixer/types.js';

export type EqBand = 1 | 2 | 3 | 4;

/**
 * Identificador estável de um parâmetro da mesa.
 * Os de EQ/HPF existem no modelo desde a E1 (registro, Lab, cenas), mas ainda não são
 * expostos às tools nem aplicados na mesa real (capability `simulated_only`, ver params.ts).
 */
export type ParamKey =
  | `ch.${number}.main.level`
  | `ch.${number}.main.mute`
  | `ch.${number}.aux.${number}.level`
  | `ch.${number}.aux.${number}.mute`
  | `ch.${number}.eq.b${EqBand}.${'freq' | 'q' | 'gain'}`
  | `ch.${number}.eq.hpf.${'freq' | 'slope'}`
  | `ch.${number}.eq.bypass`
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
  eqBand(channel: number, band: EqBand, param: 'freq' | 'q' | 'gain'): ParamKey {
    return `ch.${channel}.eq.b${band}.${param}`;
  },
  hpf(channel: number, param: 'freq' | 'slope'): ParamKey {
    return `ch.${channel}.eq.hpf.${param}`;
  },
  eqBypass(channel: number): ParamKey {
    return `ch.${channel}.eq.bypass`;
  },
};

const KEY_RE = /^ch\.(\d+)\.(main|aux\.(\d+))\.(level|mute)$/;
const EQ_RE = /^ch\.(\d+)\.eq\.(?:b([1-4])\.(freq|q|gain)|hpf\.(freq|slope)|(bypass))$/;

export type ParsedKey =
  | { kind: 'master' }
  | { kind: 'channel'; channel: number; aux?: number; param: 'level' | 'mute' }
  | { kind: 'eq'; channel: number; band: EqBand; param: 'freq' | 'q' | 'gain' }
  | { kind: 'hpf'; channel: number; param: 'freq' | 'slope' }
  | { kind: 'eqBypass'; channel: number };

export function parseKey(key: ParamKey): ParsedKey {
  if (key === 'master.level') return { kind: 'master' };
  const m = KEY_RE.exec(key);
  if (m) {
    return {
      kind: 'channel',
      channel: Number(m[1]),
      aux: m[3] ? Number(m[3]) : undefined,
      param: m[4] as 'level' | 'mute',
    };
  }
  const e = EQ_RE.exec(key);
  if (e) {
    const channel = Number(e[1]);
    if (e[2]) return { kind: 'eq', channel, band: Number(e[2]) as EqBand, param: e[3] as 'freq' | 'q' | 'gain' };
    if (e[4]) return { kind: 'hpf', channel, param: e[4] as 'freq' | 'slope' };
    return { kind: 'eqBypass', channel };
  }
  throw new Error(`Chave de parâmetro inválida: ${key}`);
}

/** Converte texto (arquivo, rede) em ParamKey, ou undefined se não for uma chave válida. */
export function asParamKey(text: string): ParamKey | undefined {
  try {
    parseKey(text as ParamKey);
    return text as ParamKey;
  } catch {
    return undefined;
  }
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
  private bumpListeners = new Set<(key: ParamKey, revision: number, actor: Actor) => void>();

  bump(key: ParamKey, actor: Actor): number {
    this.global += 1;
    this.perKey.set(key, { revision: this.global, actor });
    for (const l of this.bumpListeners) l(key, this.global, actor);
    return this.global;
  }

  /** Avisa cada revisão nova (usado pelo StateHub para emitir eventos). */
  onBump(listener: (key: ParamKey, revision: number, actor: Actor) => void): () => void {
    this.bumpListeners.add(listener);
    return () => this.bumpListeners.delete(listener);
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
