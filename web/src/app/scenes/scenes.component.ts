import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActionsService } from '../core/actions.service';
import { formatDb } from '../core/db';
import { PendingCardsComponent } from '../ui/pending-cards.component';
import { ScenesUiService, type SceneGroup } from './scenes.service';

type Dialog = 'save' | 'rename' | 'delete' | 'confirm' | null;
type Filter = 'ALL' | SceneGroup;

const MAX_IMPORT_BYTES = 256 * 1024;

/**
 * Área CENAS (E5). Painel em tela cheia, aberto pela barra da Mesa e fechado quando quiser:
 * não ocupa o espaço dos faders. Lista à esquerda, detalhes à direita, comparação e o cartão
 * de aprovação no próprio painel. Cena do MixAI ≠ snapshot da Soundcraft.
 */
@Component({
  selector: 'mx-scenes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PendingCardsComponent],
  host: { class: 'mx-scenes', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'scenes-title' },
  template: `
    <header class="scenes-head">
      <h2 id="scenes-title">Cenas do MixAI</h2>
      <p class="scenes-note">
        Arquivos do MixAI guardados neste computador. <strong>Não são os snapshots da Soundcraft</strong> (esses ficam na própria mesa).
        @if (!s.canLoad()) {
          <strong class="warn"> Fora do laboratório: só ver, renomear, importar e exportar.</strong>
        } @else {
          Carregar só no LABORATÓRIO, depois da sua confirmação.
        }
      </p>
      <button type="button" class="btn" (click)="s.open.set(false)">Fechar</button>
    </header>

    @if (s.notice(); as n) {
      <div class="scenes-notice" [class]="'scenes-notice tone-' + n.tone" role="status" data-testid="scenes-notice">
        <span>{{ n.text }}</span>
        @if (n.details?.length) {
          <ul>
            @for (d of n.details; track $index) {
              <li>{{ d }}</li>
            }
          </ul>
        }
        <button type="button" class="btn btn-ghost btn-small" (click)="s.notice.set(null)" aria-label="Fechar aviso">OK</button>
      </div>
    }

    <div class="scenes-body">
      <aside class="scenes-list" aria-label="Cenas salvas">
        <div class="scenes-list-actions">
          <button type="button" class="btn btn-primary" [disabled]="!s.canLoad() || !!s.busy()" (click)="openDialog('save')">Salvar estado atual</button>
          <button type="button" class="btn" [disabled]="!!s.busy()" (click)="file.click()">Importar</button>
          <input #file type="file" accept="application/json,.json" hidden (change)="importFile($event)" data-testid="scene-import-input" />
        </div>
        <ul>
          @for (sc of s.scenes(); track sc.id) {
            <li>
              <button type="button" class="scene-item" [class.on]="sc.id === s.selectedId()" (click)="s.select(sc.id)" [attr.aria-pressed]="sc.id === s.selectedId()">
                <strong>{{ sc.name }}</strong>
                <small>{{ date(sc.updatedAt) }} · {{ sc.params }} parâmetros</small>
              </button>
            </li>
          } @empty {
            <li class="scenes-empty">Nenhuma cena ainda. Ajuste a mesa e toque em "Salvar estado atual", ou importe um arquivo.</li>
          }
        </ul>
        @if (s.invalidFiles().length) {
          <div class="scenes-invalid" data-testid="scenes-invalid">
            <p>{{ s.invalidFiles().length }} arquivo(s) em data/scenes não podem ser usados (foram mantidos no disco):</p>
            <ul>
              @for (f of s.invalidFiles(); track f.file) {
                <li>
                  <strong>{{ f.file }}</strong>:
                  {{ f.reason === 'DEVICE_MISMATCH' ? 'cena de outro equipamento.' : 'arquivo ilegível ou inválido.' }}
                  <small>{{ f.error }}</small>
                </li>
              }
            </ul>
          </div>
        }
      </aside>

      <section class="scenes-detail" aria-label="Cena selecionada">
        @if (s.selected(); as sc) {
          <div class="scene-info">
            <h3>{{ sc.name }}</h3>
            @if (sc.description) {
              <p>{{ sc.description }}</p>
            }
            <p class="scene-meta">
              Criada {{ date(sc.createdAt) }} · atualizada {{ date(sc.updatedAt) }} · {{ sc.deviceProfile.model.toUpperCase() }}
              ({{ sc.deviceProfile.inputs }} entradas, {{ sc.deviceProfile.aux }} AUX) ·
              {{ sc.validationStatus === 'UNVERIFIED' ? 'não validada em ensaio' : 'validada em ensaio' }}
            </p>
            <p class="scene-meta">
              Mesa real (futuro): {{ sc.compat.compatible }} compatível(is) · {{ sc.compat.unknown }} ainda não validado(s) ·
              {{ sc.compat.incompatible }} incompatível(is)
            </p>
          </div>
          <div class="scene-actions">
            <button type="button" class="btn btn-primary" [disabled]="!s.canLoad() || !!s.busy()" (click)="s.compare()">Comparar</button>
            <button
              type="button"
              class="btn btn-approve"
              [disabled]="!canRequestLoad() || !!s.busy()"
              [attr.aria-describedby]="loadHint() ? 'load-hint' : null"
              (click)="openDialog('confirm')"
            >
              Carregar…
            </button>
            <button type="button" class="btn" [disabled]="!!s.busy()" (click)="s.duplicate()">Duplicar</button>
            <button type="button" class="btn" [disabled]="!!s.busy()" (click)="openDialog('rename')">Renomear</button>
            <button type="button" class="btn" [disabled]="!!s.busy()" (click)="exportScene()">Exportar</button>
            <button type="button" class="btn btn-reject" [disabled]="!!s.busy()" (click)="openDialog('delete')">Excluir</button>
          </div>
          @if (loadHint(); as h) {
            <p id="load-hint" class="assist-hint">{{ h }}</p>
          }

          @if (s.loadCard(); as card) {
            <div class="scene-confirm" data-testid="scene-load-card">
              <p><strong>Confirmação final.</strong> Só depois de "Aprovar" o laboratório muda. Se a mesa mudar antes, este cartão é cancelado sozinho.</p>
              <mx-pending-cards [cards]="[card]" [canDecide]="true" [busy]="actions.deciding()" (approve)="actions.decide($event, true)" (reject)="actions.decide($event, false)" />
            </div>
          }

          <div class="segmented scene-tabs" role="tablist" aria-label="Filtro">
            @for (f of filters; track f) {
              <button type="button" role="tab" [attr.aria-selected]="filter() === f" [class.on]="filter() === f" (click)="filter.set(f)">
                {{ f === 'ALL' ? 'Todos' : f }}
                @if (s.comparison(); as c) {
                  <small>({{ f === 'ALL' ? c.totals.changes : c.totals.byGroup[f] }})</small>
                }
              </button>
            }
          </div>

          @if (s.comparison(); as c) {
            <div class="scene-compare" data-testid="scene-compare">
              <p class="compare-total" data-testid="compare-total">
                <strong>{{ c.totals.applicable }} alteração(ões) a aplicar</strong>
                @if (c.totals.notApplicable) {
                  · {{ c.totals.notApplicable }} diferença(s) ainda não aplicável(is)
                }
                · comparado agora com o laboratório; nada foi alterado.
              </p>
              @if (diffRows().length) {
                <table class="scene-table">
                  <thead>
                    <tr><th>Canal</th><th>Destino</th><th>Atual</th><th>Cena</th><th>Diferença</th></tr>
                  </thead>
                  <tbody>
                    @for (r of diffRows(); track r.key) {
                      <tr [class]="'kind-' + r.kind + (r.applicable ? '' : ' na')">
                        <td>{{ r.channel }}</td>
                        <td><span [class]="'dest dest-' + destClass(r.group, r.destination)">{{ r.destination }}</span></td>
                        <td>{{ show(r.current, r.kind) }}</td>
                        <td>
                          {{ show(r.target, r.kind) }}
                          @if (r.clampedTo !== undefined) {
                            <small class="clamp">→ {{ show(r.clampedTo, r.kind) }} (teto)</small>
                          }
                        </td>
                        <td>
                          @if (!r.applicable) {
                            <small>não aplicável: {{ r.reason }}</small>
                          } @else if (r.kind === 'mute') {
                            {{ r.target === true ? 'vai MUTAR' : 'vai ABRIR' }}
                          } @else if (r.deltaDB !== null) {
                            <strong>{{ delta(r.deltaDB) }}</strong>
                          } @else {
                            {{ show(r.target, r.kind) }}
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="scenes-empty">Nenhuma diferença {{ filter() === 'ALL' ? '' : 'em ' + filter() }}.</p>
              }
            </div>
          } @else if (s.detail(); as d) {
            <div class="scene-view">
              <p class="compare-total">Parâmetros guardados na cena ({{ viewRows().length }} neste filtro). Toque em <strong>Comparar</strong> para ver o que mudaria.</p>
              <table class="scene-table">
                <thead>
                  <tr><th>Canal</th><th>Destino</th><th>Valor</th><th>Situação</th></tr>
                </thead>
                <tbody>
                  @for (r of viewRows(); track r.key) {
                    <tr [class.na]="!r.applicable">
                      <td>{{ r.channel }}</td>
                      <td><span [class]="'dest dest-' + destClass(r.group, r.destination)">{{ r.destination }}</span></td>
                      <td>{{ show(r.value, r.kind) }}{{ r.kind === 'other' ? ' (' + paramName(r.key) + ')' : '' }}</td>
                      <td>
                        <small>{{ r.applicable ? 'carregável no LAB' : r.reason }}</small>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
              @if (d.unknownKeys.length) {
                <p class="scenes-invalid">{{ d.unknownKeys.length }} parâmetro(s) não existem nesta mesa (guardados, nunca aplicados).</p>
              }
            </div>
          }
        } @else {
          <p class="scenes-empty">Escolha uma cena na lista.</p>
        }
      </section>
    </div>

    @if (dialog(); as dlg) {
      <div class="scenes-modal" role="dialog" aria-modal="true" [attr.aria-label]="dialogTitle()">
        <form class="scenes-modal-box" (submit)="$event.preventDefault(); submitDialog()">
          <h3>{{ dialogTitle() }}</h3>
          @if (dlg === 'save' || dlg === 'rename') {
            <label for="scene-name">Nome</label>
            <input id="scene-name" name="name" maxlength="60" autocomplete="off" [value]="name()" (input)="name.set($any($event.target).value)" />
            <label for="scene-desc">Descrição (opcional)</label>
            <textarea id="scene-desc" name="description" maxlength="500" rows="3" [value]="description()" (input)="description.set($any($event.target).value)"></textarea>
            @if (dlg === 'save') {
              <p class="scene-meta">Guarda o estado atual do LABORATÓRIO. A mesa não muda.</p>
            }
          } @else if (dlg === 'delete') {
            <p>Excluir a cena <strong>{{ s.selected()?.name }}</strong>? O arquivo sai da lista (fica em data/scenes/excluidas, para recuperação manual).</p>
          } @else if (dlg === 'confirm') {
            @if (s.comparison(); as c) {
              <p>
                Carregar <strong>{{ s.selected()?.name }}</strong> no LABORATÓRIO:
                <strong>{{ c.totals.applicable }} parâmetro(s)</strong> mudam, em {{ loadSummary().length }} destino(s):
              </p>
              <ul class="load-summary" data-testid="load-summary">
                @for (d of loadSummary(); track d.destination) {
                  <li>
                    <span [class]="'dest dest-' + destClass(d.group, d.destination)">{{ d.destination }}</span>
                    <span>
                      <strong>{{ d.total }} alteração(ões)</strong>
                      ({{ d.level ? d.level + ' volume' + (d.level > 1 ? 's' : '') : '' }}{{ d.level && d.mute ? ', ' : '' }}{{ d.mute ? d.mute + ' mute' + (d.mute > 1 ? 's' : '') : '' }})
                      @if (d.channels.length) {
                        — {{ d.channels.join(', ') }}
                      }
                    </span>
                  </li>
                }
              </ul>
              @if (c.totals.notApplicable) {
                <p class="scene-meta">{{ c.totals.notApplicable }} diferença(s) ainda não aplicável(is) ficam como estão.</p>
              }
              <p class="scene-meta">Depois deste passo aparece o cartão de aprovação. Nada muda até você tocar em "Aprovar".</p>
            }
          }
          <div class="card-actions">
            <button type="button" class="btn" (click)="dialog.set(null)">Cancelar</button>
            <button type="submit" class="btn" [class.btn-reject]="dlg === 'delete'" [class.btn-primary]="dlg !== 'delete'" [disabled]="!!s.busy()">
              {{ dlg === 'delete' ? 'Excluir' : dlg === 'confirm' ? 'Pedir carregamento' : 'Salvar' }}
            </button>
          </div>
        </form>
      </div>
    }
  `,
})
export class ScenesComponent {
  readonly s = inject(ScenesUiService);
  readonly actions = inject(ActionsService);
  readonly dialog = signal<Dialog>(null);
  readonly name = signal('');
  readonly description = signal('');
  readonly filter = signal<Filter>('ALL');
  readonly filters: Filter[] = ['ALL', 'PA', 'FONES', 'MASTER', 'OUTROS'];

