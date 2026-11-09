import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AutoConfigService, AUTO_ADAPTER } from './autoconfig.service';
import { AutoConfigComponent } from './autoconfig.component';
import { AutoConfigView, advicePresentation, type AutoAdapter } from './autoconfig-contract';
import { AutoHttpError } from './autoconfig-http';
import { SessionService } from '../core/session.service';
import { LiveService } from '../core/live.service';

const context = { eventId: 'event-a', eventName: 'Ensaio', eventVersion: 1 };
const fp = (c: string) => c.repeat(64);
const base = {
  schemaVersion: 1,
  mode: 'LAB',
  authorization: 'not_granted',
  execution: 'not_executable',
  realWrites: false,
  measurements: 'unavailable',
  safety: ['Somente plano LAB; nada autoriza ou executa ajustes.'],
};
const model = (used = 'deterministic', selected = 'ollama') => ({
  selected,
  used,
  external: used === 'gemini',
  name: used === 'ollama' ? 'qwen3:8b' : used === 'gemini' ? 'gemini-fixture' : null,
});
function question(field = 'comparison', print = 'b', extra: object = {}): any {
  return {
    serverId: 'server-a',
    numericInput: 'operator_required',
    createsDraft: false,
    proposal: null,
    model: model(),
    context: { fromDiagnosis: true, known: ['channel', 'destination', 'symptom'] },
    advice: {
      ...base,
      inputFingerprint: fp(print),
      provider: { used: 'deterministic', attempts: [] },
      kind: 'question',
      question: {
        field,
        text: field === 'comparison' ? 'O problema ocorre só nos fones ou também no PA?' : 'Ocorre com a fonte sozinha?',
        choices: [
          { label: 'Só neste destino', value: 'target_only' },
          { label: 'Nos dois', value: 'both' },
        ],
      },
    },
    ...extra,
  };
}
function proposal(used = 'deterministic', attempts: any[] = [], selected = 'ollama'): any {
  return {
    serverId: 'server-a',
    numericInput: 'operator_required',
    createsDraft: false,
    model: model(used, selected),
    context: { fromDiagnosis: true, known: ['channel', 'destination', 'symptom', 'report', 'comparison', 'isolation'] },
    proposal: {
      schemaVersion: 1,
      items: [
        {
          id: 'inspect-0001',
          operation: 'level_delta',
          channel: 3,
          rationale: 'Inspeção consultiva, não recomendação de alterar nível.',
          evidence: [
            { kind: 'human_report', text: 'Relato classificado: abafado; origem operator_report; não é medição.' },
            { kind: 'theory', text: 'Conferir captação. proc-1 v1. Sem causa acústica validada.' },
          ],
        },
      ],
    },
    advice: {
      ...base,
      inputFingerprint: fp('c'),
      provider: { used, attempts },
      kind: 'proposal',
      proposal: {
        id: '7f8f0d4e-2a51-4c3b-9b6e-0d6f5c1a2b3c',
        scope: 'single_source_lab_inspection',
        channel: 3,
        instrument: 'vozes',
        role: 'lead',
        destination: 'fones',
        knowledgeVersion: '1',
        evidence: [{ id: 'report-1', kind: 'operator_report', symptom: 'abafado', verification: 'reported_not_measured' }],
        observation: null,
        suggestions: [
          {
            kind: 'inspection',
            risk: 'high',
            justification: 'Relato de abafado; objetivo intelligibility.',
            limitations: ['Não ouvi o som nem identifiquei frequência.'],
            targetValue: null,
            requiresHumanReview: true,
            rollback: { automatic: false, previousStateAvailable: false, instruction: 'Esta inspeção não altera controles.' },
            candidate: {
              id: 's1',
              procedureId: 'proc-1',
              procedureVersion: '1',
              purpose: 'Conferir posição e distância do microfone',
              instruction: 'Peça para cantar a frase de teste a um palmo do microfone.',
              preconditions: ['Operador presente'],
              verification: 'Compare com a referência anterior.',
              stop: 'Pare se houver apito.',
              references: [
                {
                  title: 'Manual público',
                  url: 'https://example.org/manual',
                  section: '2.1',
                  version: '2024',
                  consultedOn: '2026-11-01',
                  validationStatus: 'theory',
                },
              ],
            },
          },
        ],
      },
    },
  };
}
function refusal(reason = 'provider_refused', attempts: any[] = [{ provider: 'gemini', status: 'refused' }]): any {
  return {
    serverId: 'server-a',
    numericInput: 'operator_required',
    createsDraft: false,
    proposal: null,
    model: model('deterministic', 'gemini'),
    context: { fromDiagnosis: false, known: [] },
    advice: { ...base, inputFingerprint: fp('d'), provider: { used: 'deterministic', attempts }, kind: 'refusal', reason, message: 'Provedor recusou; não tentar outro modelo para contornar.' },
  };
}
function plan(): any {
  return AutoConfigView.parse({
    schemaVersion: 1,
    id: 'plan-000001',
    title: 'Inspeção CH3',
    eventId: 'event-a',
    scope: 'AUX1',
    version: 1,
    serverId: 'server-a',
    createdAt: '2026-11-09T00:00:00Z',
    expiresAt: '2035-11-09T00:10:00Z',
    state: 'draft',
    items: [
      {
        spec: { id: 'test-000001', operation: 'level_delta', channel: 3, deltaDB: 0.5, rationale: 'Passo do operador', evidence: [{ kind: 'human_report', text: 'Relato' }] },
        state: 'draft',
        questions: [],
      },
    ],
    receipts: [],
    history: [],
    interrupted: false,
    stale: false,
    simulationOnly: true,
    availability: { context: 'not_prepared', realObservation: 'unavailable', acousticMeasurement: 'unavailable', reference: 'absent' },
    virtualState: {},
    counts: {},
  });
}
function boot(request = vi.fn<AutoAdapter['request']>()) {
  const token = signal<string | null>('session-a'),
    role = signal('operator'),
    hello = signal<any>({ role: 'operator', mode: 'lab', serverId: 'server-a' }),
    connection = signal('online'),
    state = signal<any>({ revision: 7 });
  const expire = vi.fn(() => token.set(null));
  TestBed.configureTestingModule({
    providers: [
      { provide: AUTO_ADAPTER, useValue: { request } },
      { provide: SessionService, useValue: { token, role, expire } },
      { provide: LiveService, useValue: { hello, connection, state, command: vi.fn(), channels: signal([{ number: 3, name: 'Voz Fred' }]) } },
    ],
  });
  const fixture = TestBed.createComponent(AutoConfigComponent);
  fixture.componentRef.setInput('event', context);
  fixture.detectChanges();
  return { fixture, ui: TestBed.inject(AutoConfigService), token, hello, connection, expire, request };
}
const text = (f: { nativeElement: HTMLElement; detectChanges(): void }) => (f.detectChanges(), f.nativeElement.textContent ?? '');

