import { ProviderSettingsComponent } from '../ai-settings/provider-settings.component';
import { InstructorLauncherComponent } from '../instructor/instructor-launcher.component';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { ToolsService } from '../core/tools.service';

/** Faixa de modo (azul LAB / vermelho REAL), estado da ligação e saída. */
@Component({
  selector: 'mx-status-bar',
  styles: [`
    :host.mode-lab { flex-wrap: wrap; }
    .ai-settings-icon { display: none; }
    @media (max-width: 720px) {
      .btn.ai-settings-trigger { width: 48px; min-width: 48px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
      .ai-settings-icon { display: block; width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; }
      .ai-settings-label { display: none; }
    }
  `],
  imports: [InstructorLauncherComponent, ProviderSettingsComponent],
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
    <ng-content select="[status-nav]" />
    <div class="spacer"></div>
    <div class="role-chip">{{ session.role() === 'operator' ? 'Operador' : 'Músico' }}</div>
    <ng-content select="[status-action]" />
    <ng-content select="[status-tools]" />
    @if (session.role() === 'operator') {
      <button type="button" class="btn btn-ghost ai-settings-trigger" aria-label="Configurações" title="Configurações" aria-haspopup="dialog" [attr.aria-expanded]="settingsOpen()" (click)="settingsOpen.set(true)">
        <svg class="ai-settings-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h4m4 0h10M3 17h10m4 0h4" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></svg>
        <span class="ai-settings-label">Configurações</span>
      </button>
    }
    <mx-instructor-launcher />
    <button type="button" class="btn btn-ghost" (click)="session.logout()">Sair</button>
    @if (settingsOpen() && session.role() === 'operator') {
      @defer (on immediate) { <mx-ai-provider-settings (closed)="settingsOpen.set(false)" /> }
      @placeholder { <p role="status">Abrindo configurações de IA…</p> }
    }
  `,
})
export class StatusBarComponent {
  readonly settingsOpen = inject(ToolsService).settingsOpen;
  readonly live = inject(LiveService);
  readonly session = inject(SessionService);

  readonly mode = computed(() => this.live.hello()?.mode ?? 'lab');
  readonly modeText = computed(() => (this.mode() === 'real' ? 'MESA REAL' : this.mode() === 'lab' ? 'LABORATÓRIO' : 'SIMULADOR'));
  /** ok | warn | down */
  readonly linkState = computed(() => {
    const c = this.live.connection();
    if (c !== 'online') return 'down';
    const link = this.live.state()?.link;
    return link === 'READY' && !this.live.synchronizing() ? 'ok' : 'warn';
  });
  readonly linkText = computed(() => {
    const c = this.live.connection();
    if (c === 'connecting') return 'Conectando…';
    if (c === 'offline') return 'Sem servidor — reconectando…';
    if (c === 'idle') return 'Desconectado';
    if (this.live.synchronizing()) return 'Sincronizando…';
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
