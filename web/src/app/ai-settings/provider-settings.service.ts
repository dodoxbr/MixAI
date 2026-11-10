import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { PROVIDER_SETTINGS_PORT, type ModelValidation, type ProviderId, type ProviderSettingsSnapshot, validModelId } from './provider-settings-port';
const ERRORS: Record<string, string> = {
  INVALID: 'ID ou pedido inválido. Confira o formato do modelo.', MODEL_UNAVAILABLE: 'Modelo indisponível para esta conta/provedor.',
  UNAUTHORIZED: 'Sessão encerrada. Entre novamente.', FORBIDDEN: 'Catálogo exclusivo de operador no LAB.',
  UNSUPPORTED: 'Catálogo não disponível. Requer LAB e habilitação no servidor.', DISABLED: 'Catálogo ou provedor desabilitado no servidor.',
  NOT_CONFIGURED: 'Provedor sem configuração/chave no servidor.', NOT_CONSENTED: 'O servidor não autorizou o envio externo nesta sessão.',
  INVALID_RESPONSE: 'Resposta incompatível do catálogo. Nenhum estado foi presumido.',
  STALE: 'A revisão mudou. Atualize o estado antes de selecionar ou limpar novamente.', BUSY: 'Operação concorrente. Atualize antes de tentar novamente.',
  PRICE_UNKNOWN: 'Preço desconhecido: geração externa bloqueada pelo servidor.', RATE_LIMIT: 'Limite de consultas por minuto atingido.', BUDGET: 'Orçamento recusado pelo servidor.',
};
type Operation = 'load' | 'validate' | 'select' | 'clear';
@Injectable()
export class ProviderSettingsService implements OnDestroy {
  private readonly port = inject(PROVIDER_SETTINGS_PORT);
  private readonly session = inject(SessionService);
  private readonly live = inject(LiveService);
  readonly snapshot = signal<ProviderSettingsSnapshot | null>(null);
  readonly validation = signal<ModelValidation | null>(null);
  readonly selected = signal<ProviderId>('ollama');
  readonly model = signal('');
  readonly consent = signal(false);
  readonly busy = signal(false);
  readonly operation = signal<Operation>('load');
  readonly slow = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  private readonly context = signal<{ token: string | null; serverId: string | undefined; revision: number } | null>(null);
  readonly allowed = computed(() => !!this.session.token() && this.live.hello()?.role === 'operator' && this.live.hello()?.mode === 'lab' && this.live.connection() === 'online');
  readonly current = computed(() => this.allowed() && !!this.context() && this.context()!.token === this.session.token() && this.context()!.serverId === this.live.hello()?.serverId);
  readonly option = computed(() => this.snapshot()?.providers.find(o => o.id === this.selected()));
  readonly validModel = computed(() => validModelId(this.selected(), this.model()));
  readonly canSave = computed(() => this.current() && !this.busy() && this.option()?.enabled === true && this.option()?.configured === true && this.validModel() && (!this.option()?.external || this.consent()));
  readonly canClear = computed(() => this.current() && !(this.busy() && this.operation() === 'clear'));
  private epoch = 0;
  private ctl?: AbortController;
  private slowTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private endWait?: () => void;
  constructor() {
    effect(() => {
      this.session.token(); this.live.hello()?.serverId;
      const allowed = this.allowed();
      untracked(() => { this.stop(); this.context.set(null); this.snapshot.set(null); this.validation.set(null); this.consent.set(false); this.notice.set(''); this.error.set(''); if (allowed) void this.refresh(); });
    });
  }
  choose(id: ProviderId) {
    if (this.busy()) return;
    this.selected.set(id); this.model.set(this.option()?.models[0]?.id ?? ''); this.resetDraft();
  }
  chooseModel(model: string) { if (!this.busy()) { this.model.set(model); this.resetDraft(); } }
  private resetDraft() { this.validation.set(null); this.consent.set(false); this.notice.set(''); this.error.set(''); }
  private stop() {
    this.epoch++; this.endWait?.(); this.endWait = undefined; this.ctl?.abort(); clearTimeout(this.slowTimer); clearTimeout(this.deadline);
    this.busy.set(false); this.slow.set(false);
  }
  private async run(operation: Operation) {
    if (!this.allowed() || (operation === 'clear' ? !this.canClear() : this.busy())) return;
    if ((operation === 'select' || operation === 'validate') && !this.canSave()) return;
    const revision = this.context()?.revision ?? 0, token = this.session.token(), serverId = this.live.hello()?.serverId;
    const choice = { provider: this.selected(), model: this.model(), confirmExternal: this.option()?.external === true && this.consent() };
    this.stop(); const epoch = this.epoch, ctl = this.ctl = new AbortController();
    this.busy.set(true); this.operation.set(operation); this.error.set(''); this.notice.set(''); this.consent.set(false); this.validation.set(null);
    if (operation !== 'validate') this.snapshot.set(null);
    this.slowTimer = setTimeout(() => { if (epoch === this.epoch) this.slow.set(true); }, 3000);
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => { this.deadline = setTimeout(() => { timedOut = true; ctl.abort(); reject(new Error('TIMEOUT')); }, 35_000); });
    const interrupted = new Promise<never>((_, reject) => { this.endWait = () => reject(new Error('CANCELLED')); });
    try {
      const request = operation === 'load' ? this.port.load(ctl.signal) : operation === 'clear' ? this.port.clear(revision, ctl.signal) : operation === 'validate' ? this.port.validate(choice, ctl.signal) : this.port.select(choice, revision, ctl.signal);
      const next = await Promise.race([request, timeout, interrupted]);
      if (epoch !== this.epoch || token !== this.session.token() || serverId !== this.live.hello()?.serverId || !this.allowed()) return;
      if (operation === 'validate') {
        this.validation.set(next as ModelValidation);
        this.notice.set('Metadados consultados. Esta validação não seleciona o modelo nem concede consentimento para geração.');
      } else {
        const view = next as ProviderSettingsSnapshot;
        this.context.set({ token, serverId, revision: view.revision }); this.snapshot.set(view);
        this.selected.set(view.selection?.provider ?? view.providers.find(p => p.enabled && p.configured)?.id ?? 'ollama');
        this.model.set(view.selection?.model ?? this.option()?.models[0]?.id ?? '');
        if (operation !== 'load') this.notice.set(operation === 'clear' ? 'Seleção e consentimento do catálogo limpos pelo servidor nesta sessão.' : 'Seleção do catálogo confirmada pelo servidor nesta sessão. Diagnóstico/RAG/AutoConfig não foram alterados.');
      }
    } catch (e) {
      if (epoch !== this.epoch || token !== this.session.token() || serverId !== this.live.hello()?.serverId) return;
      const code = timedOut ? 'TIMEOUT' : (e as { code?: string }).code ?? (e as Error).message;
      this.snapshot.set(null); this.context.set(null); this.validation.set(null);
      this.error.set(ERRORS[code] ?? (code === 'TIMEOUT' ? 'O servidor demorou demais. Atualize: a operação pode ter sido recebida. Não haverá repetição automática.' : 'Não foi possível confirmar o catálogo. Confira a conexão e atualize.'));
    } finally { if (epoch === this.epoch) { this.endWait = undefined; clearTimeout(this.slowTimer); clearTimeout(this.deadline); this.busy.set(false); this.slow.set(false); } }
  }
  refresh() { return this.run('load'); }
  validate() { return this.run('validate'); }
  save() { return this.run('select'); }
  clear() { return this.run('clear'); }
  cancel() { this.stop(); this.snapshot.set(null); this.validation.set(null); this.consent.set(false); this.notice.set('Espera cancelada nesta tela. Isso não revoga consentimento nem desfaz uma operação já recebida. Atualize ou use a limpeza do catálogo para confirmar o estado.'); }
  ngOnDestroy() { this.stop(); }
}