  readonly diffRows = computed(() => {
    const rows = this.s.comparison()?.rows ?? [];
    const f = this.filter();
    return f === 'ALL' ? rows : rows.filter((r) => r.group === f);
  });
  readonly viewRows = computed(() => {
    const rows = this.s.detail()?.rows ?? [];
    const f = this.filter();
    return f === 'ALL' ? rows : rows.filter((r) => r.group === f);
  });
  readonly canRequestLoad = computed(() => {
    const c = this.s.comparison();
    return this.s.canLoad() && !!c && c.sceneId === this.s.selectedId() && c.totals.applicable > 0 && !this.s.loadCard();
  });
  /** Por que "Carregar…" está desabilitado (nunca sem motivo). */
  readonly loadHint = computed(() => {
    if (!this.s.canLoad()) return 'Carregar só existe no LABORATÓRIO.';
    if (this.s.loadCard()) return null;
    const c = this.s.comparison();
    if (!c) return 'Para carregar, toque em Comparar primeiro.';
    if (!c.totals.applicable) return 'Nada a aplicar: o laboratório já está como a cena.';
    return null;
  });
  readonly dialogTitle = computed(() => {
    const d = this.dialog();
    return d === 'save' ? 'Salvar estado atual como cena' : d === 'rename' ? 'Renomear cena' : d === 'delete' ? 'Excluir cena' : 'Carregar cena no laboratório';
  });

