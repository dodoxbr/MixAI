import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ActionsService } from '../core/actions.service';
import { formatDb } from '../core/db';
import { LiveService } from '../core/live.service';
import { keys } from '../core/protocol';

/** Passo dos botões − / + (dB). No PA do músico, o servidor limita a 3 dB por comando. */
const STEP_DB = 2;

/**
 * Lista do celular com MUTE/ABRIR e − / + de 2 dB por canal. Sem arraste (evita mudança acidental).
 * - target "fones" (padrão): AUX dos músicos (retorno compartilhado). Aviso: muda o fone de TODOS;
 *   mutar aqui NÃO silencia o som do público.
 * - target "pa": canais do PA (som do público). Só aparece para o músico quando o servidor está
 *   em pa_without_master. Nunca mostra o MASTER. Mute sempre de UM canal (nunca em grupo).
 * O servidor confere tudo de novo (perfil, destino, AUX autorizado).
 */
@Component({
  selector: 'mx-fones-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-fones-list', '[class.is-pa]': "target() === 'pa'" },
  template: `
    @if (target() === 'pa') {
      <div class="shared-warning big pa-warning" role="note">
        <span class="dest dest-PA">PA</span> <strong>Som do público.</strong> Passos de {{ step }} dB; mudanças maiores pedem o operador. O MASTER é só do operador.
      </div>
    } @else {
      <div class="shared-warning big" role="note">
        <span class="dest dest-FONES">FONES</span> <strong>{{ auxName() }} (AUX {{ aux() }}{{ aux() === 1 ? ' — HA800' : '' }})</strong>: é um só retorno para todos. <strong>Isto muda o fone de TODOS.</strong>
        <span class="fones-note">MUTE aqui silencia o canal só nos fones; o som do público (PA) não muda.</span>
      </div>
    }
    <ng-content />
    <ul class="fones-rows" [attr.aria-label]="target() === 'pa' ? 'Canais no PA' : 'Canais nos fones'">
      @for (row of rows(); track row.number) {
        <li class="fones-row has-mute" [class.is-muted]="row.muted">
          <div class="fones-name">
            <span>{{ row.name }}</span>
            @if (row.muted) {
              <small class="badge-mute">MUTE {{ where() }}</small>
            }
          </div>
          <button
            type="button"
            class="step mute-toggle"
            [class.on]="row.muted"
            [attr.aria-label]="(row.muted ? 'Abrir ' : 'Mutar ') + row.name + ' ' + where()"
            [attr.aria-pressed]="row.muted"
            [attr.data-testid]="'mute-' + target() + '-' + row.number"
            [disabled]="!live.writable() || (live.hello()?.role === 'musician' && !live.musicianBinding()?.mute) || row.mute === null || actions.isBusy(key(row.number))"
            (click)="toggleMute(row.number, row.muted)"
          >
            <span class="mute-word">{{ actions.isBusy(key(row.number)) ? '…' : row.muted ? 'ABRIR' : 'MUTE' }}</span>
            <small class="mute-dest">{{ target() === 'pa' ? 'PA' : 'FONES' }}</small>
          </button>
          <button
            type="button"
            class="step step-down"
            [attr.aria-label]="'Diminuir ' + row.name + ' ' + where()"
            [disabled]="!live.writable() || row.db === null || actions.isBusy(key(row.number))"
            (click)="change(row.number, -step)"
          >
            −
          </button>
          <output class="fones-value" [attr.data-testid]="testId() + row.number">{{ row.text }}</output>
          <button
            type="button"
            class="step step-up"
            [attr.aria-label]="'Aumentar ' + row.name + ' ' + where()"
            [disabled]="!live.writable() || row.db === null || actions.isBusy(key(row.number))"
            (click)="change(row.number, step)"
          >
            +
          </button>
        </li>
      }
    </ul>
  `,
})
export class FonesListComponent {
  readonly live = inject(LiveService);
  readonly actions = inject(ActionsService);
  readonly target = input<'fones' | 'pa'>('fones');
  get step() { return Math.min(STEP_DB, this.live.hello()?.musicianPaStepDB ?? 3); }

  readonly aux = computed(() => this.live.hello()?.musicianAux ?? 1);
  readonly auxName = computed(() => this.live.auxes().find((a) => a.number === this.aux())?.name ?? `AUX ${this.aux()}`);
  readonly where = computed(() => (this.target() === 'pa' ? 'no PA' : 'no fone'));
  readonly testId = computed(() => (this.target() === 'pa' ? 'pa-value-' : 'fones-value-'));
  readonly rows = computed(() => {
    const params = this.live.state()?.params ?? {};
    const aux = this.target() === 'pa' ? undefined : this.aux();
    return this.live.channels().filter(ch => this.live.hello()?.role !== 'musician' || this.live.musicianBinding()?.channels.includes(ch.number)).map((ch) => {
      const level = params[keys.level(ch.number, aux)]?.value;
      const muteV = params[keys.mute(ch.number, aux)]?.value;
      const db = level?.status === 'known' && typeof level.value === 'number' ? level.value : null;
      const text = level?.status === 'unavailable' ? 'sem leitura' : db === null ? '?' : `${formatDb(db)} dB`;
      const mute = muteV?.status === 'known' && typeof muteV.value === 'boolean' ? muteV.value : null;
      return { number: ch.number, name: ch.name, db, text, mute, muted: mute === true };
    });
  });

  key(channel: number): string {
    return `${this.target()}:${channel}`;
  }

  change(channel: number, delta: number): void {
    if (!this.live.writable() || this.actions.isBusy(this.key(channel))) return;
    const aux = this.target() === 'pa' ? undefined : this.aux();
    void this.actions.run(this.key(channel), { type: 'set_level', channel, aux, deltaDB: delta });
  }

  /**
   * MUTE/ABRIR de UM canal no destino desta lista: FONES → AUX autorizado (musicianAux);
   * PA → sem AUX. Enquanto o pedido está pendente, os botões da linha ficam desabilitados.
   */
  toggleMute(channel: number, muted: boolean): void {
    const key = this.key(channel);
    if (this.actions.isBusy(key) || !this.live.writable()) return;
    const aux = this.target() === 'pa' ? undefined : this.aux();
    void this.actions.run(key, { type: 'set_mute', channels: [channel], muted: !muted, aux });
  }
}