it('consults the planner without scope or numbers, then answers one question at a time with only the choice and fingerprint', async () => {
  const request = vi.fn<AutoAdapter['request']>().mockResolvedValueOnce(question()).mockResolvedValueOnce(question('isolation', 'e'));
  const { ui, fixture } = boot(request);
  await ui.consult();
  expect(request.mock.calls[0]![0]).toBe('/api/autoconfig/suggestions');
  expect(request.mock.calls[0]![1]).toEqual({ serverId: 'server-a', eventId: 'event-a' });
  const page = text(fixture);
  expect(page).toContain('O problema ocorre só nos fones ou também no PA?');
  expect(page).toContain('Já informado no diagnóstico (não será perguntado de novo): canal, destino, sintoma.');
  expect(page).not.toContain('Qual canal');
  await ui.answerAdvice('invented-value');
  expect(request).toHaveBeenCalledTimes(1); // only server-offered choices
  await ui.answerAdvice('target_only');
  expect(request.mock.calls[1]![1]).toEqual({ serverId: 'server-a', eventId: 'event-a', answer: { inputFingerprint: fp('b'), value: 'target_only' } });
  expect(text(fixture)).toContain('Ocorre com a fonte sozinha?');
  expect(ui.model()).toBeNull();
});

it('shows the inspection with justification, evidence, sources and limits, and never turns it into a level change', async () => {
  const request = vi.fn<AutoAdapter['request']>().mockResolvedValueOnce(proposal());
  const { ui, fixture } = boot(request);
  await ui.consult();
  const page = text(fixture);
  for (const s of ['Recomendação da IA — inspeção sugerida, não ajuste', 'Conferir posição e distância do microfone', 'Justificativa:', 'Relato do operador: abafado — não é medição', 'Manual público', 'Não ouvi o som', 'Pare se houver apito.', 'Motor determinístico do MixAI'])
    expect(page).toContain(s);
  ui.chooseDecision('inspection_only');
  expect(text(fixture)).toContain('Combinado: só a inspeção. Nada foi criado no servidor');
  await ui.createFromAdvice(1); // wrong decision: nothing is sent
  expect(request).toHaveBeenCalledTimes(1);
  ui.chooseDecision('virtual_step');
  fixture.detectChanges();
  const input = fixture.nativeElement.querySelector('input[aria-label="Passo virtual do operador em dB"]') as HTMLInputElement;
  expect(input.value).toBe(''); // no default number
  const create = [...fixture.nativeElement.querySelectorAll('button')].find((b: any) => b.textContent.includes('Criar rascunho de simulação')) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  for (const bad of [0, 3.5, -4, Number.NaN]) await ui.createFromAdvice(bad);
  expect(request).toHaveBeenCalledTimes(1);
});

