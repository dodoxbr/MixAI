import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AutoConfigService } from './autoconfig.service';
import type { AutoContext, AutoReference } from './autoconfig-contract';
@Component({
  selector: 'mx-autoconfig',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        margin: 16px auto;
        max-width: 1180px;
        padding: 0 16px;
      }
      * {
        box-sizing: border-box;
      }
      .auto {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        padding: 18px;
        display: grid;
        gap: 16px;
        min-width: 0;
      }
      .banner {
        position: sticky;
        top: 0;
        z-index: 2;
        background: var(--panel);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 12px;
      }
      .badge {
        border: 1px solid #d7ac52;
        background: #493810;
        color: #ffe3a0;
        border-radius: 30px;
        padding: 8px 12px;
        font-weight: 800;
      }
      h2,
      h3,
      p {
        margin: 0;
      }
      p,
      li {
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .muted {
        color: var(--muted);
      }
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .actions > * {
        flex: 1 1 160px;
      }
      button {
        min-height: 48px;
        padding: 10px 16px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--panel-2);
        color: var(--text);
        font: inherit;
        cursor: pointer;
        text-align: center;
      }
      button.primary {
        background: var(--brass);
        color: #171309;
        font-weight: 700;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      :is(button, input, textarea, select, summary):focus-visible {
        outline: 3px solid var(--brass-hi);
        outline-offset: 3px;
      }
      label {
        display: grid;
        gap: 8px;
        font-weight: 600;
      }
      input,
      textarea,
      select {
        min-width: 0;
        width: 100%;
        min-height: 48px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: var(--bg);
        color: var(--text);
        font: inherit;
      }
      textarea {
        resize: vertical;
      }
      .question,
      .item {
        display: grid;
        gap: 14px;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 12px;
        min-width: 0;
      }
      .source {
        border-left: 4px solid #7da8ee;
        padding: 10px 12px;
        background: var(--panel-2);
      }
      .suggestion {
        border-left-color: #c59ce5;
      }
      .result {
        border-left-color: #d7ac52;
      }
      .human {
        border-left-color: #82c5a1;
      }
      .diff {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .diff > div {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
      }
      .alert {
        padding: 12px;
        border: 1px solid var(--mute);
        border-radius: 8px;
        background: #3b1d20;
        color: #ffd7d9;
      }
      summary {
        cursor: pointer;
        min-height: 48px;
        padding: 12px 0;
        font-weight: 700;
      }
      details p {
        margin-bottom: 10px;
      }
      a {
        color: var(--brass-hi);
      }
      .context {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .context span {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 6px 10px;
      }
      h3[tabindex] {
        scroll-margin-top: 160px;
      }
      h3[tabindex]:focus {
        outline: 2px solid var(--brass-hi);
        outline-offset: 4px;
      }
      @media (max-width: 600px) {
        :host {
          padding: 0 10px;
        }
        .auto {
          padding: 12px;
        }
        .item,
        .question {
          padding: 12px;
        }
        .diff {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  template: `
    @if (ui.eligible() && event()) {
      <section class="auto" aria-labelledby="autoconfig-title" [attr.aria-busy]="ui.busy()">
        <header class="banner">
          <span class="badge">SIMULAÇÃO LAB</span>
          <h2 id="autoconfig-title">MixAI AutoConfig</h2>
          <span role="status">{{
            ui.connected() ? 'Sessão conectada' : 'Sem conexão — ações bloqueadas'
          }}</span>
        </header>
        <p class="muted">
          Não ouvimos nem medimos áudio. Nenhuma operação na Soundcraft. AUX1 é a mix compartilhada
          do HA800.
        </p>
        <p class="source">
          <strong>Núcleo virtual do servidor.</strong> Aprovações, testes e referências são
          validados e registrados pelo servidor. O planejador C ainda não está conectado; você
          define o passo virtual, sem sugestão acústica automática.
        </p>
        <div class="actions">
          <button
            type="button"
            [disabled]="!ui.eligible() || !ui.connected() || ui.busy()"
            (click)="ui.refresh()"
          >
            Consultar servidor
          </button>
          <label
            >Planos salvos no servidor<select
              aria-label="Plano AutoConfig do servidor"
              [disabled]="ui.busy() || !ui.connected()"
              (change)="ui.refresh($any($event.target).value)"
            >
              <option value="">Selecione um plano</option>
              @for (p of ui.availablePlans(); track p.id) {
                <option [value]="p.id">{{ p.title }} · v{{ p.version }} · {{ p.state }}</option>
              }
            </select></label
          >
        </div>
        @if (ui.model(); as model) {
          @if (['saved', 'rejected', 'expired'].includes(model.state)) {
            <button type="button" [disabled]="!ui.canAct() || ui.busy()" (click)="ui.start()">
              Iniciar novo plano LAB
            </button>
          }
          <p role="status">
            Plano v{{ model.version }} · {{ model.state }} · expira {{ model.expiresAt }}
          </p>
          @if (model.stale || model.interrupted || ui.needsRefresh() || ui.requiresPreparation()) {
            <p class="alert">
              Contexto desatualizado ou resposta pendente. Consulte o servidor; nenhuma operação
              será repetida.
            </p>
          }
          <button
            type="button"
            [disabled]="
              !ui.canAct() || ui.busy() || ['saved', 'rejected', 'expired'].includes(model.state)
            "
            (click)="ui.reprepare()"
          >
            Preparar contexto no servidor (descarta aprovações)
          </button>
          @for (item of model.items; track item.spec.id) {
            @for (q of item.questions; track q.id) {
              <p class="alert">Pergunta do servidor: {{ q.message }}</p>
            }
          }
        }
        <div class="context" aria-label="Contexto AutoConfig">
          <span>Evento: {{ event()!.eventName }} · v{{ event()!.eventVersion }}</span>
          @if (ui.answers().channel) {
            <span>CH{{ ui.answers().channel }} · {{ channelName() }}</span
            ><span>{{
              ui.answers().destination === 'AUX1' ? 'FONES · AUX1 compartilhado' : 'PA'
            }}</span>
          }
        </div>
        <details>
          <summary>Estado disponível e incertezas</summary>
          <p>
            Origem: servidor LAB. Revisão {{ ui.stateRevision() ?? 'indisponível' }};
            {{ ui.live.channels().length }} canais cadastrados. Cadastro não comprova conexões
            físicas.
          </p>
          <p>
            Áudio, espectro, SPL, frequências e resultado acústico: não coletados. Valores virtuais
            não comprovam o estado físico ou o som.
          </p>
        </details>
        @if (ui.error()) {
          <p class="alert" role="alert">{{ ui.error() }}</p>
        }
        @if (ui.busy()) {
          <p role="status">Processando SIMULAÇÃO LAB… Nenhuma ação física.</p>
        }
        @switch (ui.stage()) {
          @case ('idle') {
            <p>Escolha um objetivo, revise as diferenças e autorize cada teste separadamente.</p>
            <button type="button" class="primary" [disabled]="!ui.canAct()" (click)="ui.start()">
              Iniciar AutoConfig LAB
            </button>
          }
          @case ('cancelled') {
            <p role="status">Configuração cancelada. Nenhuma operação foi enviada à mesa.</p>
            <button type="button" [disabled]="!ui.canAct()" (click)="ui.start()">
              Iniciar nova configuração LAB
            </button>
          }
          @case ('questions') {
            <section class="question" aria-labelledby="auto-question">
              <p class="muted">Pergunta {{ ui.question() + 1 }} de 4</p>
              @switch (ui.question()) {
                @case (0) {
                  <h3 id="auto-question" tabindex="-1">Qual é o objetivo?</h3>
                  <div class="actions">
                    @for (goal of goals; track goal) {
                      <button type="button" [disabled]="!ui.canAct()" (click)="ui.answer(goal)">
                        {{ goal }}
                      </button>
                    }
                  </div>
                }
                @case (1) {
                  <h3 id="auto-question" tabindex="-1">Qual canal vamos revisar?</h3>
                  <label
                    >Canal<select
                      aria-label="Canal do AutoConfig"
                      [ngModel]="channel"
                      (ngModelChange)="channel = $event"
                      [disabled]="!ui.canAct()"
                    >
                      <option value="">Selecione um canal</option>
                      @for (c of ui.live.channels(); track c.number) {
                        <option [value]="c.number">CH{{ c.number }} · {{ c.name }}</option>
                      }
                    </select></label
                  >
                  <button
                    type="button"
                    class="primary"
                    [disabled]="!ui.canAct() || !channel"
                    (click)="ui.answer(channel)"
                  >
                    Confirmar canal
                  </button>
                }
                @case (2) {
                  <h3 id="auto-question" tabindex="-1">O objetivo é no PA ou nos fones?</h3>
                  <div class="actions">
                    <button type="button" [disabled]="!ui.canAct()" (click)="ui.answer('PA')">
                      PA</button
                    ><button type="button" [disabled]="!ui.canAct()" (click)="ui.answer('AUX1')">
                      FONES · AUX1 compartilhado
                    </button>
                  </div>
                }
                @case (3) {
                  <h3 id="auto-question" tabindex="-1">O que você percebeu?</h3>
                  <label
                    >Relato humano, não medição<textarea
                      aria-label="Relato do AutoConfig"
                      rows="3"
                      maxlength="500"
                      [(ngModel)]="report"
                      [disabled]="!ui.canAct() || ui.busy()"
                      placeholder="Ex.: a voz parece abafada no retorno"
                    ></textarea>
                  </label>
                  <label
                    >Passo virtual definido por você (dB, entre −3 e +3; sem zero)<input
                      aria-label="Passo virtual em dB"
                      type="number"
                      min="-3"
                      max="3"
                      step="0.5"
                      [(ngModel)]="delta"
                      [disabled]="!ui.canAct() || ui.busy()"
                  /></label>
                  <button
                    type="button"
                    class="primary"
                    [disabled]="
                      !ui.canAct() ||
                      ui.busy() ||
                      !report.trim() ||
                      !delta ||
                      delta > 3 ||
                      delta < -3
                    "
                    (click)="ui.prepare(report, delta)"
                  >
                    Visualizar plano LAB
                  </button>
                }
              }
              <button
                type="button"
                [disabled]="!ui.canAct() || ui.busy() || ui.question() === 0"
                (click)="ui.back()"
              >
                Voltar à pergunta anterior
              </button>
            </section>
          }
          @case ('plan') {
            <h3 id="auto-plan" tabindex="-1">Revise cada teste</h3>
            <p class="source"><strong>Relato humano:</strong> {{ ui.answers().report }}</p>
            <p class="source">
              <strong>Observação disponível:</strong> revisão de estado LAB
              {{ ui.stateRevision() ?? 'indisponível' }}. Não é medição acústica nem leitura REAL.
              Objetivo relatado: {{ ui.answers().goal }}.
            </p>
            @for (item of ui.plan()!.items; track item.id) {
              <article class="item" [attr.aria-label]="item.title">
                <h3>{{ item.title }}</h3>
                @if (ui.model()!.items[$index].questions.length) {
                  <label
                    >Canal confirmado<select
                      [attr.aria-label]="'Canal da resposta ' + item.id"
                      [ngModel]="questionChannels[item.id] ?? ''"
                      (ngModelChange)="questionChannels[item.id] = $event"
                      [disabled]="!ui.canAct() || ui.busy()"
                    >
                      <option value="">Escolha o canal</option>
                      @for (c of ui.live.channels(); track c.number) {
                        <option [value]="c.number">CH{{ c.number }} · {{ c.name }}</option>
                      }
                    </select></label
                  >
                  <label
                    >Passo virtual confirmado (dB)<input
                      type="number"
                      min="-3"
                      max="3"
                      step="0.5"
                      [attr.aria-label]="'Passo da resposta ' + item.id"
                      [ngModel]="questionDeltas[item.id] ?? 0"
                      (ngModelChange)="questionDeltas[item.id] = $event"
                      [disabled]="!ui.canAct() || ui.busy()"
                  /></label>
                  <button
                    type="button"
                    [disabled]="
                      !ui.canAct() ||
                      ui.busy() ||
                      !questionChannels[item.id] ||
                      !questionDeltas[item.id]
                    "
                    (click)="
                      ui.revise(item.id, +questionChannels[item.id]!, questionDeltas[item.id]!)
                    "
                  >
                    Enviar respostas ao servidor
                  </button>
                  <p>
                    Após revisar canal/passo, prepare novamente. Observação e conectividade
                    continuam sendo verificadas pelo servidor.
                  </p>
                }

                <p>
                  CH{{ item.channel }} ·
                  {{ item.destination === 'AUX1' ? 'FONES · AUX1 compartilhado' : 'PA' }} · somente
                  passo virtual
                </p>
                <p class="source suggestion">
                  <strong>Sugestão definida pelo operador:</strong>
                  {{ item.rationale }}
                </p>
                <div class="diff">
                  <div>
                    <strong>Antes (cenário)</strong>
                    <p>{{ item.before }}</p>
                  </div>
                  <div>
                    <strong>Diferença proposta</strong>
                    <p>{{ item.after }}</p>
                  </div>
                </div>
                <details>
                  <summary>Evidências, limites e referências</summary>
                  <p>{{ item.evidence }}</p>
                  <strong>Pré-condições</strong>
                  <ul>
                    @for (p of item.preconditions; track $index) {
                      <li>{{ p }}</li>
                    }
                  </ul>
                  <strong>Limitações</strong>
                  <ul>
                    @for (p of item.limitations; track $index) {
                      <li>{{ p }}</li>
                    }
                  </ul>
                  <p>Validação: {{ item.validation }}</p>
                  <p>Retorno: {{ item.rollback }}</p>
                  @for (r of item.references; track $index) {
                    <p>
                      <a [href]="r.url" target="_blank" rel="noopener noreferrer">{{ r.title }}</a>
                    </p>
                  }
                </details>
                <p class="human source" role="status">
                  Estado confirmado pelo servidor: {{ labels[ui.status()[item.id]!] }}
                </p>
                @if (ui.status()[item.id] === 'proposed') {
                  <button
                    type="button"
                    class="primary"
                    [disabled]="!ui.canAct() || ui.busy() || !ui.mutable()"
                    (click)="ui.approve(item.id)"
                  >
                    Solicitar autorização deste teste LAB
                  </button>
                }
                @if (ui.status()[item.id] === 'approved') {
                  <p>Autorização confirmada pelo servidor para este item. Nenhum teste em lote.</p>
                  <button
                    type="button"
                    class="primary"
                    [disabled]="!ui.canAct() || ui.busy() || !ui.mutable()"
                    (click)="ui.simulate(item.id)"
                  >
                    Executar este teste simulado
                  </button>
                }
                @if (ui.status()[item.id] === 'accepted' || ui.status()[item.id] === 'simulated') {
                  <button
                    type="button"
                    [disabled]="!ui.canAct() || ui.busy() || !ui.mutable()"
                    (click)="ui.undo(item.id)"
                  >
                    Desfazer somente cenário virtual
                  </button>
                }
                @if (ui.results()[item.id]; as result) {
                  <div class="source result">
                    <strong>Resultado SIMULADO — acústica não validada</strong>
                    <p>{{ result.before }} → {{ result.after }}</p>
                    <p>{{ result.verification }}</p>
                  </div>
                  @if (ui.status()[item.id] === 'simulated') {
                    <button
                      type="button"
                      [disabled]="!ui.canAct() || ui.busy() || !ui.mutable()"
                      (click)="ui.decide(item.id, true)"
                    >
                      Confirmar resultado simulado
                    </button>
                  }
                }
                @if (ui.status()[item.id] === 'simulated') {
                  <button
                    type="button"
                    [disabled]="!ui.canAct() || ui.busy() || !ui.mutable()"
                    (click)="ui.decide(item.id, false)"
                  >
                    Rejeitar e descartar cenário
                  </button>
                }
              </article>
            }
            <p>
              Salvar registra somente itens confirmados. Rejeições não alteram o estado LAB da mix.
              A aprovação da IA nunca substitui sua decisão.
            </p>
            <button
              type="button"
              class="primary"
              [disabled]="!ui.canAct() || ui.busy() || !ui.canSave()"
              (click)="ui.save()"
            >
              Salvar referência virtual no servidor
            </button>
          }
        }
        @if (ui.stage() === 'questions' || ui.stage() === 'plan') {
          <button
            type="button"
            [disabled]="
              !ui.canAct() ||
              ui.busy() ||
              (ui.model() && ['saved', 'rejected', 'expired'].includes(ui.model()!.state))
            "
            (click)="confirmCancel = true"
          >
            Cancelar AutoConfig
          </button>
        }
        @if (confirmCancel) {
          <div class="alert" role="group" aria-label="Confirmar cancelamento">
            <p>Descartar este plano e suas aprovações?</p>
            <div class="actions">
              <button type="button" (click)="ui.cancel(); confirmCancel = false">
                Sim, cancelar configuração</button
              ><button type="button" (click)="confirmCancel = false">Continuar revisão</button>
            </div>
          </div>
        }
        @if (ui.references().length) {
          <details open>
            <summary>Referências persistidas ({{ ui.references().length }})</summary>
            @for (r of ui.references(); track r.version) {
              <p role="status">
                Referência v{{ r.version }} · ID {{ r.id }} · SIMULAÇÃO LAB · persistida no servidor
                · UNVERIFIED · não aplicada.
              </p>
              <button type="button" (click)="download(r)">
                Baixar referência simulada v{{ r.version }}
              </button>
            }
            <p>
              Estes recibos são de referências virtuais não aplicadas. Não são snapshots físicos e
              não podem ser restaurados por este painel.
            </p>
          </details>
        }
        @if (ui.history().length) {
          <details>
            <summary>Histórico desta configuração</summary>
            <ol>
              @for (h of ui.history(); track $index) {
                <li>{{ h }}</li>
              }
            </ol>
          </details>
        }
      </section>
    }
  `,
})
export class AutoConfigComponent {
  readonly event = input<AutoContext | null>(null);
  readonly ui = inject(AutoConfigService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly goals = ['Melhorar clareza', 'Equilibrar instrumentos', 'Revisar retorno compartilhado'];
  readonly labels = {
    proposed: 'Não autorizado',
    approved: 'Autorizado para um teste LAB',
    simulated: 'Aguardando revisão humana',
    accepted: 'Confirmado como cenário simulado',
    rejected: 'Rejeitado / descartado',
    blocked: 'Servidor exige contexto ou nova preparação',
    saved: 'Referência salva pelo servidor',
  };
  questionChannels: Record<string, string> = {};
  questionDeltas: Record<string, number> = {};
  delta = 0;
  channel = '';
  report = '';
  confirmCancel = false;
  constructor() {
    effect(() => {
      const context = this.event();
      this.ui.eligible();
      untracked(() => {
        this.ui.bind(this.ui.eligible() ? context : null);
      });
    });
    effect(() => {
      if (
        this.ui.stage() === 'idle' ||
        (this.ui.stage() === 'questions' && this.ui.question() === 0 && !this.ui.answers().goal)
      ) {
        this.questionChannels = {};
        this.questionDeltas = {};
        this.delta = 0;
        this.channel = '';
        this.report = '';
        this.confirmCancel = false;
      }
    });
    afterRenderEffect(() => {
      const stage = this.ui.stage();
      this.ui.question();
      if (stage === 'questions' || stage === 'plan')
        this.host.nativeElement.querySelector<HTMLElement>('#auto-question, #auto-plan')?.focus();
    });
  }
  download(reference: AutoReference) {
    if (!this.ui.eligible() || !this.ui.references().includes(reference)) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(reference, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `mixai-simulacao-lab-v${reference.version}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  channelName() {
    return (
      this.ui.live.channels().find((c) => c.number === this.ui.answers().channel)?.name ?? 'Canal'
    );
  }
}
