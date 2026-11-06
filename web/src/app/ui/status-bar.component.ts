import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';

/** Faixa de modo (azul LAB / vermelho REAL), estado da ligação e saída. */
@Component({
  selector: 'mx-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'mx-status-bar',
    '[class.mode-lab]': "mode() !== 'real'",
    '[class.mode-real]': "mode() === 'real'",
  },
  template: `
    <div class="brand">MixAI</div>
    <div class="mode-chip" data-testid="mode">{{ modeText() }}</div>
    <div class="link-chip" [class]="'link-chip state-' + linkState()" data-testid="link" role="status">
      <span class="dot"></span>{{ linkText() }}
    </div>
    <div class="spacer"></div>
    <div class="role-chip">{{ session.role() === 'operator' ? 'Operador' : 'Músico' }}</div>
    <ng-content select="[status-action]" />
    <button type="button" class="btn btn-ghost" (click)="session.logout()">Sair</button>
  `,
})
export class StatusBarComponent {
  readonly live = inject(LiveService);
  readonly session = inject(SessionService);

  readonly mode = computed(() => this.live.hello()?.mode ?? 'lab');
  readonly modeText = computed(() => (this.mode() === 'real' ? 'MESA REAL' : this.mode() === 'lab' ? 'LABORATÓRIO' : 'SIMULADOR'));
  /** ok | warn | down */
  readonly linkState = computed(() => {
    const c = this.live.connection();
    if (c !== 'online') return 'down';
    const link = this.live.state()?.link;
    return link === 'READY' ? 'ok' : 'warn';
  });
  readonly linkText = computed(() => {
    const c = this.live.connection();
    if (c === 'connecting') return 'Conectando…';
    if (c === 'offline') return 'Sem servidor — reconectando…';
    if (c === 'idle') return 'Desconectado';
    const link = this.live.state()?.link;
    const texts: Record<string, string> = {
      READY: 'Conectado',
      DEGRADED_READ_ONLY: 'Somente leitura',
      SYNCING: 'Sincronizando…',
      CONNECTING: 'Mesa conectando…',
      LOST: 'Mesa caiu — reconectando…',
      STOPPED: 'Controle parado',
      DISCONNECTED: 'Mesa desconectada',
    };
    return link ? (texts[link] ?? link) : 'Carregando…';
  });
}
