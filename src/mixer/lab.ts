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

  /** Volta tudo ao estado inicial do laboratório (e grava). */
  resetToDefaults() {
    this.values = this.store.defaults();
    this.current = {};
    this.markDirty();
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
