import { Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, inject, input, output, viewChild } from '@angular/core';
import { InstructorService } from './instructor.service';
import { instructionUrl } from './instructor-contract';

@Component({
  selector: 'mx-ui16-instructor',
  template: `
    @if (instructor.available()) {
      @if (instructor.open()) {
        <dialog #dialog aria-labelledby="instructor-title" (cancel)="$event.preventDefault(); close()" (keydown)="trap($event)">
          <header><div><small>APRENDER · SOMENTE LAB</small><h2 id="instructor-title">Instrutor visual Ui16</h2></div><button type="button" class="btn" (click)="close()">Fechar instrutor</button></header>
          <p class="instructor-safety" role="note">Somente estudo no LAB. Não se conecta à Ui16 nem executa operações.</p>
          @if (!instructor.connected()) { <p class="warning" role="status">Sem conexão com o servidor. Revise as orientações já carregadas; nenhuma operação será enviada ou repetida.</p> }
          @if (instructor.loading()) { <p role="status" aria-busy="true">Carregando orientações…</p> }
          @if (instructor.error()) { <p class="warning" role="alert">{{ instructor.error() }}</p><button class="btn" (click)="instructor.load()">Tentar novamente</button> }
          @if (instructor.catalog()) {
            @if (instructor.procedure(); as procedure) {
              <button type="button" class="btn secondary" (click)="instructor.tasks()">Todas as tarefas</button>
              <h3 #heading tabindex="-1">{{ procedure.title }}</h3>
              <p>{{ procedure.purpose }}</p>
              <p class="version">{{ procedure.validation === 'fixture' ? 'FIXTURE TEMPORÁRIA — não validada' : 'Procedimento documentado' }} · {{ procedure.version }}</p>
              <details><summary>Versão, limites e pré-condições</summary><p>{{ procedure.interfaceLimit }}</p><ul>@for (item of procedure.preconditions; track $index) { <li>{{ item }}</li> }</ul></details>
              @if (instructor.complete()) {
                <section class="completion" role="status"><h4>Estudo concluído</h4><p>Você revisou o guia. Isso não comprova execução, configuração correta ou validação na mesa física.</p></section>
                <div class="navigation"><button class="btn" (click)="instructor.back()">Voltar à última etapa</button><button class="btn" (click)="instructor.restart()">Reiniciar tutorial</button></div>
              } @else if (instructor.step(); as step) {
                <p class="progress" role="status">Etapa {{ instructor.index() + 1 }} de {{ procedure.steps.length }}</p>
                <progress aria-label="Progresso do estudo" [value]="instructor.index() + 1" [max]="procedure.steps.length"></progress>
                <h4 class="control">{{ step.control }}</h4>
                <figure aria-label="Diagrama esquemático da etapa">
                  <figcaption>ESQUEMA DIDÁTICO — não é screenshot nem posição real de controles.</figcaption>
                  <ol class="schematic">@for (label of step.schematic; track $index) { <li [class.current]="$index === 1">{{ label }}</li> }</ol>
                </figure>
                <div class="step-copy"><section><h4>Orientação</h4><p>{{ step.action }}</p></section><section><h4>O que conferir visualmente</h4><p>{{ step.expected }}</p></section></div>
                <aside class="warning"><strong>Cuidado</strong><p>{{ step.caution }}</p></aside>
                @if (procedure.id === 'aux1') { <p class="warning">AUX1 é compartilhado no HA800. Mudanças na mix são ouvidas por todos; não é retorno individual.</p> }
                <details><summary>Onde fica?</summary><p>Procure pelo nome “{{ step.control }}” no contexto documentado. {{ procedure.interfaceLimit }}</p></details>
                @if (instructor.missing()) {
                  <section class="not-found" role="alert" tabindex="-1"><h4>Não encontrou? Não avance por tentativa.</h4><p>{{ step.alternative }}</p><button class="btn" (click)="instructor.found()">Já conferi, retomar etapa</button></section>
                }
                <div class="navigation">
                  <button class="btn" [disabled]="instructor.index() === 0" (click)="instructor.back()">Voltar</button>
                  <button class="btn secondary" [disabled]="instructor.missing()" (click)="instructor.notFound()">Não encontrei</button>
                  @if (instructor.index() < procedure.steps.length - 1) { <button class="btn primary" [disabled]="instructor.missing()" (click)="instructor.next()">Avançar</button> }
                  @else { <button class="btn primary" [disabled]="instructor.missing()" (click)="instructor.finish()">Concluir estudo</button> }
                </div>
                <button class="btn secondary" (click)="instructor.restart()">Reiniciar tutorial</button>
              }
              <footer><h4>Origem e versão</h4><a [href]="url(procedure.origin.url)" target="_blank" rel="noopener noreferrer">{{ procedure.origin.title }}</a><p>{{ procedure.origin.version }} · {{ procedure.origin.locator }}</p><p>Links externos são abertos apenas por sua ação. Se indisponíveis, consulte o operador; não improvise.</p></footer>
            } @else {
              <h3 #heading tabindex="-1">O que você quer aprender?</h3>
              <p>Guias iniciais de navegação. Fixtures não substituem procedimentos técnicos revisados nem representam sua tela ou firmware.</p>
              <div class="task-grid">@for (procedure of instructor.catalog()!.procedures; track procedure.id) {
                <button type="button" class="task" (click)="instructor.choose(procedure.id)"><strong>{{ procedure.title }}</strong><span>{{ procedure.purpose }}</span><small>{{ procedure.steps.length }} etapas · {{ procedure.validation === 'fixture' ? 'fixture temporária' : procedure.version }}</small></button>
              }</div>
            }
          }
        </dialog>
      }
    }
  `,
  styles: [`
    :host { display:block; } .instructor-launch { margin:6px 12px; min-height:48px; }
    dialog { width:min(900px,calc(100vw - 24px)); max-width:calc(100vw - 24px); max-height:90dvh; padding:20px; border:1px solid #5c7893; border-radius:18px; background:#111d2a; color:#edf4fc; overflow:auto; }
    dialog::backdrop { background:#030a12cc; } header { display:flex; align-items:center; justify-content:space-between; gap:12px; } h2,h3,h4 { margin:10px 0; } h2 { font-size:1.4rem; } p { line-height:1.5; overflow-wrap:anywhere; } small,.version { color:#a5d8ff; }
    .btn,.task,summary { min-height:48px; } button { cursor:pointer; } button:disabled { cursor:not-allowed; opacity:.55; } :focus-visible { outline:3px solid #82d5ff; outline-offset:3px; }
    .instructor-safety,.warning,.not-found { border-left:4px solid #f6c466; background:#302918; padding:12px; border-radius:6px; } .instructor-safety { border-color:#70cdf0; background:#193249; } .completion { padding:16px; background:#173b34; border-radius:12px; }
    .task-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; } .task { display:flex; flex-direction:column; gap:8px; text-align:left; padding:16px; color:inherit; background:#1b3044; border:1px solid #58718b; border-radius:12px; } .task span { line-height:1.4; }
    .navigation { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0; } .primary { background:#2267a6; } .secondary { background:#24364a; } progress { width:100%; accent-color:#68c4f3; }
    figure { margin:16px 0; padding:14px; background:#1a2c3e; border:1px dashed #82a9cd; border-radius:12px; } figcaption { font-size:.8rem; color:#b7d7f4; } .schematic { list-style:none; padding:0; display:flex; flex-wrap:wrap; gap:10px; } .schematic li { border:1px solid #567999; padding:12px; border-radius:8px; flex:1; min-width:100px; overflow-wrap:anywhere; } .schematic .current { border-color:#7acfff; background:#204666; }
    summary { cursor:pointer; padding:12px 0; } footer { margin-top:20px; border-top:1px solid #56718b; } footer a { color:#86d5ff; overflow-wrap:anywhere; } .step-copy { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
    @media(max-width:600px) { dialog { padding:14px; } header { align-items:flex-start; } header .btn { font-size:.8rem; } .task-grid,.step-copy { grid-template-columns:1fr; } .navigation .btn { flex:1; } h2 { font-size:1.15rem; } }
  `],
})
export class InstructorComponent {
  readonly instructor = inject(InstructorService);
  readonly autostart = input(false);
  readonly closed = output<void>();
  readonly url = instructionUrl;
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private previous = '';
  constructor() {
    afterNextRender(() => { if (this.autostart()) void this.instructor.show(); });
    inject(DestroyRef).onDestroy(() => this.dialog()?.nativeElement.close?.());
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.open) dialog.showModal?.();
      const p = this.instructor.procedure();
      const key = `${this.instructor.catalog()?.procedures.length}:${p?.id}:${this.instructor.index()}:${this.instructor.complete()}:${this.instructor.missing()}`;
      if (dialog && this.previous !== key) { this.previous = key; dialog.scrollTop = 0; if (this.instructor.missing()) { const help = dialog.querySelector<HTMLElement>('.not-found'); help?.focus(); help?.scrollIntoView?.({ block:'nearest' }); } else this.heading()?.nativeElement.focus({ preventScroll:true }); }
    });
  }
  close() { this.instructor.open.set(false); this.closed.emit(); }
  trap(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const elements = Array.from(this.dialog()?.nativeElement.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary,[tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === this.heading()?.nativeElement)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
}
