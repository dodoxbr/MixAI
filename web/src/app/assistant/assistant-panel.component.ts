import { LiveService } from '../core/live.service';
import { excerpt, safeReference } from './diagnostic-view';
import { MODE_LABEL } from '../knowledge/knowledge-view';
import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, inject, viewChild } from '@angular/core';
import { AssistantUiService, fmtReal, type CardState } from '../core/assistant.service';
import type { ProposalCard } from '../core/protocol';

const STATE_TEXT: Record<CardState, string> = {
  open: '',
  applying: 'Aplicando…',
  applied: 'Aplicado em LAB/MOCK (simulado)',
  awaiting: 'Aguardando aprovação',
  cancelled: 'Cancelado',
  stale: 'Valor mudou — veja a nova proposta',
  failed: 'Recusado ou falhou — veja o retorno',
  reported: 'Retorno recebido — confirmação final não disponível',
  sent: 'Enviado — confirmação física não disponível',
  uncertain: 'Resultado indeterminado — confira o estado',
  observed: 'Enviado — observação recebida da mesa (amostra independente, não é confirmação causal)',
  unconfirmed: 'Enviado, mas NÃO confirmado pela mesa — confira na mesa; nada foi repetido',
};

/**
 * Conversa curta do assistente: pedidos, propostas (Aplicar/Cancelar), perguntas com opções e
 * "Melhorou?". Recolhível, para não tomar o espaço dos faders.
 */
