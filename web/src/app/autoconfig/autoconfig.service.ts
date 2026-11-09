import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { newId } from '../core/protocol';
import {
  AdvisoryResponse,
  AutoConfigView,
  Workspace,
  ReferenceReceipt,
  advicePresentation,
  presentation,
  type AutoConfigAdvice,
  type AutoConfigReadModel,
  type AutoContext,
  type AutoAnswers,
  type AutoReference,
} from './autoconfig-contract';
import { AUTO_ADAPTER, AutoHttpError } from './autoconfig-http';
export { AUTO_ADAPTER } from './autoconfig-http';
export type ItemStatus =
  'proposed' | 'approved' | 'simulated' | 'accepted' | 'rejected' | 'blocked' | 'saved';
@Injectable({ providedIn: 'root' })
export class AutoConfigService {
  private readonly session = inject(SessionService);
  readonly live = inject(LiveService);
  private readonly adapter = inject(AUTO_ADAPTER);
  readonly eligible = computed(
    () =>
      !!this.session.token() &&
      this.session.role() === 'operator' &&
      this.live.hello()?.role === 'operator' &&
      ['lab', 'mock'].includes(this.live.hello()?.mode ?? ''),
  );
  readonly connected = computed(() => this.live.connection() === 'online');
  readonly stateRevision = computed(() => this.live.state()?.revision ?? null);
  readonly context = signal<AutoContext | null>(null);
  readonly model = signal<AutoConfigReadModel | null>(null);
  readonly availablePlans = signal<AutoConfigReadModel[]>([]);
  readonly stage = signal<'idle' | 'advice' | 'questions' | 'plan' | 'cancelled'>('idle');
  /** Last planner answer (C). Advice only: it never authorizes, never carries a number. */
  readonly advice = signal<AutoConfigAdvice | null>(null);
  readonly adviceView = computed(() => (this.advice() ? advicePresentation(this.advice()!) : null));
  /** Human decision after an inspection: nothing, inspection only, or an operator-defined virtual step. */
  readonly decision = signal<'pending' | 'inspection_only' | 'virtual_step'>('pending');
  readonly question = signal(0);
  readonly answers = signal<AutoAnswers>({ goal: '', channel: 0, destination: 'PA', report: '' });
  readonly plan = computed(() => (this.model() ? presentation(this.model()!) : null));
  readonly status = computed(() =>
    Object.fromEntries(
      (this.model()?.items ?? []).map((i) => [
        i.spec.id,
        (
          {
            proposed: 'proposed',
            approved_for_lab: 'approved',
            simulated: 'simulated',
            reviewed: 'accepted',
            rejected: 'rejected',
            saved: 'saved',
          } as Record<string, ItemStatus>
        )[i.state] ?? 'blocked',
      ]),
    ),
  );
  readonly results = computed(() =>
    Object.fromEntries(
      (this.model()?.items ?? [])
        .filter((i) => i.result)
        .map((i) => [
          i.spec.id,
          {
            before: i.result!.before,
            after: i.result!.after ?? 'Indisponível',
            verification: `${i.result!.outcome} · valores virtuais somente · áudio não analisado${i.result!.undo ? ' · desfeito' : ''}`,
          },
        ]),
    ),
  );
  readonly history = computed(
    () => this.model()?.history.map((h) => `v${h.version} · ${h.action} · ${h.note ?? ''}`) ?? [],
  );
  readonly references = signal<AutoReference[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly needsRefresh = signal(false);
  readonly requiresPreparation = signal(false);
  readonly canAct = computed(
    () => this.eligible() && this.connected() && !!this.context() && !this.needsRefresh(),
  );
  readonly canSave = computed(
    () =>
      !this.requiresPreparation() &&
      this.model()?.state === 'reviewed' &&
      !this.model()?.stale &&
      !this.model()?.interrupted,
  );
  readonly mutable = computed(
    () =>
      !!this.model() &&
      !this.requiresPreparation() &&
      !['saved', 'rejected', 'expired'].includes(this.model()!.state) &&
      !this.model()!.stale &&
      !this.model()!.interrupted &&
      !this.model()!.running,
  );
  private generation = 0;
  private identityKey = '';
  private controller: AbortController | undefined;
  constructor() {
    effect(() => {
      const key = this.identity();
      if (key !== this.identityKey) {
        this.identityKey = key;
        untracked(() => this.clear(true));
      }
    });
    effect(() => {
      const online = this.connected();
      untracked(() => {
        if (!online) {
          this.invalidate('Conexão interrompida. Consulte o servidor antes de continuar.');
        }
      });
    });
    effect(() => {
      const revision = this.stateRevision();
      untracked(() => {
        if (this.model()?.context && revision !== this.model()!.context!.revision) {
          this.needsRefresh.set(true);
          this.requiresPreparation.set(true);
          this.error.set('Estado mudou. Consulte e prepare novamente no servidor.');
        }
      });
    });
  }
  private identity() {
    const h = this.live.hello();
    return JSON.stringify([
      this.session.token(),
      this.session.role(),
      h?.role,
      h?.mode,
      h?.serverId,
    ]);
  }
  private clear(identity = false) {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.model.set(null);
    this.availablePlans.set([]);
    this.references.set([]);
    this.busy.set(false);
    this.error.set('');
    this.needsRefresh.set(false);
    this.requiresPreparation.set(false);
    this.stage.set('idle');
    this.question.set(0);
    this.answers.set({ goal: '', channel: 0, destination: 'PA', report: '' });
    this.advice.set(null);
    this.decision.set('pending');
    if (identity) this.context.set(null);
  }
  bind(context: AutoContext | null) {
    if (JSON.stringify(context) === JSON.stringify(this.context())) return;
    this.clear();
    this.context.set(context);
  }
  private invalidate(message: string) {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    const pending = this.busy();
    this.busy.set(false);
    // Planner advice is never answered across a disconnection: the server keeps the pending
    // question, so a new explicit consultation returns it again with fresh guards.
    this.advice.set(null);
    this.decision.set('pending');
    if (this.model() || pending) {
      this.needsRefresh.set(true);
      this.requiresPreparation.set(true);
    }
    this.error.set(message);
  }
  private async request(path: string, body?: object): Promise<unknown> {
    const controller = this.controller!;
    return this.adapter.request(path, body, controller.signal);
  }
  private validate(raw: unknown) {
    const p = AutoConfigView.parse(raw);
    if (
      (p.serverId !== this.live.hello()?.serverId && !p.interrupted) ||
      (p.context && p.context.mode !== this.live.hello()?.mode && !p.interrupted) ||
      p.eventId !== this.context()?.eventId
    )
      throw new AutoHttpError('CONFLICT');
    return p;
  }
  private async run(
    operation: (current: () => boolean) => Promise<void>,
    read = false,
    opts: { timeoutMs?: number; messages?: Record<string, string>; onError?: () => void } = {},
  ) {
    if (
      !this.eligible() ||
      !this.connected() ||
      !this.context() ||
      this.busy() ||
      (!read && this.needsRefresh())
    )
      return;
    const g = ++this.generation,
      identity = this.identity(),
      context = JSON.stringify(this.context());
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    this.error.set('');
    const current = () =>
      g === this.generation &&
      identity === this.identity() &&
      context === JSON.stringify(this.context()) &&
      !controller.signal.aborted &&
      this.eligible() &&
      this.connected();
    const timer = setTimeout(() => {
      if (current()) {
        this.invalidate(
          'Tempo esgotado. Resultado indeterminado; consulte o servidor. Nenhuma repetição automática.',
        );
        this.needsRefresh.set(true);
        opts.onError?.();
      }
    }, opts.timeoutMs ?? 10000);
    try {
      await operation(current);
    } catch (e) {
      if (current()) {
        const code = e instanceof AutoHttpError ? e.code : 'INVALID';
        const detail = e instanceof AutoHttpError ? e.detail : undefined;
        this.needsRefresh.set(true);
        this.requiresPreparation.set(true);
        opts.onError?.();
        this.error.set(
          (detail && opts.messages?.[detail]) ??
          opts.messages?.[code] ??
          (
            {
              UNAUTHORIZED: 'Sessão encerrada. Entre novamente.',
              FORBIDDEN: 'Servidor recusou a autorização desta sessão.',
              CONFLICT:
                'Conflito de versão, contexto ou autorização. Consulte o servidor e revise.',
              DEPENDENCY_UNAVAILABLE: 'Núcleo indisponível. Nenhuma repetição automática.',
              STORE_UNAVAILABLE:
                'Armazenamento indisponível. Consulte o servidor antes de continuar.',
            } as Record<string, string>
          )[code] ??
            'Resposta indisponível ou incompatível. Consulte o servidor antes de continuar.',
        );
        if (code === 'UNAUTHORIZED') this.session.expire('Sua sessão terminou. Entre novamente.');
      }
    } finally {
      clearTimeout(timer);
      if (g === this.generation) {
        this.busy.set(false);
        this.controller = undefined;
      }
    }
  }
  private static readonly ADVICE_MESSAGES: Record<string, string> = {
    STALE_STATE:
      'O contexto mudou (diagnóstico, estado LAB, provedor ou sessão) enquanto o planejador respondia. A resposta foi descartada; consulte de novo.',
    CONFLICT:
      'O planejador não pode responder agora: há outra consulta em andamento, o diagnóstico registrou piora ou o destino diverge do diagnóstico. Revise e consulte de novo.',
    SERVER_CHANGED: 'O servidor reiniciou ou mudou. Consulte de novo.',
    CAPACITY: 'Muitas consultas abertas no servidor. Tente de novo em alguns minutos.',
    MODE_MISMATCH: 'O planejador só funciona em LAB.',
    DEPENDENCY_UNAVAILABLE: 'Planejador indisponível. Nenhuma repetição automática.',
    NOT_FOUND: 'Planejador não disponível neste servidor (somente LAB).',
  };
  /** One planner call. Non-mutating on the server: no plan, approval or number is created. */
  private async advise(body: object) {
    const c = this.context();
    if (!c) return;
    await this.run(
      async (current) => {
        const raw = await this.request('/api/autoconfig/suggestions', {
          serverId: this.live.hello()!.serverId,
          eventId: c.eventId,
          ...body,
        });
        if (!current()) return;
        const advice = AdvisoryResponse.parse(raw);
        if (advice.serverId !== this.live.hello()?.serverId) throw new AutoHttpError('CONFLICT');
        this.advice.set(advice);
        this.decision.set('pending');
      },
      true,
      {
        // The planner may try two providers (selected + local fallback) before answering.
        timeoutMs: 25000,
        messages: AutoConfigService.ADVICE_MESSAGES,
        onError: () => {
          this.advice.set(null);
          this.decision.set('pending');
          if (!this.model()) {
            this.needsRefresh.set(false);
            this.requiresPreparation.set(false);
          }
        },
      },
    );
  }
  /** Starts the planner flow. M1 context is reused by the server; no scope is assumed here. */
  consult() {
    if (!this.canAct() || this.busy()) return;
    this.model.set(null);
    this.references.set([]);
    this.advice.set(null);
    this.decision.set('pending');
    this.stage.set('advice');
    return this.advise({});
  }
  /** Sends only the chosen value and the question fingerprint (context reference, not a credential). */
  answerAdvice(value: string | number) {
    const a = this.advice();
    if (
      !this.canAct() ||
      this.busy() ||
      this.stage() !== 'advice' ||
      a?.advice.kind !== 'question' ||
      !a.advice.question.choices.some((c) => c.value === value)
    )
      return;
    return this.advise({ answer: { inputFingerprint: a.advice.inputFingerprint, value } });
  }
  /** Human decision. Choosing an inspection never turns it into a level change. */
  chooseDecision(decision: 'pending' | 'inspection_only' | 'virtual_step') {
    if (this.stage() !== 'advice' || this.advice()?.advice.kind !== 'proposal' || this.busy())
      return;
    this.decision.set(decision);
  }
  /**
   * Creates a D draft ONLY after the operator chose to simulate and typed the step. The planner's
   * skeleton contributes channel, scope and classified evidence; the number is the operator's.
   */
  async createFromAdvice(delta: number) {
    const c = this.context(),
      a = this.advice(),
      view = this.adviceView(),
      skeleton = a?.proposal?.items[0];
    if (
      this.stage() !== 'advice' ||
      this.decision() !== 'virtual_step' ||
      !c ||
      !skeleton ||
      view?.kind !== 'proposal' ||
      !Number.isFinite(delta) ||
      delta === 0 ||
      Math.abs(delta) > 3
    )
      return;
    await this.run(async (current) => {
      const raw = await this.request('/api/autoconfig', {
        serverId: this.live.hello()!.serverId,
        id: newId('auto_'),
        title: `Inspeção CH${view.channel} · ${view.destination === 'AUX1' ? 'FONES (AUX1)' : 'PA'} · passo do operador`,
        eventId: c.eventId,
        scope: view.destination,
        items: [
          {
            id: newId('auto_'),
            operation: 'level_delta',
            channel: skeleton.channel,
            deltaDB: delta,
            rationale:
              'Passo virtual decidido e digitado pelo operador após a inspeção sugerida. A IA não sugeriu valor nem afirmou que mudar o nível resolve.',
            evidence: skeleton.evidence,
          },
        ],
      });
      if (current()) {
        this.model.set(this.validate(raw));
        this.answers.set({
          goal: view.purpose.slice(0, 300),
          channel: view.channel,
          destination: view.destination,
          report: skeleton.evidence.find((e) => e.kind === 'human_report')?.text ?? '',
        });
        this.stage.set('plan');
      }
    });
  }
  start() {
    if (!this.canAct()) return;
    this.advice.set(null);
    this.decision.set('pending');
    this.model.set(null);
    this.references.set([]);
    this.stage.set('questions');
    this.question.set(0);
    this.answers.set({ goal: '', channel: 0, destination: 'PA', report: '' });
  }
  answer(value: string) {
    if (!this.canAct() || this.busy() || this.stage() !== 'questions') return;
    const q = this.question(),
      a = this.answers();
    if (q === 0) {
      if (!value.trim() || value.length > 300) return;
      this.answers.set({ ...a, goal: value.trim() });
    } else if (q === 1) {
      const channel = Number(value);
      if (!this.live.channels().some((c) => c.number === channel)) return;
      this.answers.set({ ...a, channel });
    } else if (q === 2) {
      if (value !== 'PA' && value !== 'AUX1') return;
      this.answers.set({ ...a, destination: value });
    } else return;
    this.question.update((q) => q + 1);
  }
  back() {
    if (this.canAct() && !this.busy() && this.stage() === 'questions')
      this.question.update((q) => Math.max(0, q - 1));
  }
  async prepare(report: string, delta: number) {
    const c = this.context(),
      a = this.answers();
    if (
      this.stage() !== 'questions' ||
      this.question() !== 3 ||
      !c ||
      !a.goal ||
      !a.channel ||
      !report.trim() ||
      report.length > 500 ||
      !Number.isFinite(delta) ||
      delta === 0 ||
      Math.abs(delta) > 3
    )
      return;
    await this.run(async (current) => {
      this.answers.set({ ...a, report: report.trim() });
      const raw = await this.request('/api/autoconfig', {
        serverId: this.live.hello()!.serverId,
        id: newId('auto_'),
        title: a.goal,
        eventId: c.eventId,
        scope: a.destination,
        items: [
          {
            id: newId('auto_'),
            operation: 'level_delta',
            channel: a.channel,
            deltaDB: delta,
            rationale: 'Teste virtual definido pelo operador; não é recomendação acústica da IA.',
            evidence: [{ kind: 'human_report', text: report.trim() }],
          },
        ],
      });
      if (current()) {
        this.model.set(this.validate(raw));
        this.stage.set('plan');
      }
    });
  }
  async refresh(id = this.model()?.id) {
    await this.run(async (current) => {
      const w = Workspace.parse(await this.request('/api/autoconfig'));
      if (!current()) return;
      if (w.serverId !== this.live.hello()?.serverId || w.mode !== this.live.hello()?.mode)
        throw new AutoHttpError('CONFLICT');
      this.availablePlans.set(w.plans.filter((p) => p.eventId === this.context()?.eventId));
      if (id) {
        const data = (await this.request('/api/autoconfig/' + encodeURIComponent(id))) as {
          plan: unknown;
          reference: unknown;
        };
        if (!current()) return;
        const plan = this.validate(data.plan);
        if (plan.id !== id) throw new AutoHttpError('CONFLICT');
        const reference = data.reference ? ReferenceReceipt.parse(data.reference) : null;
        if (
          reference &&
          (reference.simulation.planId !== plan.id ||
            reference.id !== plan.referenceId ||
            reference.simulation.mode !== this.live.hello()?.mode)
        )
          throw new AutoHttpError('CONFLICT');
        // Advice belongs to the plan created from it; another plan must not inherit it.
        if (plan.id !== this.model()?.id) this.advice.set(null);
        this.model.set(plan);
        this.requiresPreparation.set(!['saved', 'rejected', 'expired'].includes(plan.state));
        this.references.set(reference ? [reference] : []);
        this.stage.set('plan');
        this.answers.set({
          goal: plan.title,
          report: '',
          destination: plan.scope,
          channel: plan.items[0]?.spec.channel ?? 0,
        });
      }
      this.needsRefresh.set(false);
    }, true);
  }
  private async action(action: string, fields: object = {}, allowStale = false) {
    const p = this.model();
    if (
      !p ||
      ['saved', 'rejected', 'expired'].includes(p.state) ||
      (!allowStale && !this.mutable())
    )
      return;
    await this.run(async (current) => {
      const raw = await this.request(`/api/autoconfig/${p.id}/actions`, {
        serverId: this.live.hello()!.serverId,
        requestId: newId('auto_'),
        expectedVersion: p.version,
        action,
        ...fields,
      });
      if (current()) {
        const model = this.validate(raw);
        if (model.id !== p.id) throw new AutoHttpError('CONFLICT');
        this.model.set(model);
        if (action === 'prepare') this.requiresPreparation.set(false);
        this.needsRefresh.set(!!model.context && model.context.revision !== this.stateRevision());
        if (this.needsRefresh()) this.requiresPreparation.set(true);
        if (action === 'cancel') this.stage.set('cancelled');
      }
    });
  }
  revise(id: string, channel: number, delta: number) {
    const p = this.model();
    if (
      !p ||
      !this.live.channels().some((c) => c.number === channel) ||
      !Number.isFinite(delta) ||
      delta === 0 ||
      Math.abs(delta) > 3 ||
      p.items.some((i) => i.approval || i.result)
    )
      return;
    return this.action(
      'revise',
      {
        items: p.items.map((i) =>
          i.spec.id === id ? { ...i.spec, channel, deltaDB: delta } : i.spec,
        ),
      },
      true,
    );
  }
  reprepare() {
    return this.action('prepare', { confirmed: true }, true);
  }
  approve(id: string) {
    const i = this.model()?.items.find((i) => i.spec.id === id);
    if (i?.state !== 'proposed' || !i.digest) return;
    return this.action('approve', {
      itemId: id,
      digest: i.digest,
      confirmed: true,
      scope: 'simulation_only',
      expectedStateRevision: this.stateRevision(),
    });
  }
  simulate(id: string) {
    const i = this.model()?.items.find((i) => i.spec.id === id);
    if (i?.state !== 'approved_for_lab' || !i.approval || i.approval.consumedAt) return;
    return this.action('simulate', {
      itemId: id,
      approvalId: i.approval.id,
      expectedStateRevision: this.stateRevision(),
    });
  }
  decide(id: string, accept: boolean) {
    const i = this.model()?.items.find((i) => i.spec.id === id);
    if (i?.state !== 'simulated' || i.result?.outcome !== 'passed' || i.result.undo) return;
    return this.action('review', {
      itemId: id,
      accepted: accept,
      assessment: accept
        ? 'Valor virtual conferido pelo operador; acústica não validada.'
        : 'Resultado virtual rejeitado pelo operador.',
    });
  }
  undo(id: string) {
    const i = this.model()?.items.find((i) => i.spec.id === id);
    if (!i?.result || i.result.undo) return;
    return this.action('undo', {
      itemId: id,
      resultId: i.result.id,
      confirmed: true,
      expectedStateRevision: this.stateRevision(),
    });
  }
  cancel() {
    if (!this.model()) {
      this.stage.set('cancelled');
      return Promise.resolve();
    }
    return this.action('cancel', { reason: 'Cancelado pelo operador na interface.' }, true);
  }
  async save() {
    if (!this.canSave()) return;
    await this.action('save', { confirmed: true, expectedStateRevision: this.stateRevision() });
    if (this.model()?.state === 'saved' && !this.needsRefresh()) await this.refresh();
  }
}
