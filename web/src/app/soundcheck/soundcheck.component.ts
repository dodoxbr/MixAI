import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { ReferenceUiService } from '../reference/reference.service';
import { newId } from '../core/protocol';
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
/** Operator event workflow only. No chat, fader, mixer command or scene-load integration. */
@Component({
  selector: 'mx-soundcheck',
  imports: [FormsModule],
  styles: [
    `
      :host {
        display: block;
      }
      section {
        border: 1px solid #667682;
        border-radius: 8px;
        margin: 0.4rem;
        padding: 0.6rem;
        max-height: 55vh;
        overflow: auto;
      }
      label {
        display: block;
        margin: 0.4rem 0;
      }
      input,
      select,
      textarea {
        max-width: 100%;
        padding: 0.4rem;
      }
      button {
        min-height: 44px;
        margin: 0.2rem;
      }
      textarea {
        display: block;
        width: 95%;
      }
      .notice {
        font-size: 0.9rem;
      }
    `,
  ],
  template: ` @if (eligible()) {
    <details (toggle)="opened($event)">
      <summary>Passagem de som — assistente LAB</summary>
      <section aria-label="Assistente de passagem de som">
        <p class="notice">
          Somente registro: nenhuma alteração de fader/EQ/gain/phantom/mute/master/cena. AUX1 é
          compartilhado por todos no HA800. Simulação LAB e relato humano não validam acústica nem
          leitura REAL.
        </p>
        @if (ui.error()) {
          <p role="alert">{{ ui.error() }}</p>
        }
        <button type="button" [disabled]="busy()" (click)="refresh()">Atualizar eventos</button>
        <select
          [disabled]="busy()"
          aria-label="Evento da passagem"
          [ngModel]="selected()?.id || ''"
          (ngModelChange)="load($event)"
        >
          <option value="">Novo evento</option>
          @for (e of events(); track e.id) {
            <option [value]="e.id">
              {{ e.name }} · {{ e.date }} · {{ e.status }} · {{ e.pendingSteps.length }} pendências
            </option>
          }
        </select>
        @if (!selected()) {
          <label
            >Nome do evento<input
              aria-label="Nome do evento da passagem"
              maxlength="100"
              [(ngModel)]="name"
          /></label>
          <label>Data<input aria-label="Data da passagem" type="date" [(ngModel)]="date" /></label>
          <label
            >Operador (declarado)<input
              aria-label="Operador da passagem"
              maxlength="60"
              [(ngModel)]="operatorName"
          /></label>
          <button
            type="button"
            [disabled]="busy() || !name.trim() || !operatorName.trim() || !date"
            (click)="create()"
          >
            Iniciar passagem LAB
          </button>
        } @else {
          @if (selected(); as event) {
            <h3>{{ event.name }} — {{ event.date }} · v{{ event.version }} · {{ event.status }}</h3>
            <p>
              Operador declarado: {{ event.operatorName }}. Autorizações/auditoria usam a sessão
              autenticada.
            </p>
            @if (event.interrupted) {
              <p role="status">
                Passagem interrompida por reinício. Revise as pendências e retome explicitamente.
              </p>
            }
            <p>
              Pendências: {{ event.pendingSteps.length }} de {{ plan().length }}.
              @for (ch of event.channels; track ch.number) {
                <span>CH{{ ch.number }} {{ ch.name }}; </span>
              }
            </p>
            @if (event.status === 'paused' || event.interrupted) {
              <button type="button" [disabled]="busy()" (click)="action('resume')">
                Retomar passagem
              </button>
            }
            @if (ready()) {
              <button type="button" [disabled]="busy()" (click)="action('pause')">
                Pausar passagem
              </button>
              <button
                type="button"
                [disabled]="busy() || event.pendingSteps.length > 0"
                (click)="action('complete')"
              >
                Concluir registro aprovado
              </button>
            }
            <label
              >Etapa<select
                aria-label="Etapa da passagem"
                [ngModel]="stepId"
                (ngModelChange)="choose($event)"
              >
                @for (s of plan(); track s.id) {
                  <option [value]="s.id">{{ s.title }}</option>
                }
              </select></label
            >
            @for (s of plan(); track s.id) {
              @if (s.id === stepId) {
                <p>{{ s.instruction }}</p>
              }
            }
            <fieldset [disabled]="busy() || !ready()">
              <legend>Registro humano da etapa</legend>
              <label
                >Situação<select aria-label="Situação da etapa" [(ngModel)]="status">
                  <option value="pending">Pendente</option>
                  <option value="verified">Verificada pelo operador</option>
                  <option value="problem">Problema / pendência</option>
                  <option value="not_applicable">Não aplicável (justificar)</option>
                </select></label
              >
              <label
                >Equipamento<select aria-label="Equipamento da etapa" [(ngModel)]="equipment">
                  <option value="unknown">Desconhecido / não confirmado</option>
                  <option value="confirmed">Confirmado pelo operador</option>
                </select></label
              >
              <label
                >Relato<input aria-label="Relato da etapa" maxlength="500" [(ngModel)]="report"
              /></label>
              <label
                >Observações / motivo<textarea
                  aria-label="Observações da etapa"
                  maxlength="500"
                  [(ngModel)]="observations"
                ></textarea>
              </label>
              <label
                >Problema<input
                  aria-label="Problema da etapa"
                  maxlength="500"
                  [(ngModel)]="problem"
              /></label>
              <label
                >Verificações (uma por linha)<textarea
                  aria-label="Verificações da etapa"
                  maxlength="2000"
                  [(ngModel)]="checks"
                ></textarea>
              </label>
              <label
                ><input type="checkbox" [(ngModel)]="confirmed" />Confirmo humanamente este
                registro; não é validação física pelo aplicativo</label
              >
              <button type="button" (click)="save()">Salvar etapa e avançar</button>
            </fieldset>
            @if (currentRecord(); as record) {
              <p>
                Registro salvo: {{ record.recordedAt }} · {{ record.observed.source }} · revisão
                {{ record.observed.stateRevision }} ·
                {{ record.observed.available ? 'estado LAB disponível' : 'estado indisponível' }} ·
                leitura REAL: não coletada.
              </p>
            }
            <details>
              <summary>Referência LAB e solicitações existentes</summary>
              <p>
                Referência:
                {{
                  event.reference
                    ? 'versão ' + event.reference.version
                    : 'ausente — não impede registro'
                }}. Cena MixAI E5 não é Snapshot nativo Soundcraft.
              </p>
              <select aria-label="Referência da passagem" [(ngModel)]="referenceId">
                <option value="">Escolha referência do evento</option>
                @for (r of references(); track r.id) {
                  <option [value]="r.id">{{ r.scope }} v{{ r.version }}</option>
                }
              </select>
              <button
                type="button"
                [disabled]="!referenceId && !event.reference"
                (click)="compare()"
              >
                Comparar referência sem restaurar
              </button>
              <button
                type="button"
                [disabled]="!ready() || busy() || !referenceId"
                (click)="action('link_reference', { referenceId })"
              >
                Vincular referência
              </button>
              <p>
                Para salvar uma referência, use o fluxo E5 abaixo ou a API existente com eventId={{
                  event.id
                }}. Nenhuma cena será carregada.
              </p>
              <label
                ><input type="checkbox" [(ngModel)]="approveReference" />Aprovo salvar uma cópia do
                estado LAB como referência (não física)</label
              >
              <select aria-label="Destino da referência da passagem" [(ngModel)]="scope">
                <option value="PA">PA</option>
                <option value="AUX1">AUX1 compartilhado</option>
              </select>
              <button
                type="button"
                [disabled]="!ready() || busy() || !approveReference || !live.state()?.available"
                (click)="capture()"
              >
                Salvar referência LAB do evento
              </button>
              <select aria-label="Solicitação da passagem" [(ngModel)]="requestId">
                <option value="">Escolha pedido existente</option>
                @for (r of ui.data()?.requests || []; track r.id) {
                  <option [value]="r.id">{{ r.report }} · {{ r.state }}</option>
                }
              </select>
              <button
                type="button"
                [disabled]="!ready() || busy() || !requestId"
                (click)="action('link_request', { requestId })"
              >
                Vincular solicitação
              </button>
              @for (r of requests(); track r.id) {
                <p>{{ r.report }} · {{ r.destination }} · {{ r.state }}</p>
              }
            </details>
            <details>
              <summary>Histórico do evento</summary>
              @for (h of event.history; track h.version) {
                <p>
                  v{{ h.version }} · {{ h.at }} · {{ h.action }} · sessão
                  {{ h.operatorSessionId.slice(0, 6) }}
                  @if (h.step) {
                    · {{ h.step.human.stepId }} · {{ h.step.human.status }} ·
                    {{ h.step.human.observations }} · {{ h.step.human.problem }} · verificações
                    declaradas: {{ h.step.human.checksPerformed.join('; ') }}
                  }
                </p>
              }
            </details>
          }
        }
      </section>
    </details>
  }`,
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
  async opened(event: Event | globalThis.Event) {
    if (
      (event as globalThis.Event).target instanceof HTMLDetailsElement &&
      ((event as globalThis.Event).target as HTMLDetailsElement).open
    )
      await this.refresh();
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
  choose(id: string) {
    this.stepId = id;
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
  save() {
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
