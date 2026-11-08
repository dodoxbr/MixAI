import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LiveService } from './core/live.service';
import { SessionService } from './core/session.service';
import { KnowledgeAdminComponent } from './knowledge/knowledge-admin.component';
import { PrivatePttComponent } from './speech/private-ptt.component';
import { SpeechSpikeComponent } from './speech/speech-spike.component';
import { FonesComponent } from './views/fones.component';
import { LoginComponent } from './views/login.component';
import { MesaComponent } from './views/mesa.component';

/** Sem sessão → PIN. Operador → Mesa. Músico → Fones. (O servidor confere tudo de novo.) */
@Component({
  selector: 'mx-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LoginComponent, MesaComponent, FonesComponent, SpeechSpikeComponent, PrivatePttComponent, KnowledgeAdminComponent],
  template: `
    @if (!session.token()) {
      <mx-login />
    } @else if (session.role() === 'operator') {
      <mx-mesa />
      <mx-speech-spike />
      <mx-private-ptt />
      <mx-knowledge-admin />
      <div class="bar-spacer" aria-hidden="true"></div>
    } @else {
      <mx-fones />
    }
  `,
})
export class App {
  readonly session = inject(SessionService);
  /** Instanciado já na partida: liga o WebSocket assim que houver sessão. */
  readonly live = inject(LiveService);
}
