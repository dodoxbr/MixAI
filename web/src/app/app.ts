import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LiveService } from './core/live.service';
import { SessionService } from './core/session.service';
import { FonesComponent } from './views/fones.component';
import { LoginComponent } from './views/login.component';
import { MesaComponent } from './views/mesa.component';

/** Sem sessão → PIN. Operador → Mesa. Músico → Fones. (O servidor confere tudo de novo.) */
@Component({
  selector: 'mx-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LoginComponent, MesaComponent, FonesComponent],
  template: `
    @if (!session.token()) {
      <mx-login />
    } @else if (session.role() === 'operator') {
      <mx-mesa />
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
