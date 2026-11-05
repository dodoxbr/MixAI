import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import type { Result } from '../core/protocol';

export type SceneGroup = 'PA' | 'FONES' | 'MASTER' | 'OUTROS';
type Encoded = number | boolean | '-inf';

export interface SceneSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  validationStatus: 'UNVERIFIED' | 'VALIDATED_IN_REHEARSAL';
  deviceProfile: { model: string; inputs: number; aux: number };
  params: number;
  compat: { compatible: number; incompatible: number; unknown: number };
}

export interface SceneViewRow {
  key: string;
  group: SceneGroup;
  channel: string;
  destination: string;
  kind: 'level' | 'mute' | 'other';
  value: Encoded;
  applicable: boolean;
  reason?: string;
  compat: 'compatible' | 'incompatible' | 'unknown';
}

export interface SceneDiffRow {
  key: string;
  group: SceneGroup;
  channel: string;
  destination: string;
  kind: 'level' | 'mute' | 'other';
  current: Encoded | null;
  target: Encoded;
  deltaDB: number | null;
  applicable: boolean;
  reason?: string;
  clampedTo?: number;
}

export interface Comparison {
  sceneId: string;
  previewId: string;
  rows: SceneDiffRow[];
  totals: { changes: number; applicable: number; notApplicable: number; byGroup: Record<SceneGroup, number> };
  message: string;
}

export type Notice = { tone: 'ok' | 'info' | 'error'; text: string; details?: string[] } | null;

/**
 * Tela de CENAS DO MIXAI (E5). Só conversa com o servidor: quem decide permissão, validação,
 * diferença e aplicação é sempre o servidor. Carregar = comparar → pedir → aprovar o cartão.
 */
@Injectable({ providedIn: 'root' })
export class ScenesUiService {
  private readonly live = inject(LiveService);
  private readonly session = inject(SessionService);

  readonly open = signal(false);
  readonly scenes = signal<SceneSummary[]>([]);
  readonly invalidFiles = signal<Array<{ file: string; error: string }>>([]);
  readonly selectedId = signal<string | null>(null);
  readonly detail = signal<{ scene: SceneSummary; rows: SceneViewRow[]; unknownKeys: string[] } | null>(null);
  readonly comparison = signal<Comparison | null>(null);
  /** Pendência de carregamento aberta por esta tela (o cartão de aprovação da E2). */
  readonly loadPendingId = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  readonly notice = signal<Notice>(null);
  readonly canLoad = computed(() => !!this.live.hello()?.scenes?.canLoad);
  readonly selected = computed(() => this.scenes().find((s) => s.id === this.selectedId()) ?? null);
  /** O cartão da pendência de carregamento, enquanto estiver aberto. */
  readonly loadCard = computed(() => this.live.pending().find((c) => c.pendingId === this.loadPendingId()) ?? null);

  constructor() {
    // Troca de sessão: nada da sessão anterior continua na tela.
    effect(() => {
      this.session.token();
      untracked(() => this.reset());
    });
    // A pendência de carregamento foi resolvida (aprovada, recusada, invalidada, vencida):
    // compara de novo para mostrar o estado REAL do laboratório depois disso.
    effect(() => {
      const id = this.loadPendingId();
      const stillOpen = this.live.pending().some((c) => c.pendingId === id);
      if (id && !stillOpen) {
        untracked(() => {
          this.loadPendingId.set(null);
          const sid = this.selectedId();
          if (sid && this.open()) void this.compare(sid, true);
        });
      }
    });
  }

  private reset() {
    this.open.set(false);
    this.scenes.set([]);
    this.selectedId.set(null);
    this.detail.set(null);
    this.comparison.set(null);
    this.loadPendingId.set(null);
    this.notice.set(null);
  }

  private async run(key: string, command: Record<string, unknown> & { type: string }): Promise<Result> {
    this.busy.set(key);
    try {
      return await this.live.command(command, 15_000);
    } finally {
      this.busy.set(null);
    }
  }

  private fail(r: Result) {
    const errors = (r.data?.['errors'] as string[] | undefined) ?? [];
    this.notice.set({ tone: 'error', text: r.message, details: errors.length > 1 ? errors.slice(0, 8) : undefined });
  }

