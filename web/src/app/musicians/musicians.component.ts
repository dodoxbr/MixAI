import { Component, inject, output, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { ActionsService } from '../core/actions.service';
@Component({
  selector: 'mx-musicians',
  host: { role: 'dialog', 'aria-label': 'Vínculos de músicos', 'aria-modal': 'true' },
  template: `
    <button class="btn" (click)="closed.emit()">Fechar vínculos</button><details open (toggle)="refresh()"><summary>Vincular músicos — somente LAB</summary>
      <p>Confira com a pessoa o código exibido no celular. Vínculo vale somente para esta sessão autenticada.</p>
      <button class="btn" (click)="refresh()">Atualizar sessões</button>
      @for (s of sessions(); track s.sessionId) {
        <section>
          <p>Sessão {{ s.sessionId }} — {{ s.binding?.name ?? 'sem vínculo' }}</p>
          <label>Músico<select #person>
            @for (p of roster(); track p.id) { <option [value]="p.id">{{ p.name }} — CH {{ p.channels.join(', ') }}</option> }
          </select></label>
          <label>Canais autorizados (separados por vírgula; vazio usa o mapa do músico)<input #channels aria-label="Canais autorizados" /></label>
          <label><input #mute type="checkbox" /> Permitir MUTE individual</label>
          <button class="btn" [disabled]="actions.isBusy('binding')" (click)="bind(s.sessionId, person.value, channels.value, mute.checked)">Confirmar vínculo no LAB</button>
          <button class="btn" [disabled]="actions.isBusy('binding')" (click)="revoke(s.sessionId)">Revogar vínculo</button>
        </section>
      }
      <p role="status">{{ notice() }}</p>
    </details>`,
  styles: [`:host { display:block; position:fixed; inset:0; z-index:55; padding:16px; background:#101923; overflow:auto; } details { overflow:auto; } section { border:1px solid #698096; padding:12px; } label { display:block; margin:8px; } input,select,button,summary { min-height:48px; }`],
})
export class MusiciansComponent {
  readonly closed = output<void>();
  readonly live = inject(LiveService);
  readonly actions = inject(ActionsService);
  readonly sessions = signal<Array<{sessionId:string; binding: {name:string} | null}>>([]);
  readonly roster = signal<Array<{id:string; name:string; channels:number[]}>>([]);
  readonly notice = signal('');
  async refresh() {
    const r = await this.live.command({ type:'musician_sessions' });
    if (r.ok && r.data) { this.sessions.set(r.data['sessions'] as any); this.roster.set(r.data['roster'] as any); }
  }
  async bind(sessionId:string, id:string, raw:string, mute:boolean) {
    const person = this.roster().find(p => p.id === id);
    if (!person) return;
    const channels = raw.trim() ? raw.split(',').map(v => Number(v.trim())) : person.channels;
    const r = await this.actions.run('binding', { type:'musician_bind', sessionId, musicianId:person.id, name:person.name, channels, mute });
    this.notice.set(r.message); await this.refresh();
  }
  async revoke(sessionId:string) {
    const r = await this.actions.run('binding', { type:'musician_revoke', sessionId });
    this.notice.set(r.message); await this.refresh();
  }
}