@Component({
  selector: 'mx-assistant-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: ['.assist-env{font-size:.75rem;border:1px solid var(--line);border-radius:999px;padding:2px 8px;margin-left:6px} .card-env{font-size:.75rem;font-weight:600;margin:2px 0} .guided-checks { border:1px solid var(--line); border-radius:var(--radius); padding:12px; margin:12px 0; } .guided-checks ol { padding-left:20px; } .guided-checks li { padding:8px 0; } .guided-checks p { margin:4px 0; } .guided-checks small {color:var(--muted);} .current-check {border-left:3px solid var(--brass);padding-left:8px!important;}'],
  host: { class: 'mx-assistant-panel', role: 'region', 'aria-label': 'Assistente' },
  template: `
    <header class="assist-head">
      <h2>Assistente</h2>
      <span class="assist-mode" [class.on]="assistant.aiOn()" [title]="assistant.aiOn() ? 'Pedidos que o modo local não entende vão para o Claude' : 'Comandos diretos e consulta técnica do operador, offline'">{{ assistant.aiOn() ? 'IA ligada' : 'sem IA' }}</span>
      <span class="assist-env" data-testid="assist-mode" [title]="live.hello()?.mode === 'real' ? 'Servidor REAL: o envio físico só ocorre depois da sua confirmação em cada cartão' : 'Laboratório: ajustes simulados, sem mesa física'">{{ live.hello()?.mode === 'real' ? 'REAL · envio só após confirmar' : 'LAB · simulado' }}</span>
      <span class="spacer"></span>
      @if (hasDiagnostics()) {
      <button type="button" class="btn btn-ghost btn-small history-back" aria-label="Voltar na conversa" (click)="back()" [disabled]="assistant.items().length < 2">Voltar</button>
      }
      <button type="button" class="btn btn-ghost btn-small" (click)="assistant.open.set(false)" aria-label="Recolher o assistente">Recolher</button>
    </header>
    @if (assistant.diagnosticContext(); as context) {
      <section class="diagnostic-context" aria-label="Diagnóstico pendente" role="status">
        <details><summary>{{ context.subject }}</summary><small>Contexto selecionado. Prazo máximo: 5 minutos; sem ajustes.</small></details>
        <button type="button" class="btn chip" [disabled]="!!assistant.blockedReason()" (click)="assistant.send('cancelar diagnóstico')">Cancelar diagnóstico</button>
      </section>
    }
    @if (assistant.blockedReason(); as reason) { <p class="chat-status" role="status">{{ reason }}</p> }
    <ol class="assist-log" aria-live="polite" aria-relevant="additions" [attr.aria-busy]="assistant.thinking()" aria-label="Histórico da conversa" #log>
      @for (item of assistant.items(); track item.id) {
        <li tabindex="-1" class="assist-item" [class.is-diagnostic]="item.diagnostic" [class.from-user]="item.from === 'user'" [class.tone-error]="item.tone === 'error'" [class.tone-ok]="item.tone === 'ok'">
          @if (item.presentation; as view) {
            <p class="diagnostic-safety">Não ouvi/medi o som. Nenhum ajuste aplicado por esta consulta.</p>
            @if (view.question && item.id === latestDiagnostic() && (!item.diagnosticContext || assistant.isCurrentContext(item.diagnosticContext))) { <p class="chat-question" tabindex="-1">{{ view.question }}</p> }
          @if (item.diagnosticOptions?.length) {
            <div class="diagnostic-options" aria-label="Esclarecer consulta técnica">
              @for (option of item.diagnosticOptions; track option.label) {
                <button type="button" class="btn chip" [disabled]="!!assistant.blockedReason() || item.id !== latestDiagnostic() || (!!item.diagnosticContext && !assistant.isCurrentContext(item.diagnosticContext))" (click)="assistant.consult(option, item.diagnosticContext)">{{ choiceLabel(option.label) }}</button>
              }
            </div>
          }
            <strong class="assist-src">Conhecimento técnico · somente leitura</strong>
            <h3 class="chat-title">{{ view.title }}</h3>
            <div class="chat-context" aria-label="Canal e destino da consulta"><span>{{ view.channel }}</span><span>{{ view.destination }}</span></div>
            @if (view.destination.toLowerCase().includes('fone') || view.destination.toLowerCase().includes('aux')) { <p class="shared-chat">AUX1 compartilhado — todos ouvem a mesma mix no HA800.</p> }
            @if (view.report) { <p class="chat-block report"><strong>Relato</strong> {{ short(view.report) }}</p> }
            @if (!view.question && view.hypothesis) { <p class="chat-block hypothesis"><strong>Hipótese · não confirmada</strong> {{ short(view.hypothesis) }}</p> }
            @if (!view.question && view.recommendation) { <p class="chat-block recommendation"><strong>Recomendação · revisão humana</strong> {{ short(view.recommendation) }}</p> }
            <p class="chat-block measurement"><strong>Medição indisponível</strong> {{ view.measurement }}</p>
            @if (item.diagnosticContext && item.id === latestDiagnostic() && !assistant.isCurrentContext(item.diagnosticContext)) { <p role="status">Contexto encerrado ou expirado. Descreva novamente o problema no chat.</p> }
            @if (view.checks?.length) {
              <section class="guided-checks" aria-label="Verificações guiadas">
                <h4>Verificações guiadas · sugestões técnicas</h4>
                <ol>
                  @for (check of view.checks; track check.id) {
                    <li [class.current-check]="check.current">
                      <p><strong>{{ check.current ? 'Verificação atual · ' : '' }}{{ check.instruction }}</strong></p>
                      <small>Sugestão técnica. Confirmação pela mesa: não disponível.</small>
                      @if (check.report) { <p>Retorno informado ao diagnóstico: {{ check.report }} — relato humano, não medição.</p> }
                    </li>
                  }
                </ol>
              </section>
            }
            @if (view.checkReports?.length) {
              <section aria-label="Relatos das verificações">
                <h4>Retornos informados</h4>
                <ul>@for (report of view.checkReports; track report.checkId) { <li>{{ report.title }}: {{ report.label }} — relato humano, não medição.</li> }</ul>
              </section>
            }
            <details class="technical-details">
              <summary>Ver detalhes técnicos e fontes</summary>
              <p class="assist-text technical-text">{{ view.fullText }}</p>
              <p>Dados estruturados recebidos — não são medições verificadas.</p>
              <pre class="structured-diagnostic">{{ view.structuredDetails }}</pre>
              @if (item.references?.length) {
                <ul class="technical-references" aria-label="Referências técnicas">
                  @for (ref of item.references; track ref.url + ref.locator) {
                    <li>@if (reference(ref.url); as href) { <a [href]="href" target="_blank" rel="noopener noreferrer">{{ ref.title }}</a> } @else { <span>{{ ref.title }} (link indisponível)</span> } — {{ ref.locator }}</li>
                  }
                </ul>
              }
              @if (item.knowledge; as kn) {
                <div class="knowledge-block" aria-label="Base de conhecimento local">
                  <p><strong>Base local</strong> · {{ modeLabel(kn.mode) }}@if (kn.reason) { — {{ kn.reason }} }</p>
                  @if (kn.microphone; as mic) { <p class="assist-text">{{ mic.channel }} {{ mic.musician }}: {{ mic.note }}</p> }
                  @if (kn.caseTitle) { <p class="assist-text">Roteiro teórico relacionado: {{ kn.caseTitle }} (sem execução).</p> }
                  @if (kn.narrative) { <p class="assist-text"><strong>{{ kn.narrativeSource === 'gemini' ? 'Resumo do Gemini (serviço externo)' : kn.narrativeSource === 'deepseek' ? 'Resumo da DeepSeek (serviço externo)' : kn.narrativeSource === 'anthropic' ? 'Resumo da Anthropic (serviço externo)' : kn.narrativeSource === 'openai' ? 'Resumo da OpenAI (serviço externo)' : 'Resumo do modelo local' }}{{ kn.narrativeModel && kn.narrativeSource && kn.narrativeSource !== 'ollama' ? ' (' + kn.narrativeModel + ')' : '' }} · não verificado, teoria a conferir:</strong> {{ kn.narrative }}</p> @if (kn.fallbackNote) { <p class="assist-text knowledge-note">{{ kn.fallbackNote }}</p> } } @else if (kn.narrativeNote) { <p class="assist-text knowledge-note">{{ kn.narrativeNote }}</p> }
                  @if (kn.modelNote) { <p class="assist-text knowledge-note">{{ kn.modelNote }}</p> }
                  @if (kn.passages.length) {
                    <ul class="technical-references" aria-label="Trechos da base">
                      @for (p of kn.passages; track p.locator + p.title + p.excerpt) {
                        <li>@if (reference(p.url); as href) { <a [href]="href" target="_blank" rel="noopener noreferrer">{{ p.title }}</a> } @else { <strong>{{ p.title }}</strong> } · {{ p.locator }} — {{ p.excerpt }}@if (p.caution) { <em class="knowledge-warning-inline"> ⚠ {{ p.caution }}</em> }</li>
                      }
                    </ul>
                  }
                </div>
              }
            </details>
          } @else if (item.text) {
            @if (item.code === 'REAL_READ_ONLY') { <strong class="assist-src" data-testid="real-blocked">Recurso REAL bloqueado</strong> }
            <p class="assist-text">@if (item.from === 'user') { <span class="assist-src">Seu relato/pedido</span> } @if (item.source === 'ai') { <span class="assist-src">IA</span> } {{ item.text }}</p>
          }
          @for (card of item.cards ?? []; track card.id) {
            <article class="proposal" [class.is-done]="assistant.state(card.id) !== 'open' && assistant.state(card.id) !== 'applying'">
              <h3>
                @if (card.source === 'ai') {
                  <span class="assist-src" title="Sugestão do Claude (IA)">IA</span>
                }
                {{ card.title }}
              </h3>
              @if (card.realControl) { <p class="card-env" data-testid="card-mode" title="Envio físico real depois da sua confirmação">REAL · {{ categoryLabel(card.realControl.category) }}</p> }
              @else if (live.hello()?.mode !== 'real') { <p class="card-env" data-testid="card-mode">LAB · simulado</p> }
              <dl>
                <dt>Canal</dt>
                <dd>{{ channelLabel(card.channel) }}</dd>
                <dt>Destino</dt>
                <dd><span class="dest" [class]="'dest dest-' + card.destination">{{ destinationLabel(card.destination) }}</span></dd>
                <dt>Atual na proposta</dt>
                <dd data-testid="card-current">{{ card.current }}</dd>
                @if (card.realControl && card.realControl.observed !== undefined && card.realControl.observed !== null) { <dt>Observado agora</dt><dd data-testid="card-observed">{{ observedLabel(card) }}</dd> }
                <dt>Mudança</dt>
                <dd>{{ card.change }}</dd>
                <dt>Proposto</dt>
                <dd class="proposal-result" data-testid="card-result">{{ card.result }}</dd>
              </dl>
              @if (card.reason) {
                <p class="proposal-reason">Motivo: {{ card.reason }}</p>
              }
              @if (card.needsApproval) {
                <p class="proposal-approval">Operação crítica: depois de confirmar o ajuste, precisa da aprovação do operador.</p>
              }
              @if (assistant.state(card.id) === 'open' || assistant.state(card.id) === 'applying') {
                <div class="card-actions">
                  <button type="button" class="btn btn-reject" data-testid="card-cancel" [disabled]="assistant.state(card.id) === 'applying'" (click)="assistant.cancel(card)">Cancelar</button>
                  <button type="button" class="btn btn-approve" data-testid="card-confirm" [disabled]="assistant.state(card.id) === 'applying'" (click)="assistant.apply(card)">
                    {{ assistant.state(card.id) === 'applying' ? 'Aguardando retorno…' : 'Confirmar ajuste' }}
                  </button>
                </div>
              } @else {
                <p class="proposal-state" data-testid="card-state">{{ stateText(assistant.state(card.id)) }}</p>
                @if (card.realControl && assistant.state(card.id) === 'observed' && card.destination !== 'DESFAZER') {
                  <button type="button" class="btn chip" data-testid="card-undo" [disabled]="!!assistant.blockedReason()" (click)="assistant.undo(card)">Desfazer (pede nova confirmação)</button>
                }
              }
            </article>
          }
          @if (item.options?.length) {
            <div class="assist-options">
              @for (o of item.options; track o.text) {
                <button type="button" class="btn chip" [disabled]="!!assistant.blockedReason()" (click)="assistant.send(o.text)">{{ o.label }}</button>
              }
            </div>
          }
          @if (item.feedbackFor) {
            <div class="assist-feedback">
              <span>Melhorou?</span>
              <button type="button" class="btn chip" (click)="assistant.feedback(item, true)">Sim</button>
              <button type="button" class="btn chip" (click)="assistant.feedback(item, false)">Não, voltar</button>
            </div>
          }
        </li>
      } @empty {
        <li class="assist-empty">Escreva um pedido ou descreva o problema. Exemplo: “Minha voz está abafada no retorno”. A consulta não aplica ajustes.</li>
      }
      @if (assistant.thinking()) {
        <li role="status" class="assist-item assist-thinking">Pensando… a mesa continua funcionando.</li>
      }
    </ol>
  `,
})
export class AssistantPanelComponent {
  readonly assistant = inject(AssistantUiService);
  readonly live = inject(LiveService);
  channelLabel(name: string) { const matches = this.live.channels().filter(c => c.name === name); return matches.length === 1 ? 'CH' + matches[0]!.number + ' — ' + name : name || 'Não disponível'; }
  categoryLabel(category: string) { return ({ pa_level: 'volume no PA', pa_mute: 'mute no PA', aux_level: 'volume no AUX', aux_mute: 'mute no AUX', processing: 'EQ/HPF do canal de entrada' } as Record<string, string>)[category] ?? category; }
  observedLabel(card: ProposalCard) { return card.realControl ? fmtReal(card.realControl, card.realControl.observed) : ''; }
  destinationLabel(dest: string) { if (dest === 'CANAL') return 'Canal de entrada (sem destino PA/AUX)'; return dest === 'FONES' ? 'FONES · AUX ' + (this.live.hello()?.musicianAux ?? 'não disponível') : dest || 'Não disponível'; }
  readonly hasDiagnostics = computed(() => this.assistant.items().some(item => item.diagnostic));
  readonly latestDiagnostic = computed(() => this.assistant.items().filter(item => item.from === 'assistant').at(-1)?.id);
  readonly short = excerpt;
  readonly reference = safeReference;
  readonly modeLabel = (mode: keyof typeof MODE_LABEL) => MODE_LABEL[mode];
  choiceLabel(label: string) { return label.replace(/^Voz (Fred|Lucius|Leandro|Fernando|Laviquinho)$/, '$1'); }
  back() {
    const elements = this.log()?.nativeElement.querySelectorAll<HTMLElement>('.assist-item');
    const target = elements?.[Math.max(0, elements.length - 2)];
    target?.scrollIntoView?.({ block: 'nearest' });
    target?.focus({ preventScroll: true });
  }
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');

