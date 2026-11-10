import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, ViewChild, computed, inject, output } from '@angular/core';
import { LegacyProviderSettings } from './legacy-provider-settings';
import { PROVIDERS, PROVIDER_LABELS, PROVIDER_SETTINGS_PORT, type BackendAmount, trustedAmount } from './provider-settings-port';
import { ProviderSettingsService } from './provider-settings.service';

@Component({
  selector: 'mx-ai-provider-settings',
  providers: [ProviderSettingsService, { provide: PROVIDER_SETTINGS_PORT, useExisting: LegacyProviderSettings }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="ai-settings-title" (cancel)="$event.preventDefault(); closed.emit()">
      <header>
        <div><p class="eyebrow">Configurações</p><h2 id="ai-settings-title">Inteligência Artificial</h2></div>
        <button autofocus type="button" class="btn btn-ghost" (click)="closed.emit()" aria-label="Fechar configurações de IA">Fechar</button>
      </header>
      <p class="muted">Escolha como gerar os resumos da base técnica. Esta configuração não executa comandos na mesa.</p>
      <section class="active" aria-label="Seleção ativa no servidor">
        <span class="eyebrow">Ativo no servidor</span>
        @if (s.snapshot(); as pv) {
          <strong>{{ names[pv.active.provider] }} <span class="muted">· {{ pv.active.model ?? 'Modelo não informado pela API' }}</span></strong>
          <p>{{ pv.narrative ? 'Resumo habilitado' : 'Resumo desligado na configuração do servidor' }}</p>
          @if (pv.active.provider !== 'ollama') { <p class="muted">Provedor selecionado no servidor. A API atual não informa se esta sessão tem autorização de envio externo.</p> }
        } @else { <p>{{ s.busy() ? 'Consultando seleção ativa…' : 'Seleção ativa não disponível' }}</p> }
      </section>
      <div aria-live="polite" aria-atomic="true">
        @if (s.busy()) { <p role="status">{{ s.slow() ? 'Resposta lenta. Aguardando confirmação do servidor…' : 'Consultando o servidor…' }}</p> }
        @if (s.notice()) { <p role="status" class="success">{{ s.notice() }}</p> }
      </div>
      @if (s.error()) { <p role="alert" class="warning">{{ s.error() }}</p> }
      @if (!s.allowed()) { <p role="alert" class="warning">Conecte-se com uma sessão de operador para configurar os provedores.</p> }
      <form (submit)="$event.preventDefault(); s.save()" [attr.aria-busy]="s.busy()">
        <fieldset [disabled]="s.busy() || !s.allowed() || !s.snapshot()">
          <legend>Provedor de IA</legend>
          <div class="providers">
            @for (id of ids; track id) {
              <label class="provider" [class.chosen]="s.selected() === id">
                <input type="radio" name="ai-provider" [value]="id" [checked]="s.selected() === id" (change)="s.choose(id)" />
                <span><strong>{{ names[id] }}</strong><small>{{ id === 'ollama' ? 'Local no servidor MixAI' : 'Serviço externo' }}</small></span>
                <span class="state">{{ status(id) }}</span>
              </label>
            }
          </div>
        </fieldset>
        @if (s.option(); as o) {
          <section class="details" aria-label="Configuração do provedor selecionado">
            <h3>{{ names[o.id] }}</h3>
            @if (o.status === 'not_configured') { <p class="warning">Não configurado. Falta configurar a chave ou o serviço no servidor. Este painel não recebe credenciais.</p> }
            @if (!o.selectable && o.status !== 'not_configured') { <p class="warning">Provedor indisponível nesta versão ou configuração do backend.</p> }
            @if (o.modelMode === 'list') {
              <label for="ai-model-list">Modelo do provedor</label>
              <select id="ai-model-list" [value]="s.model()" (change)="s.chooseModel($any($event.target).value)" [disabled]="s.busy() || !o.selectable || !s.allowed()">
                @if (!o.models.includes(s.model())) { <option [value]="s.model()">{{ s.model() || 'Selecione um modelo' }} — indisponível na lista</option> }
                @for (model of o.models; track model) { <option [value]="model">{{ model }}</option> }
              </select>
              <p class="muted">Modelos oferecidos pelo servidor; a lista não garante disponibilidade na conta.</p>
            } @else {
              <label for="ai-model-id">ID do modelo</label>
              <input id="ai-model-id" type="text" autocomplete="off" spellcheck="false" maxlength="160" [value]="s.model()" (input)="s.chooseModel($any($event.target).value)" [readOnly]="o.modelMode === 'server_only'" [disabled]="s.busy() || !s.allowed() || !o.selectable" aria-describedby="ai-model-help" />
              <p id="ai-model-help" class="muted">{{ o.modelMode === 'manual' ? 'Informe o ID exato. O servidor valida a disponibilidade antes de confirmar.' : 'Listagem e edição manual não disponíveis nesta API. Será mantido o modelo configurado no servidor.' }}</p>
            }
            @if (!s.validModel()) { <p role="alert" class="warning">Modelo indisponível ou ID inválido. Escolha um modelo oferecido ou um ID aceito pelo servidor.</p> }
            <section class="costs" aria-label="Custos e limites">
              <h4>Custos e limites</h4>
              @if (budget(); as v) { <p>Limite de gasto informado: {{ money(v) }} <small>· {{ v.asOf }}</small></p> } @else { <p>Limite de gasto: não disponível.</p> }
              @if (consumed(); as v) { <p>Consumo informado: {{ money(v) }} <small>· {{ v.asOf }}</small></p> } @else { <p>Consumo: não disponível.</p> }
              @if (price(); as p) {
                <p>{{ p.model }} · por milhão de tokens: entrada {{ money(p.inputPerMillion) }} / saída {{ money(p.outputPerMillion) }}.</p>
                <small>Informado pelo servidor: entrada {{ p.inputPerMillion.asOf }}; saída {{ p.outputPerMillion.asOf }}. Não substitui o faturamento do provedor.</small>
              } @else { <p class="muted">{{ o.external ? 'Custo desconhecido: preço deste modelo não informado pelo backend.' : 'Preço por modelo não informado. O processamento local utiliza recursos do servidor.' }}</p> }
              @if (o.external && (!budget() || !consumed())) { <p class="muted">A ausência de valores nesta tela não significa uso gratuito ou ilimitado.</p> }
            </section>
            @if (o.external) {
              <div class="privacy" id="ai-privacy-note">
                <h4>Envio de dados a serviço externo</h4>
                <p>Com {{ names[o.id] }}, trechos de manuais públicos e a sua pergunta, com dados sensíveis removidos pelo servidor, saem do computador para esse provedor. Documentos locais não são enviados pelo fluxo atual de resumo.</p>
                @if (s.snapshot()?.sessionConsent === 'legacy_gemini' && o.id === 'gemini') {
                  <p class="warning">Limitação atual: o resumo do Gemini mantém a seleção confirmada entre sessões. Esta tela exige confirmação a cada abertura, mas não altera essa política do backend. O alinhamento por sessão depende da integração do servidor.</p>
                }
                <p>O aceite não é armazenado no navegador. Trocar de provedor ou modelo exige nova confirmação. Fechar esta tela não revoga um aceite já recebido pelo servidor.</p>
                @if (s.snapshot()?.fallback === 'ollama') { <p>Em falha de disponibilidade, a reserva é o Ollama local; nunca outro serviço externo.</p> }
                @if (s.snapshot()?.fallback === 'none') { <p>Reserva local desativada pelo servidor.</p> }
              </div>
              <label class="consent"><input type="checkbox" [checked]="s.consent()" (change)="s.consent.set($any($event.target).checked)" [disabled]="s.busy() || !s.allowed() || !o.selectable" aria-describedby="ai-privacy-note" /> Confirmo o envio externo para {{ names[o.id] }} nesta sessão.</label>
            } @else { <p class="local-note">Ollama processa no servidor MixAI. Selecioná-lo não autoriza outro provedor externo.</p> }
          </section>
        }
        <footer>
          <button type="button" class="btn btn-ghost" [disabled]="s.busy() || !s.allowed()" (click)="s.refresh()">Atualizar estado</button>
          @if (s.busy()) { <button type="button" class="btn" (click)="s.cancel()">Cancelar espera</button> }
          <button type="submit" class="btn btn-primary" [disabled]="!s.canSave()">Aplicar seleção</button>
        </footer>
      </form>
    </dialog>
  `,
  styleUrl: './provider-settings.component.css',
})
export class ProviderSettingsComponent implements AfterViewInit, OnDestroy {
  readonly s = inject(ProviderSettingsService);
  readonly ids = PROVIDERS;
  readonly names = PROVIDER_LABELS;
  readonly closed = output<void>();
  @ViewChild('dialog', { static: true }) private dialog!: ElementRef<HTMLDialogElement>;
  private previousFocus: HTMLElement | null = null;
  readonly budget = computed(() => trustedAmount(this.s.snapshot()?.budget ?? null));
  readonly consumed = computed(() => trustedAmount(this.s.snapshot()?.consumed ?? null));
  readonly price = computed(() => {
    const p = this.s.option()?.price;
    return p && p.model === this.s.model() && trustedAmount(p.inputPerMillion) && trustedAmount(p.outputPerMillion) ? p : null;
  });
  money(v: BackendAmount) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: v.currency, maximumFractionDigits: 6 }).format(v.value); }
  status(id: string) {
    const state = this.s.snapshot()?.options.find(o => o.id === id)?.status;
    return state ? { configured: 'Configurado', not_configured: 'Não configurado', unavailable: 'Indisponível', connected: 'Conectado' }[state] : 'Estado não disponível';
  }
  ngAfterViewInit() {
    this.previousFocus = document.activeElement as HTMLElement | null;
    if (this.dialog.nativeElement.showModal) this.dialog.nativeElement.showModal();
    else this.dialog.nativeElement.setAttribute('open', ''); // DOM de testes sem implementação de dialog
  }
  ngOnDestroy() {
    if (this.dialog.nativeElement.close) this.dialog.nativeElement.close();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
