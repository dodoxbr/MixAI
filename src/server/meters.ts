import { paramKey } from '../core/revisions.js';
import { MASTER, type MixerAdapter } from '../mixer/types.js';

/** Quadro de medidores. Valores em dBFS aproximado; -∞ vai como "-inf". */
export interface MeterFrame {
  type: 'meters';
  /** Sempre presente e explícito: medição simulada não é medição da mesa. */
  simulated: boolean;
  source: 'lab' | 'mock';
  t: number;
  levels: Record<string, number | '-inf'>;
}

export interface MeterSource {
  readonly simulated: boolean;
  /** Um quadro agora (ou undefined se não há o que medir). */
  frame(): MeterFrame | undefined;
}

/**
 * Medidores SIMULADOS do laboratório: derivados do fader e do mute, com um pouco de variação.
 * Não representam o som real e não imitam a medição da Ui16 (a aquisição real fica para a E6).
 * Fica totalmente fora do estado observável: não gera revisões nem eventos de parâmetros.
 */
export class SimulatedMeters implements MeterSource {
  readonly simulated = true;

  constructor(
    private mixer: MixerAdapter,
    private channels: () => number[],
    private random: () => number = Math.random,
    private clock: () => number = Date.now,
  ) {}

  frame(): MeterFrame | undefined {
    if (this.mixer.mode === 'real') return undefined; // nunca inventar medição da mesa real
    const link = this.mixer.link();
    if (link !== 'READY' && link !== 'DEGRADED_READ_ONLY') return undefined;
    const levels: Record<string, number | '-inf'> = {};
    const master = this.mixer.read(paramKey.master());
    const masterDb = master.known && typeof master.value === 'number' ? master.value : -Infinity;
    let sum = 0;
    for (const ch of this.channels()) {
      const level = this.mixer.read(paramKey.level(ch, MASTER));
      const mute = this.mixer.read(paramKey.mute(ch, MASTER));
      const db = level.known && typeof level.value === 'number' ? level.value : -Infinity;
      const muted = mute.known && mute.value === true;
      if (muted || !Number.isFinite(db)) {
        levels[`ch.${ch}`] = '-inf';
        continue;
      }
      const v = Math.max(-60, Math.min(0, db - 14 + (this.random() - 0.5) * 8));
      levels[`ch.${ch}`] = Math.round(v * 10) / 10;
      sum += 10 ** (v / 10);
    }
    const mix = sum > 0 && Number.isFinite(masterDb) ? 10 * Math.log10(sum) + masterDb : -Infinity;
    levels.master = Number.isFinite(mix) ? Math.round(Math.max(-60, Math.min(0, mix)) * 10) / 10 : '-inf';
    return { type: 'meters', simulated: true, source: this.mixer.mode, t: this.clock(), levels };
  }
}
