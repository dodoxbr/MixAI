import { Component, ElementRef, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { ReferenceUiService } from '../reference/reference.service';
import { newId } from '../core/protocol';
import { STATUS_LABEL, progressOf, progressText, stepStatus, type StepStatus } from './soundcheck-progress';
interface Step {
  human: {
    stepId: string;
    status: string;
    report?: string;
    observations?: string;
    problem?: string;
    checksPerformed: string[];
    equipment: string;
    humanConfirmed: boolean;
  };
  observed: { source: string; realReading: string; available: boolean; stateRevision: number };
  recordedAt: string;
}
interface Event {
  id: string;
  name: string;
  date: string;
  operatorName: string;
  version: number;
  status: string;
  interrupted: boolean;
  pendingSteps: string[];
  steps: Step[];
  channels: { number: number; name: string }[];
  reference?: { id: string; version: number };
  history: {
    version: number;
    at: string;
    action: string;
    operatorSessionId: string;
    step?: Step;
  }[];
}
interface Plan {
  id: string;
  title: string;
  instruction: string;
  channels: number[];
}
/**
 * Tela da passagem de som (operador, LAB). Somente registro humano: nenhum chat, fader, comando da mesa ou carga de
 * cena. O checklist é mostrado uma etapa por vez, com a lista de etapas (e a situação de cada uma) ao lado.
 */
@Component({
  selector: 'mx-soundcheck',
  imports: [FormsModule],
  host: { style: 'display:block' },
  styles: [
    `
      :host { display: block; }
      .screen { max-width: 1180px; margin: 0 auto; padding: 8px 16px 32px; display: flex; flex-direction: column; gap: 14px; }
      h2 { margin: 6px 0 2px; font-size: 1.5rem; }
      h2:focus, h4:focus { outline: none; }
      h2:focus-visible, h4:focus-visible { outline: 3px solid var(--brass-hi); outline-offset: 4px; border-radius: 6px; }
      h3 { margin: 0; font-size: 1.15rem; overflow-wrap: anywhere; }
      h4 { margin: 0 0 6px; font-size: 1.1rem; overflow-wrap: anywhere; }
      .notice { margin: 0; color: var(--muted); font-size: 0.92rem; max-width: 70ch; }
      .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
      .alert { margin: 0; padding: 10px 14px; border-radius: var(--radius); background: #3b1d20; border: 1px solid var(--mute); color: #ffd7d9; }
      .saved { margin: 0; padding: 10px 14px; border-radius: var(--radius); background: #14301f; border: 1px solid var(--ok); color: #cdeedd; }
      .interrupted { margin: 0; padding: 12px 14px; border-radius: var(--radius); background: #3b3110; border: 1px solid var(--warn); color: var(--warn); }
      label.field { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
      label.field > span { font-size: 0.95rem; }
      input, select, textarea { width: 100%; min-height: 44px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; font-weight: 400; }
      textarea { resize: vertical; line-height: 1.4; }
      input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--brass-hi); outline-offset: 1px; }
      select { min-width: 0; }
      .btn { min-height: 48px; padding: 0 18px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--panel-2); color: var(--text); font-weight: 700; cursor: pointer; }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn.primary { background: var(--brass); border-color: var(--brass); color: #1a1306; }
      .btn.primary:disabled { background: #6a5a33; color: #cdbb8a; }
      .btn:focus-visible { outline: 3px solid var(--brass-hi); outline-offset: 2px; }
      .picker { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
      .picker .grow { flex: 1 1 320px; }
      .new-event { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); align-items: end; }
      .new-event h3 { grid-column: 1 / -1; }
      .pills { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
      .pill { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 999px; font-size: 0.85rem; font-weight: 700; border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); white-space: nowrap; }
      .pill.st-verified { background: #14301f; border-color: var(--ok); color: #9fe0bf; }
      .pill.st-problem { background: #3b1d20; border-color: var(--mute); color: #ffb3b6; }
      .pill.st-not_applicable { background: #1e2c46; border-color: #3b82f6; color: #a9c8ff; }
      .head-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
      .progress { height: 12px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); overflow: hidden; margin-top: 8px; }
      .progress .bar { display: block; height: 100%; background: var(--ok); transition: width 0.2s; }
      .progress-text { margin: 6px 0 0; font-size: 0.95rem; color: var(--muted); }
      .workspace { display: grid; gap: 14px; grid-template-columns: minmax(250px, 340px) minmax(0, 1fr); align-items: start; }
      .steps-nav { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px; }
      .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .step { width: 100%; min-height: 48px; display: grid; grid-template-columns: 28px 1fr auto; grid-template-rows: auto; align-items: center; gap: 8px; text-align: left; padding: 6px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--text); cursor: pointer; font: inherit; }
      .step:hover { background: var(--panel-2); }
      .step.current { background: var(--panel-2); border-color: var(--brass); box-shadow: inset 4px 0 0 var(--brass); }
      .step:focus-visible { outline: 3px solid var(--brass-hi); outline-offset: 1px; }
      .step .num { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--bg); border: 1px solid var(--line); font-size: 0.8rem; font-weight: 700; }
      .step .t { overflow-wrap: anywhere; line-height: 1.25; }
      .jump { margin: 0 0 10px; }
      .instruction { margin: 0 0 12px; line-height: 1.5; overflow-wrap: anywhere; }
      fieldset { border: 1px solid var(--line); border-radius: var(--radius); margin: 0; padding: 12px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      legend { padding: 0 6px; font-weight: 700; color: var(--brass-hi); }
      .grid2 { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
      label.field.attention > span { color: #ffb3b6; }
      label.field.attention textarea { border-color: var(--mute); }
      label.check { display: flex; gap: 10px; align-items: flex-start; line-height: 1.4; }
      label.check input { width: 22px; min-height: 22px; margin-top: 2px; flex: none; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
      .actions .push { margin-left: auto; }
      .recorded { margin: 10px 0 0; font-size: 0.88rem; color: var(--muted); overflow-wrap: anywhere; }
      details.card > summary { cursor: pointer; font-weight: 700; min-height: 32px; }
      details.card[open] > summary { margin-bottom: 10px; }
      details.card p { overflow-wrap: anywhere; }
      .sub { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 8px 0; }
      .sub select { flex: 1 1 220px; width: auto; }
      .history p { margin: 6px 0; font-size: 0.92rem; }
      @media (max-width: 899px) {
        .workspace { grid-template-columns: minmax(0, 1fr); }
        /* Faixa compacta de números coloridos pela situação; o nome completo fica no título da etapa e no seletor. */
        .steps { flex-direction: row; gap: 6px; overflow-x: auto; padding-bottom: 6px; scroll-snap-type: x proximity; }
        .steps li { flex: 0 0 auto; scroll-snap-align: start; }
        .step { width: 48px; min-width: 48px; height: 48px; padding: 0; grid-template-columns: 1fr; justify-items: center; }
        .step .t, .step .pill { display: none; }
        .step .num { width: 34px; height: 34px; font-size: 0.95rem; }
        .step[data-status='verified'] .num { background: #14301f; border-color: var(--ok); color: #9fe0bf; }
        .step[data-status='problem'] .num { background: #3b1d20; border-color: var(--mute); color: #ffb3b6; }
        .step[data-status='not_applicable'] .num { background: #1e2c46; border-color: #3b82f6; color: #a9c8ff; }
      }
      @media (max-width: 520px) {
        .screen { padding: 6px 10px 28px; }
        .actions .btn { flex: 1 1 140px; }
        .actions .push { margin-left: 0; flex-basis: 100%; }
      }
    `,
  ],
  template: `
    @if (eligible()) {
      <section class="screen" aria-labelledby="sc-screen-title">
        <header>
          <h2 id="sc-screen-title" tabindex="-1">Passagem de som</h2>
          <p class="notice">
            Somente registro: nenhuma alteração de fader/EQ/gain/phantom/mute/master/cena. AUX1 é compartilhado por todos no HA800.
            Simulação LAB e relato humano não validam acústica nem leitura REAL.
          </p>
        </header>
        @if (ui.error()) {
          <p class="alert" role="alert">{{ ui.error() }}</p>
        }
        @if (saved()) {
          <p class="saved" role="status">{{ saved() }}</p>
        }

        <div class="picker card">
          <label class="field grow">
            <span>Evento</span>
            <select [disabled]="busy()" aria-label="Evento da passagem" [ngModel]="selected()?.id || ''" (ngModelChange)="load($event)">
              <option value="">Novo evento</option>
              @for (e of events(); track e.id) {
                <option [value]="e.id">{{ e.name }} · {{ e.date }} · {{ e.status }} · {{ e.pendingSteps.length }} pendências</option>
              }
            </select>
          </label>
          <button type="button" class="btn" [disabled]="busy()" (click)="refresh()">Atualizar eventos</button>
        </div>

        @if (!selected()) {
          <div class="card new-event">
            <h3>Novo evento de passagem de som</h3>
            <label class="field"><span>Nome do evento</span><input aria-label="Nome do evento da passagem" maxlength="100" [(ngModel)]="name" /></label>
            <label class="field"><span>Data</span><input aria-label="Data da passagem" type="date" [(ngModel)]="date" /></label>
            <label class="field"><span>Operador (declarado)</span><input aria-label="Operador da passagem" maxlength="60" [(ngModel)]="operatorName" /></label>
            <button type="button" class="btn primary" [disabled]="busy() || !name.trim() || !operatorName.trim() || !date" (click)="create()">Iniciar passagem LAB</button>
          </div>
        } @else if (selected(); as event) {
          <div class="card">
            <h3>{{ event.name }} — {{ event.date }} · v{{ event.version }} · {{ event.status }}</h3>
            <div class="pills">
              <span class="pill">{{ eventStatusLabel(event) }}</span>
              <span class="pill">Operador declarado: {{ event.operatorName }}</span>
              <span class="pill">Pendências: {{ event.pendingSteps.length }} de {{ plan().length }}</span>
            </div>
            <div class="progress" role="progressbar" aria-label="Progresso da passagem" aria-valuemin="0"
                 [attr.aria-valuemax]="progress().total" [attr.aria-valuenow]="progress().done" [attr.aria-valuetext]="progressSummary()">
              <span class="bar" [style.width.%]="progress().percent"></span>
            </div>
            <p class="progress-text">{{ progressSummary() }}. Autorizações e auditoria usam a sessão autenticada, não o nome declarado.</p>
            @if (event.interrupted) {
              <p class="interrupted" role="status">Passagem interrompida por reinício do servidor. Revise as pendências e retome explicitamente.</p>
            }
            <div class="head-actions">
              @if (event.status === 'paused' || event.interrupted) {
                <button type="button" class="btn primary" [disabled]="busy()" (click)="action('resume')">Retomar passagem</button>
              }
              @if (ready()) {
                <button type="button" class="btn" [disabled]="busy()" (click)="action('pause')">Pausar passagem</button>
                <button type="button" class="btn primary" [disabled]="busy() || event.pendingSteps.length > 0" (click)="action('complete')">Concluir registro aprovado</button>
              }
            </div>
            <details class="channels">
              <summary>Canais do evento ({{ event.channels.length }})</summary>
              <p>
                @for (ch of event.channels; track ch.number) {
                  <span>CH{{ ch.number }} {{ ch.name }}; </span>
                }
              </p>
            </details>
          </div>

          <div class="workspace">
            <nav class="steps-nav" aria-label="Etapas da passagem">
              <ol class="steps">
                @for (s of plan(); track s.id; let i = $index) {
                  <li>
                    <button type="button" class="step" [class.current]="s.id === stepId" [attr.aria-current]="s.id === stepId ? 'step' : null" [attr.data-status]="statusOf(s.id)" [attr.aria-label]="'Etapa ' + (i + 1) + ': ' + s.title + ' — ' + statusLabel(s.id)" [attr.title]="s.title" (click)="pick(s.id)">
                      <span class="num" aria-hidden="true">{{ i + 1 }}</span>
                      <span class="t">{{ s.title }}</span>
                      <span class="pill" [class]="'pill st-' + statusOf(s.id)">{{ statusLabel(s.id) }}</span>
                    </button>
                  </li>
                }
              </ol>
            </nav>

            <section class="step-card card" aria-labelledby="sc-step-title">
              <label class="field jump">
                <span>Ir para a etapa</span>
                <select aria-label="Etapa da passagem" [ngModel]="stepId" (ngModelChange)="pick($event)">
                  @for (s of plan(); track s.id) {
                    <option [value]="s.id">{{ s.title }}</option>
                  }
                </select>
              </label>
              <h4 id="sc-step-title" tabindex="-1">Etapa {{ index() + 1 }} de {{ plan().length }} · {{ current()?.title }}</h4>
              <p class="instruction">{{ current()?.instruction }}</p>
              <fieldset [disabled]="busy() || !ready()">
                <legend>Registro humano da etapa</legend>
                <div class="grid2">
                  <label class="field">
                    <span>Situação</span>
                    <select aria-label="Situação da etapa" [(ngModel)]="status">
                      <option value="pending">Pendente</option>
                      <option value="verified">Verificada pelo operador</option>
                      <option value="problem">Problema / pendência</option>
                      <option value="not_applicable">Não aplicável (justificar)</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Equipamento</span>
                    <select aria-label="Equipamento da etapa" [(ngModel)]="equipment">
                      <option value="unknown">Desconhecido / não confirmado</option>
                      <option value="confirmed">Confirmado pelo operador</option>
                    </select>
                  </label>
                </div>
                <label class="field"><span>Relato</span><textarea rows="2" aria-label="Relato da etapa" maxlength="500" [(ngModel)]="report"></textarea></label>
                <label class="field" [class.attention]="status === 'problem'"><span>Problema{{ status === 'problem' ? ' (descreva)' : ' (se houver)' }}</span><textarea rows="2" aria-label="Problema da etapa" maxlength="500" [(ngModel)]="problem"></textarea></label>
                <label class="field"><span>Observações / motivo</span><textarea rows="3" aria-label="Observações da etapa" maxlength="500" [(ngModel)]="observations"></textarea></label>
                <label class="field"><span>Verificações (uma por linha)</span><textarea rows="3" aria-label="Verificações da etapa" maxlength="2000" [(ngModel)]="checks"></textarea></label>
                <label class="check"><input type="checkbox" [(ngModel)]="confirmed" /><span>Confirmo humanamente este registro; não é validação física pelo aplicativo</span></label>
              </fieldset>
              <div class="actions">
                <button type="button" class="btn" [disabled]="index() === 0" (click)="step(-1)">Anterior</button>
                <button type="button" class="btn" [disabled]="index() >= plan().length - 1" (click)="step(1)">Próxima</button>
                <button type="button" class="btn primary push" [disabled]="busy() || !ready()" (click)="save()">Salvar etapa e avançar</button>
              </div>
              @if (currentRecord(); as record) {
                <p class="recorded">
                  Registro salvo: {{ record.recordedAt }} · {{ record.observed.source }} · revisão {{ record.observed.stateRevision }} ·
                  {{ record.observed.available ? 'estado LAB disponível' : 'estado indisponível' }} · leitura REAL: não coletada.
                </p>
              }
            </section>
          </div>

          <details class="card">
            <summary>Referência LAB e solicitações existentes</summary>
            <p>
              Referência: {{ event.reference ? 'versão ' + event.reference.version : 'ausente — não impede registro' }}. Cena MixAI E5 não é Snapshot nativo Soundcraft.
            </p>
            <div class="sub">
              <select aria-label="Referência da passagem" [(ngModel)]="referenceId">
                <option value="">Escolha referência do evento</option>
                @for (r of references(); track r.id) {
                  <option [value]="r.id">{{ r.scope }} v{{ r.version }}</option>
                }
              </select>
              <button type="button" class="btn" [disabled]="!referenceId && !event.reference" (click)="compare()">Comparar referência sem restaurar</button>
              <button type="button" class="btn" [disabled]="!ready() || busy() || !referenceId" (click)="action('link_reference', { referenceId })">Vincular referência</button>
            </div>
            <p>Para salvar uma referência, use o fluxo E5 abaixo ou a API existente com eventId={{ event.id }}. Nenhuma cena será carregada.</p>
            <label class="check"><input type="checkbox" [(ngModel)]="approveReference" /><span>Aprovo salvar uma cópia do estado LAB como referência (não física)</span></label>
            <div class="sub">
              <select aria-label="Destino da referência da passagem" [(ngModel)]="scope">
                <option value="PA">PA</option>
                <option value="AUX1">AUX1 compartilhado</option>
              </select>
              <button type="button" class="btn" [disabled]="!ready() || busy() || !approveReference || !live.state()?.available" (click)="capture()">Salvar referência LAB do evento</button>
            </div>
            <div class="sub">
              <select aria-label="Solicitação da passagem" [(ngModel)]="requestId">
                <option value="">Escolha pedido existente</option>
                @for (r of ui.data()?.requests || []; track r.id) {
                  <option [value]="r.id">{{ r.report }} · {{ r.state }}</option>
                }
              </select>
              <button type="button" class="btn" [disabled]="!ready() || busy() || !requestId" (click)="action('link_request', { requestId })">Vincular solicitação</button>
            </div>
            @for (r of requests(); track r.id) {
              <p>{{ r.report }} · {{ r.destination }} · {{ r.state }}</p>
            }
          </details>
          <details class="card history">
            <summary>Histórico do evento</summary>
            @for (h of event.history; track h.version) {
              <p>
                v{{ h.version }} · {{ h.at }} · {{ h.action }} · sessão {{ h.operatorSessionId.slice(0, 6) }}
                @if (h.step) {
                  · {{ h.step.human.stepId }} · {{ h.step.human.status }} · {{ h.step.human.observations }} · {{ h.step.human.problem }} ·
                  verificações declaradas: {{ h.step.human.checksPerformed.join('; ') }}
                }
              </p>
            }
          </details>
        }
      </section>
    }
  `,
})
export class SoundcheckComponent {
  readonly ui = inject(ReferenceUiService);
  readonly live = inject(LiveService);
  private session = inject(SessionService);
  readonly eligible = computed(
    () => this.live.hello()?.mode === 'lab' && this.live.hello()?.role === 'operator',
  );
  readonly events = signal<Event[]>([]);
  readonly selected = signal<Event | null>(null);
  readonly plan = signal<Plan[]>([]);
  readonly references = signal<{ id: string; version: number; scope: string }[]>([]);
  readonly requests = signal<{ id: string; report: string; destination: string; state: string }[]>(
    [],
  );
  readonly working = signal(false);
  /** Confirmação visível e falada da última gravação (a mensagem de erro continua em ui.error()). */
  readonly saved = signal('');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly progress = computed(() => progressOf(this.plan(), this.selected()?.steps));
  readonly progressSummary = computed(() => progressText(this.progress()));
  readonly index = computed(() => Math.max(0, this.plan().findIndex((p) => p.id === this.stepId_())));
  readonly current = computed((): Plan | undefined => this.plan()[this.index()]);
  /** Espelho de stepId para os computeds (stepId é campo simples ligado ao ngModel). */
  private readonly stepId_ = signal('session');
  readonly busy = computed(() => this.ui.busy() || this.working());
  private loadEpoch = 0;
  readonly ready = computed(
    () => this.selected()?.status === 'in_progress' && !this.selected()?.interrupted,
  );
  name = '';
  date = new Date().toLocaleDateString('en-CA');
  operatorName = '';
  private draftId = newId('soundcheck');
  stepId = 'session';
  status = 'pending';
  equipment = 'unknown';
  report = '';
  observations = '';
  problem = '';
  checks = '';
  confirmed = false;
  referenceId = '';
  requestId = '';
  approveReference = false;
  scope: 'PA' | 'AUX1' = 'PA';
  constructor() {
    afterNextRender(() => this.focus('#sc-screen-title'));
    effect(() => {
      this.session.token();
      this.live.hello()?.role;
      this.events.set([]);
      this.selected.set(null);
      this.plan.set([]);
      this.references.set([]);
      this.requests.set([]);
      this.clearForm();
      this.name = '';
      this.operatorName = '';
      this.draftId = newId('soundcheck');
      this.saved.set('');
    });
    // A tela é independente: carrega os eventos ao abrir (antes isso dependia de abrir um <details>).
    effect(() => {
      if (this.eligible() && this.session.token()) untracked(() => void this.refresh());
    });
  }
  private clearForm() {
    this.report = '';
    this.observations = '';
    this.problem = '';
    this.checks = '';
    this.confirmed = false;
    this.status = 'pending';
    this.equipment = 'unknown';
    this.referenceId = '';
    this.requestId = '';
    this.approveReference = false;
  }
  async refresh(reload = true) {
    const data = await this.ui.soundcheckRead('/api/soundchecks');
    if (data && Array.isArray(data.events) && Array.isArray(data.plan)) {
      this.events.set(data.events);
      this.plan.set(data.plan);
      if (reload && this.selected()) await this.load(this.selected()!.id);
    }
  }
  async load(id: string) {
    const epoch = ++this.loadEpoch;
    this.clearForm();
    if (!id) {
      this.selected.set(null);
      this.draftId = newId('soundcheck');
      return;
    }
    const detail = await this.ui.soundcheckRead('/api/soundchecks/' + encodeURIComponent(id));
    if (detail?.event && epoch === this.loadEpoch) {
      this.selected.set(detail.event);
      this.references.set(detail.references);
      this.requests.set(detail.requests);
      this.choose(detail.event.pendingSteps[0] || 'session');
    }
  }
  /** Escolha feita pelo operador (lista, seletor, Anterior/Próxima): limpa a confirmação e leva o foco ao título da etapa. */
  pick(id: string) {
    if (!this.plan().some((p) => p.id === id)) return;
    this.saved.set('');
    this.choose(id);
    this.focus('#sc-step-title');
  }
  step(delta: number) {
    const next = this.plan()[this.index() + delta];
    if (next) this.pick(next.id);
  }
  statusOf(id: string): StepStatus { return stepStatus(this.selected()?.steps, id); }
  statusLabel(id: string): string { return STATUS_LABEL[this.statusOf(id)]; }
  eventStatusLabel(event: Event): string {
    if (event.interrupted) return 'Interrompida';
    return ({ in_progress: 'Em andamento', paused: 'Pausada', completed: 'Concluída' } as Record<string, string>)[event.status] ?? event.status;
  }
  private focus(selector: string) {
    queueMicrotask(() => setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), 0));
  }
  choose(id: string) {
    this.stepId = id;
    this.stepId_.set(id);
    const r = this.selected()?.steps.find((s) => s.human.stepId === id)?.human;
    this.status = r?.status || 'pending';
    this.equipment = r?.equipment || 'unknown';
    this.report = r?.report || '';
    this.observations = r?.observations || '';
    this.problem = r?.problem || '';
    this.checks = r?.checksPerformed.join('\n') || '';
    this.confirmed = false;
  }
  currentRecord() {
    return this.selected()?.steps.find((s) => s.human.stepId === this.stepId);
  }
  async create() {
    if (this.busy()) return;
    this.working.set(true);
    try {
      const result = await this.ui.soundcheckWrite('/api/soundchecks', {
        id: this.draftId,
        name: this.name,
        date: this.date,
        operatorName: this.operatorName,
      });
      if (result) {
        await this.refresh(false);
        await this.load(result.id);
      }
    } finally {
      this.working.set(false);
    }
  }
  async action(action: string, fields: object = {}) {
    const event = this.selected();
    if (!event || this.busy()) return;
    this.working.set(true);
    try {
      const result = await this.ui.soundcheckWrite('/api/soundchecks/' + event.id, {
        expectedVersion: event.version,
        action,
        ...fields,
      });
      if (result) {
        await this.refresh(false);
        await this.load(result.id);
      }
      return result;
    } finally {
      this.working.set(false);
    }
  }
  async save() {
    const title = this.current()?.title ?? this.stepId;
    const result = await this.saveStep();
    if (result) {
      this.saved.set('Etapa "' + title + '" salva (revisão ' + (result as { version?: number }).version + ').');
      this.focus('#sc-step-title');
    }
  }
  private saveStep() {
    return this.action('step', {
      step: {
        stepId: this.stepId,
        status: this.status,
        equipment: this.equipment,
        checksPerformed: this.checks
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        humanConfirmed: this.confirmed,
        ...(this.report.trim() ? { report: this.report } : {}),
        ...(this.observations.trim() ? { observations: this.observations } : {}),
        ...(this.problem.trim() ? { problem: this.problem } : {}),
      },
    });
  }
  compare() {
    const id = this.referenceId || this.selected()?.reference?.id;
    if (id) {
      this.ui.open.set(true);
      void this.ui.compare(id);
    }
  }
  async capture() {
    const event = this.selected();
    if (!event) return;
    const expectedVersion = Math.max(
      0,
      ...this.references()
        .filter((r) => r.scope === this.scope)
        .map((r) => r.version),
    );
    const ref = await this.ui.capture({
      eventId: event.id,
      eventName: event.name,
      eventDate: event.date,
      scope: this.scope,
      expectedVersion,
      operatorApproved: this.approveReference,
    });
    if (ref) await this.action('link_reference', { referenceId: ref.id });
  }
}
