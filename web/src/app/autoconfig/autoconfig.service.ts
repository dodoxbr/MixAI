import {
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import {
  adaptPlan,
  adaptResult,
  type AutoAdapter,
  type AutoAnswers,
  type AutoContext,
  type AutoInput,
  type AutoPlan,
  type AutoReference,
  type AutoResult,
} from './autoconfig-contract';
export const AUTO_ADAPTER = new InjectionToken<AutoAdapter>('AUTOCONFIG_UI_ADAPTER', {
  providedIn: 'root',
  factory: () => ({
    kind: 'fixture',
    plan: async (input) => (await import('./autoconfig-fixture')).fixtureAdapter.plan(input),
    simulate: async (input) =>
      (await import('./autoconfig-fixture')).fixtureAdapter.simulate(input),
  }),
});
export type ItemStatus = 'proposed' | 'approved' | 'simulated' | 'accepted' | 'rejected';
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
      this.live.hello()?.mode === 'lab',
  );
  readonly stateRevision = computed(() => this.live.state()?.revision ?? null);
  readonly connected = computed(() => this.live.connection() === 'online');
  readonly context = signal<AutoContext | null>(null);
  readonly stage = signal<'idle' | 'questions' | 'plan' | 'cancelled'>('idle');
  readonly question = signal(0);
  readonly answers = signal<AutoAnswers>({ goal: '', channel: 0, destination: 'PA', report: '' });
  readonly plan = signal<AutoPlan | null>(null);
  readonly status = signal<Record<string, ItemStatus>>({});
  readonly results = signal<Record<string, AutoResult>>({});
  readonly history = signal<string[]>([]);
  readonly references = signal<AutoReference[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly fixture = computed(
    () => this.adapter.kind === 'fixture' || this.plan()?.fixture === true,
  );
  readonly canAct = computed(() => this.eligible() && this.connected() && !!this.context());
  readonly canSave = computed(
    () =>
      !!this.plan() &&
      this.plan()!.items.every((i) =>
        ['accepted', 'rejected'].includes(this.status()[i.id] ?? ''),
      ) &&
      this.plan()!.items.some((i) => this.status()[i.id] === 'accepted'),
  );
  private identityKey = '';
  private generation = 0;
  private revision: number | null = null;
  constructor() {
    effect(() => {
      const h = this.live.hello();
      const key = JSON.stringify([
        this.session.token(),
        this.session.role(),
        h?.role,
        h?.mode,
        h?.serverId,
      ]);
      if (key !== this.identityKey) {
        this.identityKey = key;
        untracked(() => this.clear(true));
      }
    });
    effect(() => {
      const online = this.connected();
      untracked(() => {
        if (!online)
          this.invalidate(
            'Conexão interrompida. Aprovações descartadas; revise um novo plano ao reconectar.',
          );
      });
    });
    effect(() => {
      const revision = this.live.state()?.revision ?? null;
      untracked(() => {
        if ((this.plan() || this.busy()) && revision !== this.revision)
          this.invalidate('Estado LAB mudou. Revise um novo plano; não repetimos testes.');
      });
    });
  }
  bind(context: AutoContext | null) {
    if (JSON.stringify(this.context()) === JSON.stringify(context)) return;
    this.clear(true);
    this.context.set(context);
  }
  private clear(identity = false) {
    this.generation++;
    this.stage.set('idle');
    this.question.set(0);
    this.answers.set({ goal: '', channel: 0, destination: 'PA', report: '' });
    this.plan.set(null);
    this.status.set({});
    this.results.set({});
    this.busy.set(false);
    this.error.set('');
    if (identity) {
      this.history.set([]);
      this.references.set([]);
    }
    if (identity) this.context.set(null);
  }
  private invalidate(message: string) {
    this.generation++;
    this.busy.set(false);
    const hadPlan = !!this.plan();
    if (hadPlan || this.stage() === 'questions') {
      this.plan.set(null);
      this.status.set({});
      this.results.set({});
      this.stage.set('questions');
      if (hadPlan) this.question.set(3);
      this.error.set(message);
      this.log(message);
    }
  }
  private log(text: string) {
    this.history.update((h) => [...h.slice(-49), text]);
  }
  start() {
    if (!this.canAct()) return;
    this.clear();
    this.stage.set('questions');
    this.log('Operador iniciou uma configuração em SIMULAÇÃO LAB.');
  }
  cancel() {
    if (!this.eligible()) return;
    this.generation++;
    this.plan.set(null);
    this.status.set({});
    this.results.set({});
    this.busy.set(false);
    this.error.set('');
    this.stage.set('cancelled');
    this.log('Cancelado pelo operador; nenhuma operação na mesa.');
  }
  answer(value: string) {
    if (!this.canAct() || this.busy() || this.stage() !== 'questions' || this.question() > 2)
      return;
    const q = this.question();
    const a = this.answers();
    if (q === 0) {
      if (!value.trim() || value.length > 300) return;
      this.answers.set({ ...a, goal: value.trim() });
    }
    if (q === 1) {
      const channel = Number(value);
      if (!this.live.channels().some((c) => c.number === channel)) return;
      this.answers.set({ ...a, channel });
    }
    if (q === 2) {
      if (value !== 'PA' && value !== 'AUX1') return;
      this.answers.set({ ...a, destination: value });
    }
    this.question.update((q) => q + 1);
    this.log(
      ['Objetivo informado.', 'Canal escolhido pelo operador.', 'Destino escolhido pelo operador.'][
        q
      ]!,
    );
  }
  back() {
    if (!this.canAct() || this.busy() || this.stage() !== 'questions') return;
    this.question.update((q) => Math.max(0, q - 1));
  }
  private identity() {
    const h = this.live.hello();
    return JSON.stringify([
      this.session.token(),
      this.session.role(),
      h?.role,
      h?.mode,
      h?.serverId,
      this.context(),
    ]);
  }
  private async run(operation: () => Promise<void>) {
    if (!this.canAct() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    await operation();
  }
  async prepare(report: string) {
    if (
      this.stage() !== 'questions' ||
      this.question() !== 3 ||
      !report.trim() ||
      report.length > 500
    )
      return;
    const a = this.answers();
    const context = this.context();
    if (!context || !a.goal || !this.live.channels().some((c) => c.number === a.channel)) return;
    await this.run(async () => {
      this.answers.set({ ...a, report: report.trim() });
      const input: AutoInput = {
        ...context,
        ...this.answers(),
        schemaVersion: 1,
        scope: 'lab_simulation',
        stateRevision: this.live.state()?.revision ?? null,
      };
      this.revision = input.stateRevision;
      const g = ++this.generation;
      const identity = this.identity();
      try {
        const raw = await this.withTimeout(this.adapter.plan(input));
        if (!this.current(g, identity)) return;
        const plan = adaptPlan(raw, input);
        this.plan.set(plan);
        this.status.set(Object.fromEntries(plan.items.map((i) => [i.id, 'proposed'])));
        this.results.set({});
        this.stage.set('plan');
        this.log('Plano recebido; nenhuma aprovação concedida pela IA.');
      } catch {
        if (this.current(g, identity))
          this.error.set(
            'Plano indisponível ou incompatível. Revise e tente novamente explicitamente.',
          );
      } finally {
        if (this.current(g, identity)) this.busy.set(false);
      }
    });
  }
  private current(g: number, identity: string) {
    return (
      g === this.generation &&
      identity === this.identity() &&
      this.canAct() &&
      this.stateRevision() === this.revision
    );
  }
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('timeout')), 10000);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
  private stateValid() {
    if (this.plan() && this.stateRevision() !== this.revision) {
      this.invalidate('Estado LAB mudou. Revise um novo plano.');
      return false;
    }
    return true;
  }
  approve(id: string) {
    if (!this.stateValid() || !this.canAct() || this.busy() || this.status()[id] !== 'proposed')
      return;
    this.status.update((s) => ({ ...s, [id]: 'approved' }));
    this.log('Aprovação humana para um teste LAB: ' + id);
  }
  async simulate(id: string) {
    const plan = this.plan();
    const item = plan?.items.find((i) => i.id === id);
    if (!this.stateValid() || !plan || !item || this.status()[id] !== 'approved') return;
    await this.run(async () => {
      const g = ++this.generation;
      const identity = this.identity();
      // Approval is consumed before dispatch; failure cannot replay it.
      this.status.update((s) => ({ ...s, [id]: 'proposed' }));
      try {
        const raw = await this.withTimeout(
          this.adapter.simulate({ plan, itemId: id, operatorApproved: true }),
        );
        if (!this.current(g, identity)) return;
        const result = adaptResult(raw, plan, item);
        this.results.update((r) => ({ ...r, [id]: result }));
        this.status.update((s) => ({ ...s, [id]: 'simulated' }));
        this.log('Resultado SIMULADO recebido: ' + id);
      } catch {
        if (this.current(g, identity))
          this.error.set(
            'Teste sem resultado confiável. Nada será repetido; exige nova autorização humana.',
          );
      } finally {
        if (this.current(g, identity)) this.busy.set(false);
      }
    });
  }
  decide(id: string, accept: boolean) {
    if (
      !this.stateValid() ||
      !this.canAct() ||
      this.busy() ||
      !this.plan()?.items.some((i) => i.id === id)
    )
      return;
    if (accept && this.status()[id] !== 'simulated') return;
    this.status.update((s) => ({ ...s, [id]: accept ? 'accepted' : 'rejected' }));
    this.log(
      (accept
        ? 'Operador confirmou referência simulada: '
        : 'Operador rejeitou/descartou cenário: ') + id,
    );
  }
  save() {
    if (!this.stateValid() || !this.canAct() || this.busy() || !this.canSave()) return;
    const context = this.context()!;
    const plan = this.plan()!;
    const reference: AutoReference = {
      schemaVersion: 1,
      scope: 'lab_simulation',
      temporary: true,
      eventId: context.eventId,
      version: this.references().length + 1,
      items: plan.items
        .filter((i) => this.status()[i.id] === 'accepted')
        .map((item) => ({ item, result: this.results()[item.id]! })),
    };
    this.references.update((r) => [...r, reference]);
    this.log(
      'Referência temporária v' + reference.version + ' salva somente na memória desta sessão.',
    );
  }
}
