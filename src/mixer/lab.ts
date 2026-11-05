import type { ParamKey, ParamValue } from '../core/revisions.js';
import { LabStore, type LoadResult } from './lab-store.js';
import { SimulatedMixer, UI16_CAPS } from './simulated.js';
import type { MixerCapabilities } from './types.js';

export interface LabMixerOptions {
  /** Caminho do arquivo de estado (JSON versionado). */
  file: string;
  caps?: MixerCapabilities;
  /** Espera antes de gravar, juntando mudanças seguidas (padrão 300 ms). */
  saveDebounceMs?: number;
  /** Avisos de gravação (não derrubam o controle). */
  onSaveError?: (err: Error) => void;
}

/**
 * Laboratório: mesa virtual no formato da Ui16, com estado persistente em disco.
 * - nunca abre conexão de rede (não importa a biblioteca da Soundcraft nem o código da mesa real);
 * - mantém níveis, mutes, envios de AUX, EQ/HPF/bypass (estes só no laboratório) e o snapshot atual;
 * - grava em JSON versionado, de forma atômica, com backup e recuperação (ver LabStore).
 */
export class LabMixer extends SimulatedMixer {
  readonly mode = 'lab' as const;
  readonly store: LabStore;
  readonly loadResult: LoadResult;
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;
  private lastSaveError: string | undefined;

  constructor(private opts: LabMixerOptions) {
    super(opts.caps ?? UI16_CAPS, { Laboratório: ['Inicial', 'Ensaio', 'Bar'] });
    this.store = new LabStore(opts.file, this.registry, this.caps.model);
    this.loadResult = this.store.load();
    this.values = new Map(this.loadResult.values);
    this.current = { ...this.loadResult.currentSnapshot };
  }

  statusText() {
    const base =
      this.state === 'READY'
        ? 'Laboratório pronto (sem conexão com a mesa física)'
        : this.state === 'DISCONNECTED'
          ? 'Laboratório desligado'
          : `Laboratório em ${this.state}`;
    return this.lastSaveError ? `${base}. ATENÇÃO: última gravação falhou (${this.lastSaveError})` : base;
  }

  override async disconnect() {
    this.flush();
    await super.disconnect();
  }

  /** Grava imediatamente o que estiver pendente (usado ao sair). */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.dirty) return;
    try {
      this.store.save({ values: this.values, currentSnapshot: this.current });
      this.dirty = false;
      this.lastSaveError = undefined;
    } catch (err) {
      this.lastSaveError = (err as Error).message;
      this.opts.onSaveError?.(err as Error);
    }
  }

  /**
   * Volta tudo ao estado inicial do laboratório (e grava).
   *
   * Use `MixController.resetLab()`: ele serializa o reset na fila de comandos e devolve um
   * resultado. Mesmo chamado direto, o reset avisa o controlador num ÚNICO lote
   * (onParamBatch, origem `reset`), que gera as revisões, invalida o desfazer e as
   * confirmações pendentes e emite um só evento: nenhum cliente fica com valores antigos.
   *
   * @returns os parâmetros que mudaram.
   */
  resetToDefaults(): ParamKey[] {
    const defaults = this.store.defaults();
    const changes: Array<[ParamKey, ParamValue]> = [];
    for (const [key, value] of defaults) {
      if (this.values.get(key) !== value) changes.push([key, value]);
    }
    this.values = defaults;
    this.current = {};
    this.markDirty();
    this.emitBatch(changes, 'reset');
    return changes.map(([k]) => k);
  }

  protected override afterWrite(_key: ParamKey, _value: ParamValue) {
    this.markDirty();
  }

  protected override afterSnapshot() {
    this.markDirty();
  }

  private markDirty() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), this.opts.saveDebounceMs ?? 300);
    this.saveTimer.unref?.();
  }
}
