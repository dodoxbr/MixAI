import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { PROVIDER_SETTINGS_PORT, type ProviderId, type ProviderSettingsSnapshot, validModelId } from './provider-settings-port';

const ERRORS: Record<string, string> = {
  INVALID: 'O servidor recusou a seleção. Confira o modelo, a chave e a disponibilidade do provedor.',
  MODEL_UNAVAILABLE: 'Modelo indisponível. Atualize a lista ou escolha outro modelo.',
  UNAUTHORIZED: 'Sessão encerrada. Entre novamente.', FORBIDDEN: 'Esta configuração exige uma sessão de operador.',
  UNSUPPORTED: 'Configuração não disponível nesta versão do servidor.', INVALID_RESPONSE: 'O servidor retornou informações incompatíveis. Nenhum estado foi presumido.',
  BUSY: 'O servidor está ocupado. Atualize antes de tentar novamente.', QUOTA: 'Limite de uso atingido. Consulte o responsável pelo orçamento.',
};

@Injectable()
export class ProviderSettingsService implements OnDestroy {
  private readonly port = inject(PROVIDER_SETTINGS_PORT);
  private readonly session = inject(SessionService);
  private readonly live = inject(LiveService);
  readonly snapshot = signal<ProviderSettingsSnapshot | null>(null);
  readonly selected = signal<ProviderId>('ollama');
  readonly model = signal('');
  readonly consent = signal(false);
  readonly busy = signal(false);
  readonly slow = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  private readonly loadedContext = signal<{ token: string | null; serverId: string | undefined } | null>(null);
  readonly allowed = computed(() => !!this.session.token() && this.live.hello()?.role === 'operator' && this.live.connection() === 'online');
  readonly option = computed(() => this.snapshot()?.options.find(o => o.id === this.selected()));
  readonly validModel = computed(() => {
    const o = this.option(), m = this.model();
    return !!o && (o.modelMode === 'server_only' ? m === (o.model ?? '') : o.modelMode === 'list' ? o.models.includes(m) : validModelId(m));
  });
  readonly canSave = computed(() => this.allowed() && this.loadedContext()?.token === this.session.token() &&
    this.loadedContext()?.serverId === this.live.hello()?.serverId && !this.busy() &&
    this.option()?.selectable === true && this.validModel() && (!this.option()?.external || this.consent()));
  private epoch = 0;
  private ctl?: AbortController;
  private slowTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private endWait?: () => void;
  constructor() {
    effect(() => {
      this.session.token(); this.live.hello()?.serverId;
      const allowed = this.allowed();
      untracked(() => {
        this.stop(); this.loadedContext.set(null); this.snapshot.set(null); this.consent.set(false); this.notice.set(''); this.error.set('');
        if (allowed) void this.refresh();
      });
    });
  }
  choose(id: ProviderId) {
    if (this.busy()) return;
    this.selected.set(id); this.model.set(this.option()?.model ?? this.option()?.models[0] ?? ''); this.consent.set(false); this.notice.set('');
  }
  chooseModel(model: string) { this.model.set(model); this.consent.set(false); this.notice.set(''); }
  private stop() {
    this.epoch++; this.endWait?.(); this.endWait = undefined;
    this.ctl?.abort(); clearTimeout(this.slowTimer); clearTimeout(this.deadline);
    this.busy.set(false); this.slow.set(false);
  }
  private async run(save: boolean) {
    if (!this.allowed() || this.busy() || save && !this.canSave()) return;
    this.stop(); const epoch = this.epoch, token = this.session.token(), serverId = this.live.hello()?.serverId, ctl = this.ctl = new AbortController();
    const choice = { provider: this.selected(), ...(this.option()?.modelMode !== 'server_only' ? { model: this.model() } : {}), confirmExternal: this.option()?.external === true && this.consent() };
    this.busy.set(true); this.error.set(''); this.notice.set(''); this.consent.set(false);
    this.snapshot.set(null); // no stale active/billing information during an uncertain request
    this.loadedContext.set(null);
    this.slowTimer = setTimeout(() => { if (epoch === this.epoch) this.slow.set(true); }, 3000);
    // Promise race also fences ports that fail to honor AbortSignal.
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => { this.deadline = setTimeout(() => { timedOut = true; ctl.abort(); reject(new Error('TIMEOUT')); }, 25_000); });
    const interrupted = new Promise<never>((_, reject) => { this.endWait = () => reject(new Error('CANCELLED')); });
    try {
      const next = await Promise.race([save ? this.port.select(choice, ctl.signal) : this.port.load(ctl.signal), timeout, interrupted]);
      if (epoch !== this.epoch || token !== this.session.token() || serverId !== this.live.hello()?.serverId || !this.allowed()) return;
      this.loadedContext.set({ token, serverId });
      this.snapshot.set(next); this.selected.set(next.active.provider);
      this.model.set(next.active.model ?? next.options.find(o => o.id === next.active.provider)?.models[0] ?? '');
      if (save) this.notice.set('Seleção confirmada pelo servidor.' + (choice.confirmExternal ? ' Confirmação de envio externo enviada nesta sessão.' : ''));
    } catch (e) {
      if (epoch !== this.epoch || token !== this.session.token()) return;
      const code = timedOut ? 'TIMEOUT' : (e as { code?: string; message?: string })?.code ?? (e as Error)?.message;
      this.error.set(ERRORS[code ?? ''] ?? (code === 'TIMEOUT' ? 'O servidor demorou demais. Atualize para conferir a seleção; ela pode ter sido recebida.' : 'Não foi possível confirmar o estado. Confira a conexão e atualize.'));
    } finally {
      if (epoch === this.epoch) { this.endWait = undefined; clearTimeout(this.slowTimer); clearTimeout(this.deadline); this.busy.set(false); this.slow.set(false); }
    }
  }
  refresh() { return this.run(false); }
  save() { return this.run(true); }
  cancel() { this.stop(); this.loadedContext.set(null); this.snapshot.set(null); this.consent.set(false); this.notice.set('Consulta cancelada nesta tela. Atualize para conferir o estado no servidor. Isso não revoga um consentimento já recebido.'); }
  ngOnDestroy() { this.stop(); }
}