  openDialog(d: Exclude<Dialog, null>): void {
    const sel = this.s.selected();
    this.name.set(d === 'rename' ? (sel?.name ?? '') : '');
    this.description.set(d === 'rename' ? (sel?.description ?? '') : '');
    this.dialog.set(d);
  }

  async submitDialog(): Promise<void> {
    const d = this.dialog();
    let done = true;
    if (d === 'save') done = await this.s.save(this.name(), this.description());
    else if (d === 'rename') done = await this.s.update(this.name(), this.description());
    else if (d === 'delete') done = await this.s.remove(this.s.selected()?.name ?? '');
    else if (d === 'confirm') await this.s.requestLoad();
    if (done) this.dialog.set(null);
  }

  async importFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > MAX_IMPORT_BYTES) {
      this.s.notice.set({ tone: 'error', text: `Arquivo grande demais (${Math.round(f.size / 1024)} KB; máximo 256 KB).` });
      return;
    }
    await this.s.importText(await f.text());
  }

  async exportScene(): Promise<void> {
    const out = await this.s.exportScene();
    if (!out) return;
    const url = URL.createObjectURL(new Blob([out.json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = out.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  show(v: number | boolean | '-inf' | null, kind: string): string {
    if (v === null) return '?';
    if (typeof v === 'boolean') return v ? 'MUTE' : 'aberto';
    if (v === '-inf') return '−∞ dB';
    return kind === 'level' ? `${formatDb(v)} dB` : String(v);
  }

  delta(d: number): string {
    return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} dB`;
  }

  date(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  paramName(key: string): string {
    return key.replace(/^ch\.\d+\./, '');
  }

  /**
   * Resumo final do carregamento: TODOS os destinos com alterações aplicáveis (PA, FONES, cada
   * AUX pelo número, MASTER), com volume/mute e os canais. Nada fica escondido em "outros".
   */
  readonly loadSummary = computed(() => {
    const rows = (this.s.comparison()?.rows ?? []).filter((r) => r.applicable);
    const order: Record<SceneGroup, number> = { PA: 0, FONES: 1, OUTROS: 2, MASTER: 3 };
    const byDest = new Map<string, { destination: string; group: SceneGroup; level: number; mute: number; total: number; channels: string[] }>();
    for (const r of rows) {
      const d = byDest.get(r.destination) ?? { destination: r.destination, group: r.group, level: 0, mute: 0, total: 0, channels: [] };
      if (r.kind === 'mute') d.mute++;
      else d.level++;
      d.total++;
      if (r.group !== 'MASTER' && !d.channels.includes(r.channel)) d.channels.push(r.channel);
      byDest.set(r.destination, d);
    }
    return [...byDest.values()].sort((a, b) => order[a.group] - order[b.group] || a.destination.localeCompare(b.destination, 'pt-BR', { numeric: true }));
  });

  /** Classe CSS do selo de destino (outros AUX e EQ/HPF têm selo próprio). */
  destClass(group: SceneGroup, destination: string): string {
    if (group === 'OUTROS') return destination.startsWith('AUX') ? 'AUX' : destination;
    return destination;
  }
}