it('creates the D draft only with the operator step, the planner channel/scope and classified evidence; approval stays on the server', async () => {
  const request = vi.fn<AutoAdapter['request']>().mockResolvedValueOnce(proposal()).mockResolvedValueOnce(plan());
  const { ui, fixture } = boot(request);
  await ui.consult();
  ui.chooseDecision('virtual_step');
  await ui.createFromAdvice(0.5);
  expect(request).toHaveBeenCalledTimes(2);
  const [path, body] = request.mock.calls[1]!;
  expect(path).toBe('/api/autoconfig');
  expect(body).toMatchObject({ serverId: 'server-a', eventId: 'event-a', scope: 'AUX1', items: [{ operation: 'level_delta', channel: 3, deltaDB: 0.5 }] });
  expect((body as any).items[0].evidence).toEqual(proposal().proposal.items[0].evidence);
  expect((body as any).items[0].rationale).toContain('A IA não sugeriu valor');
  expect(JSON.stringify(body)).not.toMatch(/approv|digest|confirmed/);
  expect(ui.stage()).toBe('plan');
  const page = text(fixture);
  expect(page).toContain('Origem: inspeção sugerida pela IA');
  expect(page).toContain('Decisão do operador:');
  expect(ui.status()['test-000001']).toBe('blocked'); // draft: not authorized until the server says so
});

it('identifies the model used and explains Gemini fallback or missing session confirmation', () => {
  expect(advicePresentation(proposal('ollama')).model).toBe('Ollama local · qwen3:8b — no próprio computador');
  const gemini = advicePresentation(proposal('gemini', [{ provider: 'gemini', status: 'used' }], 'gemini'));
  expect(gemini.model).toContain('Gemini · gemini-fixture — serviço externo');
  expect(gemini.notes).toEqual([]);
  const quota = advicePresentation(proposal('ollama', [{ provider: 'gemini', status: 'quota' }, { provider: 'ollama', status: 'used' }], 'gemini'));
  expect(quota.notes).toEqual(['Gemini: cota esgotada']);
  const consent = advicePresentation(proposal('ollama', [{ provider: 'gemini', status: 'not_consented' }, { provider: 'ollama', status: 'used' }], 'gemini'));
  expect(consent.selected).toBe('Gemini');
  expect(consent.notes[0]).toContain('não confirmado nesta sessão — nada foi enviado');
  expect(consent.notes[0]).toContain('a chave já configurada é reaproveitada');
});