  constructor() {
    // Sempre mostra a mensagem mais recente (cartão, pergunta ou "Melhorou?") — dentro da
    // conversa E na página: o painel pode estar abaixo dos faders (tela estreita) ou abaixo dos
    // cartões de aprovação. Sem isso a resposta chegava, mas ficava fora da área visível.
    let lastSeen = -1;
    afterRenderEffect(() => {
      const items = this.assistant.items();
      this.assistant.cardState();
      const thinking = this.assistant.thinking();
      const log = this.log()?.nativeElement;
      if (!log) return;
      const newest = items.at(-1)?.id ?? 0;
      const changed = newest !== lastSeen;
      lastSeen = newest;
      const reveal = () => {
        const target = log.lastElementChild as HTMLElement | null;
        if (!target) return;
        // Dentro da conversa: mostra o COMEÇO da mensagem nova se ela não couber inteira.
        const tall = target.offsetHeight > log.clientHeight;
        log.scrollTop = tall ? target.offsetTop : log.scrollHeight; // .assist-log é position: relative
        // Na página (painel abaixo dos faders ou das aprovações): traz a mensagem para a tela.
        if (changed || thinking) target.scrollIntoView?.({ block: tall ? 'start' : 'nearest', inline: 'nearest' });
      };
      if (changed && !thinking && document.activeElement?.closest('.diagnostic-options')) {
        log.querySelector<HTMLElement>('.assist-item:last-of-type .chat-question')?.focus({ preventScroll: true });
      }
      reveal();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
    });
  }
  stateText(s: CardState): string {
    return STATE_TEXT[s];
  }
}
