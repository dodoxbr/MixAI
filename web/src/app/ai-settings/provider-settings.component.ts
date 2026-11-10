import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, ViewChild, computed, inject, output } from '@angular/core';
import { CatalogProviderSettings } from './catalog-provider-settings';
import { PROVIDERS, PROVIDER_LABELS, PROVIDER_SETTINGS_PORT } from './provider-settings-port';
import { ProviderSettingsService } from './provider-settings.service';
@Component({
  selector: 'mx-ai-provider-settings',
  providers: [ProviderSettingsService, { provide: PROVIDER_SETTINGS_PORT, useExisting: CatalogProviderSettings }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="ai-settings-title" (cancel)="$event.preventDefault(); closed.emit()">
      <header>
        <div><p class="eyebrow">Configurações · LAB</p><h2 id="ai-settings-title">Inteligência Artificial</h2></div>
        <button autofocus type="button" class="btn btn-ghost" (click)="closed.emit()" aria-label="Fechar configurações de IA">Fechar</button>
      </header>
      <p class="warning" role="note">Catálogo v1 — seleção exclusiva desta sessão. O modelo escolhido aqui responde ao resumo do diagnóstico/RAG e ao planejador do AutoConfig desta sessão, com consentimento por sessão e por modelo. Embeddings continuam independentes. Sem seleção, valem as configurações da Base de conhecimento. Nada é executado na mesa.</p>
      <section class="active" aria-label="Seleção do catálogo nesta sessão">
        <span class="eyebrow">Seleção confirmada do catálogo</span>
        @if (s.snapshot(); as pv) {
          @if (pv.selection; as selection) {
            <strong>{{ names[selection.provider] }} · {{ selection.model }}</strong>
            <p>Metadados confirmados pelo provedor · revisão {{ pv.revision }}. Isso não garante capacidade/permissão de geração.</p>
          } @else { <p>Nenhum modelo selecionado nesta sessão.</p> }
          <p>{{ pv.consent.required ? (pv.consent.granted ? 'Servidor informa consentimento concedido nesta sessão para este modelo/revisão.' : 'Consentimento do catálogo ausente ou revogado nesta sessão.') : 'Sem concessão de envio externo no catálogo.' }}</p>
        } @else { <p>{{ s.busy() ? 'Consultando seleção do catálogo…' : 'Seleção do catálogo não disponível' }}</p> }
      </section>
      <div aria-live="polite" aria-atomic="true">
        @if (s.busy()) { <p role="status">{{ s.slow() ? 'Resposta lenta. Aguardando confirmação do servidor…' : 'Consultando o catálogo…' }}</p> }
        @if (s.notice()) { <p role="status" class="success">{{ s.notice() }}</p> }
      </div>
      @if (s.error()) { <p role="alert" class="warning">{{ s.error() }}</p> }
      @if (!s.allowed()) { <p role="alert" class="warning">Conecte-se com uma sessão de operador no LAB para configurar o catálogo.</p> }
      <form (submit)="$event.preventDefault(); s.save()" [attr.aria-busy]="s.busy()">
        <fieldset [disabled]="s.busy() || !s.allowed() || !s.snapshot()">
          <legend>Provedor do catálogo</legend>
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
            @if (!o.enabled) { <p class="warning">Provedor desabilitado no servidor.</p> }
            @else if (!o.configured) { <p class="warning">Não configurado. Falta configurar a chave ou o serviço no servidor. Este painel não recebe credenciais.</p> }
            @if (o.models.length) {
              <label for="ai-model-list">Sugestões do catálogo</label>
              <select id="ai-model-list" [value]="suggested() ? s.model() : ''" (change)="s.chooseModel($any($event.target).value)" [disabled]="s.busy() || !o.enabled || !o.configured || !s.allowed()">
                <option value="">Informar outro ID manualmente</option>
                @for (model of o.models; track model.id) { <option [value]="model.id">{{ model.id }}</option> }
              </select>
            }
            <label for="ai-model-id">ID do modelo</label>
            <input id="ai-model-id" type="text" autocomplete="off" spellcheck="false" [attr.maxlength]="o.external ? 80 : 128" [value]="s.model()" (input)="s.chooseModel($any($event.target).value)" [disabled]="s.busy() || !s.allowed() || !o.enabled || !o.configured" aria-describedby="ai-model-help" [attr.aria-invalid]="!s.validModel()" />
            <p id="ai-model-help" class="muted">Sugestões não são uma lista obrigatória. Informe outro ID e valide no servidor. {{ o.external ? 'Externo: 2 a 80 letras/números, ponto, hífen ou underscore.' : 'Ollama: até 128 caracteres, incluindo namespace e tag; sem URLs, espaços, .. ou //.' }}</p>
            @if (!s.validModel()) { <p class="warning">Informe um ID válido para este provedor.</p> }
            @if (s.validation(); as v) {
              <p role="status" [class.warning]="v.validation === 'unavailable'">{{ v.validation === 'provider_confirmed' ? 'Metadados do modelo confirmados pelo provedor.' : 'Modelo indisponível na consulta de metadados.' }} Esta consulta não muda a seleção.</p>
            }
            <section class="costs" aria-label="Custos e limites do catálogo">
              <h4>Custos e limites informados pelo servidor</h4>
              @if (s.snapshot(); as pv) {
                <p>Orçamento diário compartilhado (UTC): {{ money(pv.limits.dailyBudgetUSD) }}. Registro de {{ pv.usage.day }}.</p>
                <p>Consumo estimado agregado: {{ money(pv.usage.costUSD) }} · reservas em andamento: {{ money(pv.usage.reservedUSD) }}.</p>
                <p>{{ pv.usage.requests }} chamadas registradas · {{ pv.usage.inputTokens }} tokens de entrada · {{ pv.usage.outputTokens }} de saída.</p>
                <p>Limites: {{ pv.limits.maxRequestsPerMinute }} consultas/min · {{ pv.limits.maxOutputTokens }} tokens de saída · {{ pv.limits.maxInputBytes }} bytes de entrada.</p>
                @if (pv.usage.blocked || pv.usage.paused) { <p role="alert" class="warning">Registro de consumo bloqueado ou pausado pelo servidor.</p> }
              }
              @if (price(); as p) {
                <p>{{ s.model() }} · preço configurado em USD por milhão de tokens: entrada {{ money(p.inputPerMTok) }} / saída {{ money(p.outputPerMTok) }}.</p>
              } @else if (!o.external) { <p class="muted">Ollama: sem cobrança de API no catálogo, conforme política do servidor. Usa recursos locais.</p> }
              @else if (modelInfo()) { <p class="warning">Custo desconhecido: preço não configurado para este ID. A geração paga é bloqueada pelo servidor.</p> }
              @else { <p class="muted">Preço não disponível para este ID nesta leitura. Valide os metadados para consultar o preço; não será presumido custo zero.</p> }
              @if (modelInfo(); as info) { <p>Geração autorizável pelo catálogo: {{ info.generationAllowed ? 'permitida nas condições consultadas' : 'bloqueada nas condições consultadas' }}; consentimento, revisão e orçamento são reavaliados no servidor.</p> }
              <small>Estimativas configuradas, não cotação de mercado ou fatura. O registro é compartilhado com outros fluxos; não representa consumo exclusivo desta sessão. Consultar modelos pode consumir o limite de consultas.</small>
            </section>
            @if (o.external) {
              <div class="privacy" id="ai-privacy-note">
                <h4>Consulta externa e consentimento do catálogo</h4>
                <p>Validar ou selecionar {{ names[o.id] }} consulta o provedor externo sobre o ID informado. Este painel não envia perguntas, documentos, áudio nem estado da mesa e não oferece geração de texto.</p>
                <p>Validar autoriza somente essa consulta; não concede consentimento para geração. Selecionar concede ao catálogo, nesta sessão, autorização vinculada ao provedor, modelo e revisão. Trocar o modelo exige nova confirmação.</p>
                <p>Fechar ou cancelar a espera não revoga uma concessão já recebida pelo servidor. Use “Limpar seleção e revogar catálogo” para esta sessão. Isso não revoga permissões dos fluxos legados.</p>
              </div>
              <label class="consent"><input type="checkbox" [checked]="s.consent()" (change)="s.consent.set($any($event.target).checked)" [disabled]="s.busy() || !s.allowed() || !o.enabled || !o.configured" aria-describedby="ai-privacy-note" /> Confirmo esta operação externa para {{ names[o.id] }} e o ID informado nesta sessão.</label>
            } @else { <p class="local-note">Ollama processa localmente. Selecioná-lo não autoriza outro provedor externo.</p> }
          </section>
        }
        <footer>
          <button type="button" class="btn btn-ghost" [disabled]="s.busy() || !s.allowed()" (click)="s.refresh()">Atualizar estado</button>
          @if (s.busy()) { <button type="button" class="btn" (click)="s.cancel()">Cancelar espera</button> }
          <button type="button" class="btn" [disabled]="!s.canClear()" (click)="s.clear()">Limpar seleção e revogar catálogo</button>
          <button type="button" class="btn" [disabled]="!s.canSave()" (click)="s.validate()">Validar modelo</button>
          <button type="submit" class="btn btn-primary" [disabled]="!s.canSave()">Selecionar no catálogo</button>
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
  readonly suggested = computed(() => this.s.option()?.models.some(m => m.id === this.s.model()) === true);
  readonly modelInfo = computed(() => {
    const v = this.s.validation();
    return v && v.provider === this.s.selected() && v.model === this.s.model() ? v : this.s.option()?.models.find(m => m.id === this.s.model());
  });
  readonly price = computed(() => this.modelInfo()?.price ?? null);
  money(value: number) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value); }
  status(id: string) {
    const p = this.s.snapshot()?.providers.find(p => p.id === id);
    return !p ? 'Estado não disponível' : !p.enabled ? 'Indisponível' : p.configured ? 'Configurado' : 'Não configurado';
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
