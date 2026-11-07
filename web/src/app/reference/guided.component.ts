import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ReferenceUiService } from './reference.service';
/** Independent request journey, deliberately outside the conversation/chat components (#56). */
@Component({ selector: 'mx-guided-request', imports: [FormsModule], template: `
<details><summary>Atendimento guiado — revisar antes de enviar</summary>
  <p>Relato humano não verificado. Diagnóstico teórico não mede áudio nem executa ajustes. AUX1 é compartilhado no HA800.</p>
  <fieldset [disabled]="ui.busy()"><label>Relato para atendimento<textarea aria-label="Relato para atendimento" maxlength="500" [(ngModel)]="report" (ngModelChange)="reset()"></textarea></label>
  <label>Sintoma informado<input aria-label="Sintoma informado" maxlength="500" [(ngModel)]="symptom" (ngModelChange)="reset()"></label>
  <label>Fonte confirmada<select aria-label="Fonte confirmada" [(ngModel)]="channel" (ngModelChange)="reset()"><option value="">Escolha o canal</option>@for(c of ui.data()?.channels || []; track c.number) {<option [value]="c.number">CH{{c.number}} — {{c.name}}</option>}</select></label>
  <label>Destino confirmado<select aria-label="Destino confirmado" [(ngModel)]="destination" (ngModelChange)="reset()"><option value="">Escolha o destino</option><option value="PA">PA</option><option value="AUX1">AUX1 compartilhado</option></select></label>
  <label>Verificações relatadas (uma por linha)<textarea aria-label="Verificações relatadas" maxlength="2000" [(ngModel)]="checks" (ngModelChange)="reset()"></textarea></label>
  <label><input type="checkbox" [(ngModel)]="confirmed" (ngModelChange)="resetPreview()">Confirmo fonte e destino para consultar</label>
  <button type="button" [disabled]="ui.busy() || !confirmed || !channel || !destination || !report.trim() || !symptom.trim()" (click)="prepare()">Consultar antes de enviar</button>
  </fieldset>
  @if(ui.preview(); as preview) {
    <p>Relato revisado: {{preview.report}} · sintoma: {{preview.context.symptom}}</p><p>CH{{preview.context.sourceChannel}} · {{preview.context.destination}} · {{preview.context.evidenceLevel}}</p>
    <p style="white-space:pre-wrap">{{preview.context.diagnosis.text}}</p>
    <p>Estado observado no LAB: revisão {{preview.context.observed.stateRevision}} · {{preview.context.observed.available ? 'disponível' : 'indisponível'}}. Sem medição real. Referência: {{preview.context.referenceId || 'não selecionada'}}.</p>
    <label><input type="checkbox" [(ngModel)]="reviewed">Revisei a orientação e quero enviar ao operador</label>
    <button type="button" [disabled]="ui.busy() || !reviewed" (click)="send()">Enviar pedido ao mesário</button>
    <button type="button" (click)="resetPreview()">Descartar consulta</button>
  }
</details>` })
export class GuidedRequestComponent {
  readonly ui = inject(ReferenceUiService);
  report = ''; symptom = ''; channel = ''; destination = ''; checks = ''; confirmed = false; reviewed = false;
  resetPreview() { this.reviewed = false; this.ui.preview.set(null); }
  reset() { this.confirmed = false; this.resetPreview(); }
  prepare() { this.reviewed = false; return this.ui.prepareGuided({ report: this.report, symptom: this.symptom, sourceChannel: Number(this.channel), destination: this.destination, checksPerformed: this.checks.split('\n').map(s => s.trim()).filter(Boolean), targetConfirmed: this.confirmed }); }
  async send() { if (await this.ui.sendGuided()) { this.report = ''; this.symptom = ''; this.checks = ''; this.confirmed = false; this.reviewed = false; } }
}
