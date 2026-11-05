import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActionsService } from '../core/actions.service';
import { formatDb } from '../core/db';
import { LiveService } from '../core/live.service';
import { keys } from '../core/protocol';

/**
 * Fones no celular: lista dos canais com − / + de 2 dB no AUX dos músicos (retorno
 * compartilhado). Sem arraste, para evitar mudança acidental. Aviso fixo: muda o fone de TODOS.
 */
@Component({
  selector: 'mx-fones-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-fones-list' },
  template: `
    <div class="shared-warning big" role="note">
      <strong>{{ auxName() }}</strong>: é um só retorno para todos. <strong>Isto muda o fone de TODOS.</strong>
    </div>
    <ul class="fones-rows">
      @for (row of rows(); track row.number) {
        <li class="fones-row" [class.is-muted]="row.muted">
          <div class="fones-name">
            <span>{{ row.name }}</span>
            @if (row.muted) {
              <small class="badge-mute">MUTE no fone</small>
            }
          </div>
          <button
            type="button"
            class="step step-down"
            [attr.aria-label]="'Diminuir ' + row.name + ' no fone'"
            [disabled]="!live.writable() || row.db === null || actions.isBusy('fones:' + row.number)"
            (click)="step(row.number, -2)"
          >
            −
          </button>
          <output class="fones-value" [attr.data-testid]="'fones-value-' + row.number">{{ row.text }}</output>
          <button
            type="button"
            class="step step-up"
            [attr.aria-label]="'Aumentar ' + row.name + ' no fone'"
            [disabled]="!live.writable() || row.db === null || actions.isBusy('fones:' + row.number)"
            (click)="step(row.number, 2)"
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

  readonly aux = computed(() => this.live.hello()?.musicianAux ?? 1);
  readonly auxName = computed(() => this.live.auxes().find((a) => a.number === this.aux())?.name ?? `AUX ${this.aux()}`);
  readonly rows = computed(() => {
    const params = this.live.state()?.params ?? {};
    const aux = this.aux();
    return this.live.channels().map((ch) => {
      const level = params[keys.level(ch.number, aux)]?.value;
      const mute = params[keys.mute(ch.number, aux)]?.value;
      const db = level?.status === 'known' && typeof level.value === 'number' ? level.value : null;
      const text = level?.status === 'unavailable' ? 'sem leitura' : db === null ? '?' : `${formatDb(db)} dB`;
      return { number: ch.number, name: ch.name, db, text, muted: mute?.status === 'known' && mute.value === true };
    });
  });

  step(channel: number, delta: number): void {
    void this.actions.run(`fones:${channel}`, { type: 'set_level', channel, aux: this.aux(), deltaDB: delta });
  }
}
