import { paramKey, type EqBand, type ParamKey, type ParamValue } from './revisions.js';
import { auxBus, MASTER, type MixerCapabilities } from '../mixer/types.js';

/**
 * De onde vem a confiança de que o parâmetro funciona na mesa:
 * - library_verified: existe na API da soundcraft-ui-connection e o MixAI já o envia;
 * - hardware_verified: testado na Ui16 física (nenhum ainda; muda depois do F0);
 * - simulated_only: só existe no laboratório; nunca é enviado à mesa real.
 */
export type Capability = 'library_verified' | 'hardware_verified' | 'simulated_only';

export type ParamKind = 'level' | 'mute' | 'eq_freq' | 'eq_q' | 'eq_gain' | 'hpf_freq' | 'hpf_slope' | 'eq_bypass';

export interface ParamSpec {
  key: ParamKey;
  kind: ParamKind;
  unit: 'dB' | 'bool' | 'Hz' | 'Q' | 'dB/oct';
  /** Faixa válida (inclusive). Para nível, -Infinity também é válido (fader todo para baixo). */
  min?: number;
  max?: number;
  /** Valores discretos permitidos (ex.: inclinação do HPF). */
  allowed?: readonly number[];
  /** Valor inicial no laboratório. NÃO é o padrão de fábrica da Ui16 (desconhecido). */
  labDefault: ParamValue;
  capability: Capability;
  /** Pode, no futuro, ser aplicado na mesa real (comparação/aplicação LAB → REAL item a item). */
  applicableToMixer: boolean;
  /** Fonte dos limites, para revisão. */
  source: string;
}

const LIB = 'soundcraft-ui-connection 7.1.0';

/** Limites tirados dos .d.ts/código da biblioteca 7.1.0 (EQ_FREQUENCY_MIN/MAX, EQ_GAIN_*, EQ_FILTERS). */
export const LIMITS = {
  level: { min: -Infinity, max: 10 },
  eqFreq: { min: 20, max: 22050 },
  eqQ: { min: 0.05, max: 15 },
  eqGain: { min: -20, max: 20 },
  hpfFreq: { min: 20, max: 1000 },
  hpfSlopes: [12, 24, 36] as const,
} as const;

/** Frequências iniciais das bandas no laboratório (neutras: ganho 0 dB). */
const LAB_BAND_FREQ: Record<EqBand, number> = { 1: 120, 2: 500, 3: 2000, 4: 8000 };

function level(key: ParamKey, labDefault: number): ParamSpec {
  return {
    key,
    kind: 'level',
    unit: 'dB',
    min: LIMITS.level.min,
    max: LIMITS.level.max,
    labDefault,
    capability: 'library_verified',
    applicableToMixer: true,
    source: LIB,
  };
}

function mute(key: ParamKey): ParamSpec {
  return { key, kind: 'mute', unit: 'bool', labDefault: false, capability: 'library_verified', applicableToMixer: true, source: LIB };
}

function eqSpecs(ch: number): ParamSpec[] {
  const out: ParamSpec[] = [];
  const sim = { capability: 'simulated_only' as const, applicableToMixer: false, source: LIB };
  for (const band of [1, 2, 3, 4] as const) {
    out.push(
      { key: paramKey.eqBand(ch, band, 'freq'), kind: 'eq_freq', unit: 'Hz', ...LIMITS.eqFreq, labDefault: LAB_BAND_FREQ[band], ...sim },
      { key: paramKey.eqBand(ch, band, 'q'), kind: 'eq_q', unit: 'Q', ...LIMITS.eqQ, labDefault: 1, ...sim },
      { key: paramKey.eqBand(ch, band, 'gain'), kind: 'eq_gain', unit: 'dB', ...LIMITS.eqGain, labDefault: 0, ...sim },
    );
  }
  out.push(
    // HPF em 20 Hz = desligado (convenção da biblioteca: "set it to its lowest frequency").
    { key: paramKey.hpf(ch, 'freq'), kind: 'hpf_freq', unit: 'Hz', ...LIMITS.hpfFreq, labDefault: 20, ...sim },
    { key: paramKey.hpf(ch, 'slope'), kind: 'hpf_slope', unit: 'dB/oct', allowed: LIMITS.hpfSlopes, labDefault: 12, ...sim },
    { key: paramKey.eqBypass(ch), kind: 'eq_bypass', unit: 'bool', labDefault: false, ...sim },
  );
  return out;
}

/** Registro central de todos os parâmetros que o MixAI conhece para um modelo de mesa. */
export class ParamRegistry {
  private readonly byKey = new Map<ParamKey, ParamSpec>();

  constructor(readonly caps: MixerCapabilities) {
    this.add(level(paramKey.master(), -6));
    for (let ch = 1; ch <= caps.inputs; ch++) {
      this.add(level(paramKey.level(ch, MASTER), -10));
      this.add(mute(paramKey.mute(ch, MASTER)));
      for (let a = 1; a <= caps.aux; a++) {
        this.add(level(paramKey.level(ch, auxBus(a)), -20));
        this.add(mute(paramKey.mute(ch, auxBus(a))));
      }
      for (const spec of eqSpecs(ch)) this.add(spec);
    }
  }

  private add(spec: ParamSpec) {
    this.byKey.set(spec.key, spec);
  }

  get(key: ParamKey): ParamSpec | undefined {
    return this.byKey.get(key);
  }

  has(key: ParamKey): boolean {
    return this.byKey.has(key);
  }

  keys(): ParamKey[] {
    return [...this.byKey.keys()];
  }

  specs(): ParamSpec[] {
    return [...this.byKey.values()];
  }

  /** Parâmetros que o adaptador da mesa real acompanha/envia hoje. */
  mixerKeys(): ParamKey[] {
    return this.specs()
      .filter((s) => s.capability !== 'simulated_only')
      .map((s) => s.key);
  }

  /** Mensagem de erro, ou undefined se o valor é válido para o parâmetro. */
  validate(key: ParamKey, value: unknown): string | undefined {
    const spec = this.byKey.get(key);
    if (!spec) return `parâmetro desconhecido: ${key}`;
    return validateValue(spec, value);
  }
}

export function validateValue(spec: ParamSpec, value: unknown): string | undefined {
  if (spec.unit === 'bool') return typeof value === 'boolean' ? undefined : `${spec.key}: esperado verdadeiro/falso`;
  if (typeof value !== 'number' || Number.isNaN(value)) return `${spec.key}: esperado número`;
  if (spec.allowed) {
    return spec.allowed.includes(value) ? undefined : `${spec.key}: valor ${value} fora de ${spec.allowed.join('/')}`;
  }
  if (spec.kind === 'level' && value === -Infinity) return undefined;
  if (!Number.isFinite(value)) return `${spec.key}: valor não finito`;
  if (spec.min !== undefined && value < spec.min) return `${spec.key}: ${value} abaixo do mínimo ${spec.min} ${spec.unit}`;
  if (spec.max !== undefined && value > spec.max) return `${spec.key}: ${value} acima do máximo ${spec.max} ${spec.unit}`;
  return undefined;
}