it('a safety refusal is shown as-is: no fallback model, no plan, no manual shortcut after a safety stop', async () => {
  const request = vi.fn<AutoAdapter['request']>().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(refusal('safety_stop', []));
  const { ui, fixture } = boot(request);
  await ui.consult();
  let page = text(fixture);
  expect(page).toContain('O modelo recusou — nenhum outro modelo foi tentado');
  expect(page).toContain('Nenhum plano, número ou autorização foi criado.');
  expect(request).toHaveBeenCalledTimes(1);
  await ui.consult();
  page = text(fixture);
  expect(page).toContain('Parada de segurança');
  expect(page).not.toContain('Definir teste manualmente (sem planejador)');
  expect(ui.model()).toBeNull();
});

it('stale context, conflicts and expired sessions show sanitized messages and drop the old question', async () => {
  const request = vi.fn<AutoAdapter['request']>()
    .mockResolvedValueOnce(question())
    .mockRejectedValueOnce(new AutoHttpError('CONFLICT', 'STALE_STATE'))
    .mockResolvedValueOnce(question())
    .mockRejectedValueOnce(new AutoHttpError('CONFLICT', 'CONFLICT'))
    .mockResolvedValueOnce(question())
    .mockRejectedValueOnce(new AutoHttpError('UNAUTHORIZED', 'UNAUTHORIZED'));
  const { ui, expire } = boot(request);
  await ui.consult();
  await ui.answerAdvice('target_only');
  expect(ui.error()).toContain('O contexto mudou');
  expect(ui.advice()).toBeNull();
  expect(ui.canAct()).toBe(true); // advice is non-mutating: no forced server refresh
  await ui.consult();
  await ui.answerAdvice('both');
  expect(ui.error()).toContain('o diagnóstico registrou piora');
  await ui.consult();
  await ui.answerAdvice('both');
  expect(expire).toHaveBeenCalled();
});

it('late planner responses are discarded after identity change or disconnection', async () => {
  let resolve!: (v: unknown) => void;
  const request = vi.fn<AutoAdapter['request']>().mockImplementation(() => new Promise((r) => (resolve = r)));
  const { ui, hello, connection, fixture } = boot(request);
  const pending = ui.consult();
  hello.set({ role: 'operator', mode: 'lab', serverId: 'server-b' });
  TestBed.tick();
  resolve(proposal());
  await pending;
  expect(ui.advice()).toBeNull();
  hello.set({ role: 'operator', mode: 'lab', serverId: 'server-a' });
  fixture.componentRef.setInput('event', { ...context }); // the soundcheck re-binds after a new identity
  TestBed.tick();
  const again = ui.consult();
  connection.set('offline');
  TestBed.tick();
  resolve(proposal());
  await again;
  expect(ui.advice()).toBeNull();
  expect(ui.error()).toContain('Conexão interrompida');
});

it('rejects a response from another server and never accepts a numeric value inside the skeleton', async () => {
  const forged = proposal();
  forged.proposal.items[0].deltaDB = 2;
  const request = vi.fn<AutoAdapter['request']>().mockResolvedValueOnce({ ...proposal(), serverId: 'server-b' }).mockResolvedValueOnce(forged);
  const { ui } = boot(request);
  await ui.consult();
  expect(ui.advice()).toBeNull();
  await ui.consult();
  expect(ui.advice()).toBeNull();
  expect(ui.error()).toContain('Resposta indisponível ou incompatível');
});
