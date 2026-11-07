import { GuidedRequestComponent } from './guided.component';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LiveService } from '../core/live.service';
import { newId } from '../core/protocol';
import { ReferenceUiService, type Help } from './reference.service';
@Component({ selector: 'mx-reference-workspace', imports: [FormsModule, GuidedRequestComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`:host{display:block;min-width:0}.workspace{border:1px solid #52616b;border-radius:8px;padding:.6rem;margin:.4rem;max-height:42vh;overflow:auto}.columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem}input,select,textarea{max-width:100%;margin:.2rem;padding:.35rem}textarea{width:95%}table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{padding:.3rem;text-align:left;border-bottom:1px solid #52616b}.relevant{background:#655123}.request{border:1px solid #52616b;border-radius:6px;padding:.5rem;margin:.4rem 0}.actions{display:flex;flex-wrap:wrap;gap:.3rem}.muted{font-size:.85rem;opacity:.85}@media(max-width:720px){.columns{grid-template-columns:1fr}.workspace{max-height:38vh}}`],
  template: `@if (eligible()) {
    @if (!ui.open()) { <button type="button" class="btn btn-small" (click)="ui.open.set(true)" [attr.aria-expanded]="false" [attr.aria-label]="operator() ? 'Referência e pedidos' : 'Solicitar ao operador'">{{operator() ? 'Referência e pedidos' : 'Solicitar ao operador'}} ({{activeCount()}})</button> }
    @if (ui.open() && !ui.data()) { <section class="workspace"><p role="alert">{{ui.error() || 'Carregando referência e pedidos…'}}</p><button type="button" (click)="ui.refresh()">Atualizar bandeja</button><button type="button" (click)="ui.open.set(false)">Recolher painel</button></section> }
    @if (ui.data(); as data) {
    @if (ui.open()) {
      <section class="workspace" aria-label="Referência e solicitações LAB">
        <div class="actions"><strong>Referência e pedidos — LAB</strong><button type="button" (click)="ui.refresh()">Atualizar bandeja</button><button type="button" (click)="ui.open.set(false)">Recolher painel</button></div>
        <p class="muted">Valores de fader/MUTE, não medição acústica. Comparar não restaura nada. AUX1 é compartilhado por todos no HA800.</p>
        @if (ui.error()) { <p role="alert">{{ ui.error() }}</p> }
        <div class="columns">
          @if (operator()) {
            <section aria-label="Mixagem de referência">
              <h3>Referência aprovada pelo operador</h3>
              <input aria-label="Evento" maxlength="60" [(ngModel)]="eventName" placeholder="Evento / apresentação">
              <input aria-label="Data do evento" type="date" [(ngModel)]="eventDate">
              <select aria-label="Escopo da referência" [(ngModel)]="scope"><option value="PA">PA</option><option value="AUX1">FONES — AUX1 compartilhado</option></select>
              <label><input type="checkbox" [(ngModel)]="approved">Aprovo salvar o estado observado (LAB; não valida o som)</label>
              <div class="actions"><button type="button" [disabled]="ui.busy() || !approved || !eventName.trim() || !live.state()?.available" (click)="capture()">Salvar referência LAB</button><button type="button" (click)="newEvent()">Novo evento</button></div>
              <select aria-label="Referência salva" [ngModel]="ui.selected()" (ngModelChange)="select($event)"><option value="">Selecione evento e versão</option>@for (r of data.references; track r.id) { <option [value]="r.id">{{r.eventName}} · {{r.eventDate}} · {{r.scope}} v{{r.version}}</option> }</select>
              @if (ui.compared(); as c) {
                <p class="muted">UNVERIFIED: aprovação de registro, sem validação acústica. Cena MixAI E5; não é snapshot nativo Soundcraft. Sem recall automático.</p>
                <table aria-label="Comparação da referência"><thead><tr><th>Canal / parâmetro</th><th>Referência</th><th>Atual</th><th>Delta</th><th>Origem conhecida</th></tr></thead><tbody>
                  @for (r of rows(); track r.key) { <tr [class.relevant]="r.relevant"><td>{{r.label}}</td><td>{{r.saved}}</td><td>{{r.now}}</td><td>{{r.delta}}</td><td>{{r.actor}}</td></tr> }
                </tbody></table>
                <details><summary>Revisões da referência</summary>@for (h of c.reference.history; track h.version) { <p class="muted">v{{h.version}} · {{h.at}} · {{h.action}} · {{h.role}}</p> }</details>
              }
            </section>
          } @else {
            <section aria-label="Solicitação ao operador">
              <mx-guided-request /><h3>Solicitar ao operador</h3><p class="muted">{{data.identity.verified ? data.identity.displayName : 'Sessão sem identidade vinculada — o canal informado é apenas relato, não permissão.'}}</p>
              <select aria-label="Tipo do pedido" [(ngModel)]="type"><option value="meu_canal">Meu canal (vínculo validado no servidor)</option><option value="mix_geral">Mix geral</option><option value="diagnostico">Pedir avaliação técnica ao operador</option></select>
              <select aria-label="Canal relatado" [(ngModel)]="channel"><option value="">Fonte a informar / mix geral</option>@for (c of data.channels; track c.number) { <option [value]="c.number">CH{{c.number}} — {{c.name}}</option> }</select>
              <select aria-label="Destino do pedido" [(ngModel)]="destination"><option value="PA">PA</option><option value="AUX1">FONES — AUX1 compartilhado</option></select>
              <textarea aria-label="Problema relatado" maxlength="500" [(ngModel)]="report" placeholder="Relate o problema; não informe PIN ou segredos"></textarea>
              <button type="button" [disabled]="ui.busy() || !report.trim()" (click)="send()">Enviar solicitação</button>
            </section>
          }
          <section aria-label="Bandeja de solicitações"><h3>{{operator() ? 'Bandeja do mesário' : 'Meus pedidos'}} ({{activeCount()}} ativos)</h3>
            <label><input type="checkbox" [(ngModel)]="showClosed">Mostrar encerrados</label>
            @if (operator() && !data.integrations.recommendations) { <p class="muted">Consulta técnica indisponível. Avalie manualmente; nenhuma recomendação executa ajuste.</p> }
            @for (r of visibleRequests(); track r.id) {
              <article class="request"><strong>{{r.destination === 'AUX1' ? 'FONES: AUX1 compartilhado' : 'PA'}} · {{channelName(r.channel)}} · {{r.state}} · v{{r.version}}</strong>
                <p>{{r.report}}</p><p class="muted">{{r.requestedBy.verified ? r.requestedBy.displayName : 'Sessão ' + r.requestedBy.sourceSessionId.slice(0,6) + ' — identidade não verificada'}} · prazo {{r.expiresAt}}</p>
                @if (r.recommendation?.source === 'diagnosis') {
                  <details><summary>Consulta técnica ao mesário IA — {{r.recommendation.status || 'somente leitura'}}</summary>
                    <p style="white-space:pre-wrap">{{r.recommendation.text}}</p>
                    @for (url of r.recommendation.references || []; track url) { <a [href]="url" target="_blank" rel="noopener noreferrer">Fonte técnica</a> }
                  </details>
                }
                @if (r.guidedContext; as context) {
                  <details><summary>Contexto do atendimento — {{context.symptom}}</summary>
                    <p>CH{{context.sourceChannel}} · {{context.destination}} · relato humano: {{context.evidenceLevel}}</p>
                    <p>Verificações declaradas: {{context.checksPerformed.join('; ') || 'nenhuma'}}. Não são medições.</p>
                    <p style="white-space:pre-wrap">{{context.diagnosis.text}}</p>
                    <p>Estado LAB na consulta: revisão {{context.observed.stateRevision}} · {{context.observed.available ? 'disponível' : 'indisponível'}}.</p>
                    @if (operator()) {
                      <label>Referência para comparar<select #reference aria-label="Referência do atendimento"><option value="">Sem referência</option>@for(ref of data.references; track ref.id) { @if(ref.scope === r.destination) {<option [value]="ref.id">{{ref.eventName}} v{{ref.version}}</option>} }</select></label>
                      <button type="button" [disabled]="!reference.value" (click)="ui.compare(reference.value)">Comparar atendimento (somente leitura)</button>
                    }
                    <p>Rollback informativo: nenhuma restauração automática; revisão manual pelo operador.</p>
                  </details>
                }
                @if (r.response) { <p>Resposta: {{r.response}}</p> }
                @if (!closed(r.state)) {
                  <textarea [attr.aria-label]="'Resposta ' + r.id" maxlength="500" [(ngModel)]="notes[r.id]" placeholder="Resposta / esclarecimento / orientação"></textarea>
                  <div class="actions">
                    @if (operator()) {
                      <button type="button" [disabled]="ui.busy() || !data.integrations.recommendations" (click)="ui.assess(r)">Consultar mesário IA (somente leitura)</button>
                      <button type="button" [disabled]="ui.busy() || !note(r)" (click)="ui.decide(r, 'needs_information', note(r))">Pedir informação</button>
                      <button type="button" [disabled]="ui.busy() || !note(r)" (click)="ui.decide(r, 'suggested', note(r))">Sugerir orientação</button>
                      <button type="button" [disabled]="ui.busy() || !note(r)" (click)="ui.decide(r, 'approved', note(r))">Aprovar orientação (não aplica)</button>
                      <button type="button" [disabled]="ui.busy() || !note(r)" (click)="ui.decide(r, 'rejected', note(r))">Recusar</button>
                      <button type="button" [disabled]="ui.busy() || !note(r)" (click)="ui.decide(r, 'closed', note(r))">Encerrar atendimento (não aplica)</button>
                      <button type="button" [disabled]="ui.busy() || !note(r)" (click)="ui.decide(r, 'failed', note(r))">Registrar impedimento</button>
                    } @else { <button type="button" [disabled]="ui.busy() || !notes[r.id]?.trim()" (click)="ui.reply(r, notes[r.id] || '')">Complementar relato</button> }
                    <button type="button" [disabled]="ui.busy()" (click)="ui.cancel(r)">Cancelar pedido</button>
                  </div>
                }
                <button type="button" (click)="ui.details(r)">Histórico ({{r.historyCount}})</button>
                @for (h of ui.history()[r.id] || []; track h.version) { <p class="muted">v{{h.version}} · {{h.at}} · {{h.role}} · {{h.action}} {{h.note}}</p> }
              </article>
            } @empty { <p>Nenhum pedido nesta sessão/filtro.</p> }
          </section>
        </div>
      </section>
    }
    }
  }`,
})
export class ReferenceWorkspaceComponent {
  readonly ui = inject(ReferenceUiService); readonly live = inject(LiveService);
  readonly eligible = computed(() => this.live.hello()?.mode === 'lab' && ['operator', 'musician'].includes(this.live.hello()?.role ?? ''));
  readonly operator = computed(() => this.live.hello()?.role === 'operator');
  eventId = newId('evento'); eventName = ''; eventDate = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(); scope: 'PA' | 'AUX1' = 'PA'; approved = false;
  report = ''; type = 'mix_geral'; channel = ''; destination = 'AUX1'; notes: Record<string, string> = {}; showClosed = false;
  readonly activeCount = computed(() => this.ui.data()?.requests.filter(r => !this.closed(r.state)).length ?? 0);
  visibleRequests() { return [...(this.ui.data()?.requests ?? [])].reverse().filter(r => this.showClosed || !this.closed(r.state)); }
  closed(state: string) { return ['rejected', 'failed', 'expired', 'cancelled', 'applied', 'closed'].includes(state); }
  note(r: Help) { return this.notes[r.id]?.trim() || r.response || ''; }
  channelName(channel?: number) { return channel ? `CH${channel} — ${this.ui.data()?.channels.find(c => c.number === channel)?.name ?? 'a confirmar'}` : 'Mix geral / fonte a informar'; }
  newEvent() { this.eventId = newId('evento'); this.eventName = ''; this.approved = false; void this.ui.compare(''); }
  select(id: string) { const r = this.ui.data()?.references.find(r => r.id === id); if (r) { this.eventId = r.eventId; this.eventName = r.eventName; this.eventDate = r.eventDate; this.scope = r.scope; } this.approved = false; void this.ui.compare(id); }
  async capture() { const version = Math.max(0, ...(this.ui.data()?.references.filter(r => r.eventId === this.eventId && r.scope === this.scope).map(r => r.version) ?? [])); const result = await this.ui.capture({ eventId: this.eventId, eventName: this.eventName, eventDate: this.eventDate, scope: this.scope, expectedVersion: version, operatorApproved: this.approved }); if (result) this.approved = false; }
  async send() { if (await this.ui.send({ type: this.type, report: this.report, destination: this.destination, ...(this.channel ? { channel: Number(this.channel) } : {}) })) this.report = ''; }
  readonly rows = computed(() => (this.ui.compared()?.rows ?? []).map(row => {
    const snapshot = this.live.state(); const state = snapshot?.params[row.key];
    const current = snapshot?.available ? state?.value : undefined;
    const a = row.reference.status === 'known' ? row.reference.value === '-inf' ? -Infinity : row.reference.value : undefined;
    const b = current?.status === 'known' ? current.value : undefined;
    const changed = a !== undefined && b !== undefined && (typeof a !== 'number' || typeof b !== 'number' ? a !== b : a === b ? false : !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) >= 0.05);
    const delta = typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
    const text = (v: unknown, status: string) => v === undefined ? status : typeof v === 'boolean' ? v ? 'MUTE' : 'aberto' : v === -Infinity ? '−∞ dB' : `${Number(v).toFixed(1)} dB`;
    const ch = /^ch\.(\d+)/.exec(row.key); const name = ch ? this.ui.compared()?.reference.channels.find(c => c.number === Number(ch[1]))?.name ?? '?' : 'MASTER';
    return { key: row.key, label: ch ? `CH${ch[1]} — ${name} (${row.key.endsWith('mute') ? 'mute' : 'volume'})` : 'MASTER', saved: text(a, row.reference.status), now: text(b, snapshot?.available ? current?.status ?? 'unknown' : 'indisponível/desatualizado'), delta: delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB`, relevant: changed && (delta === null || Math.abs(delta) >= 3), actor: state?.actor === 'external' ? 'externa observada (LAB)' : state?.actor ?? 'desconhecida' };
  }));
}