  async show(): Promise<void> {
    this.open.set(true);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const r = await this.run('list', { type: 'scene_list' });
    if (!r.ok) return this.fail(r);
    this.scenes.set((r.data?.['scenes'] as SceneSummary[]) ?? []);
    this.invalidFiles.set((r.data?.['invalid'] as Array<{ file: string; error: string }>) ?? []);
    const sel = this.selectedId();
    if (sel && !this.scenes().some((s) => s.id === sel)) this.select(null);
    else if (!sel && this.scenes().length) await this.select(this.scenes()[0]!.id);
  }

  async select(id: string | null): Promise<void> {
    this.selectedId.set(id);
    this.comparison.set(null);
    this.detail.set(null);
    if (!id) return;
    const r = await this.run('get', { type: 'scene_get', id });
    if (!r.ok) return this.fail(r);
    if (this.selectedId() === id) this.detail.set(r.data as never);
  }

  async save(name: string, description: string): Promise<boolean> {
    const r = await this.run('save', { type: 'scene_save', name, description });
    if (!r.ok) {
      this.fail(r);
      return false;
    }
    this.notice.set({ tone: 'ok', text: r.message });
    await this.refresh();
    await this.select((r.data?.['scene'] as SceneSummary).id);
    return true;
  }

  async duplicate(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    const r = await this.run('duplicate', { type: 'scene_duplicate', id });
    if (!r.ok) return this.fail(r);
    this.notice.set({ tone: 'ok', text: r.message });
    await this.refresh();
    await this.select((r.data?.['scene'] as SceneSummary).id);
  }

  async update(name: string, description: string): Promise<boolean> {
    const id = this.selectedId();
    if (!id) return false;
    const r = await this.run('update', { type: 'scene_update', id, name, description });
    if (!r.ok) {
      this.fail(r);
      return false;
    }
    this.notice.set({ tone: 'ok', text: r.message });
    await this.refresh();
    await this.select(id);
    return true;
  }

  async remove(expectedName: string): Promise<boolean> {
    const id = this.selectedId();
    if (!id) return false;
    const r = await this.run('delete', { type: 'scene_delete', id, expectedName });
    if (!r.ok) {
      this.fail(r);
      return false;
    }
    this.notice.set({ tone: 'ok', text: r.message });
    this.selectedId.set(null);
    await this.refresh();
    return true;
  }

  /** Devolve o arquivo para baixar (o componente cuida do download). */
  async exportScene(): Promise<{ fileName: string; json: string } | null> {
    const id = this.selectedId();
    if (!id) return null;
    const r = await this.run('export', { type: 'scene_export', id });
    if (!r.ok) {
      this.fail(r);
      return null;
    }
    this.notice.set({ tone: 'ok', text: r.message });
    return r.data as { fileName: string; json: string };
  }

  async importText(json: string): Promise<void> {
    const r = await this.run('import', { type: 'scene_import', json });
    if (!r.ok) return this.fail(r);
    const warnings = (r.data?.['warnings'] as string[]) ?? [];
    this.notice.set({ tone: 'ok', text: r.message, details: warnings.length ? warnings : undefined });
    await this.refresh();
    await this.select((r.data?.['scene'] as SceneSummary).id);
  }

  /** Compara com o estado atual (nada é alterado). `quiet` = depois de um carregamento. */
  async compare(id = this.selectedId(), quiet = false): Promise<void> {
    if (!id) return;
    const r = await this.run('compare', { type: 'scene_compare', id });
    if (!r.ok) return this.fail(r);
    const d = r.data as unknown as Omit<Comparison, 'sceneId' | 'message'>;
    this.comparison.set({ sceneId: id, previewId: d.previewId, rows: d.rows, totals: d.totals, message: r.message });
    if (!quiet) this.notice.set(null);
  }

  /** Pede o carregamento: o servidor cria o cartão de aprovação (nada muda ainda). */
  async requestLoad(): Promise<void> {
    const cmp = this.comparison();
    if (!cmp) return;
    const r = await this.run('load', { type: 'scene_load', id: cmp.sceneId, previewId: cmp.previewId });
    if (r.needsConfirmation && r.pendingId) {
      this.loadPendingId.set(r.pendingId);
      this.notice.set({ tone: 'info', text: 'Confirme no cartão abaixo. Nada foi alterado ainda.' });
      return;
    }
    if (r.ok) {
      this.notice.set({ tone: 'info', text: r.message });
      await this.compare(cmp.sceneId, true);
      return;
    }
    this.comparison.set(null); // prévia usada ou velha: precisa comparar de novo
    this.fail(r);
  }
}
