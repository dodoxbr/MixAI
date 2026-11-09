import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig, PROJECT_ROOT, type LoadedConfig } from '../src/core/config.js';
import { readPackFromDir } from '../src/knowledge/local/pack.js';
import { diagnose } from '../src/knowledge/sound-engineer/index.js';
import { RealMixer } from '../src/mixer/real.js';
import { TechnicalPlanner, answerPlannerQuestion, autoConfigCases, bandKnowledgeAdapter, createConfiguredPlanner, plannerInputFromConsultation,
  plannerResultSchema, type PlannerPolicy, type PlannerProvider, type PlannerInput, type LabObservation } from '../src/autoconfig/index.js';
const channels = parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8')));
const names = new ChannelMap(channels, { inputs: 12, aux: 6 });
const microphones = readPackFromDir(join(PROJECT_ROOT, 'knowledge/seed/banda-v1_2')).microphones;
const knowledge = bandKnowledgeAdapter(names, microphones);
const ready = () => structuredClone(autoConfigCases[0]!.input);
const policy = (): PlannerPolicy => ({ enabled: true, active: true, selected: 'gemini', externalConsent: true, revision: 1 });
const good = JSON.stringify({ kind: 'proposal', candidate: 's1', evidence: ['e1'] });
const provider = (id: string, external: boolean, response: { text?: string; failure?: any } = { text: good }): PlannerProvider => ({ id, external, generate: vi.fn(async () => response) });
const planner = (providers: PlannerProvider[] = [], current = policy, extra = {}) => new TechnicalPlanner({ knowledge, providers, policy: current, ...extra });
afterEach(() => vi.restoreAllMocks());

it('pergunta uma vez por campo, mantém destino conhecido e usa somente canais cadastrados', async () => {
  const gemini = provider('gemini', true), p = planner([gemini]); let input: PlannerInput = { mode: 'LAB', instrument: 'vozes', destination: 'fones', symptom: 'abafado' };
  const seen = [];
  for (const value of [3, 'operator_report', 'intelligibility', 'target_only', 'ensemble']) {
    const r = await p.plan(input); expect(r.kind).toBe('question'); if (r.kind !== 'question') throw new Error('expected question');
    expect((r.question.text.match(/\?/g) ?? []).length).toBe(1); seen.push(r.question.field);
    if (r.question.field === 'channel') expect(r.question.choices.map(c => c.value)).toEqual([3, 4, 5, 6, 7]);
    expect(gemini.generate).not.toHaveBeenCalled(); input = answerPlannerQuestion(input, r, value);
  }
  expect(seen).toEqual(['channel', 'report', 'goal', 'comparison', 'isolation']);
  const done = await p.plan(input); expect(done.kind).toBe('proposal'); expect(gemini.generate).toHaveBeenCalledTimes(1);
  if (done.kind === 'proposal') { expect(done.proposal.channel).toBe(3); expect(done.proposal.destination).toBe('fones'); expect(done.proposal.suggestions[0].justification).toContain('voz principal'); }
});
it('resposta atrasada/forjada não substitui contexto nem vira autorização', async () => {
  const p = planner(); const input = { mode: 'LAB' as const }; const r = await p.plan(input);
  expect(() => answerPlannerQuestion({ ...input, channel: 3 }, r, 4)).toThrow('STALE');
  expect(() => answerPlannerQuestion(input, r, 'aplicar')).toThrow('INVALID');
  expect(() => answerPlannerQuestion(input, { ...r, question: { field: 'execute', text: 'executa?', choices: [{ value: 'sim', label: 'Sim' }] } } as any, 'sim')).toThrow();
});
it.each(autoConfigCases)('$id: mesmo caso nos provedores Gemini e Qwen/Ollama, fundamentação e segurança', async ({ input }) => {
  const write = vi.spyOn(RealMixer.prototype, 'write');
  for (const selected of ['gemini', 'ollama']) {
    const chosen = provider(selected, selected === 'gemini');
    const r = await planner([chosen], () => ({ ...policy(), selected })).plan(input);
    expect(plannerResultSchema.safeParse(r).success).toBe(true); expect(r.kind).toBe('proposal');
    expect(r).toMatchObject({ execution: 'not_executable', authorization: 'not_granted', realWrites: false, measurements: 'unavailable' });
    if (r.kind !== 'proposal') throw new Error(JSON.stringify(r));
    expect(r.proposal.suggestions).toHaveLength(1); expect(r.proposal.evidence[0]).toMatchObject({ kind: input.report!.kind, verification: 'reported_not_measured' });
    expect(r.proposal.channel).toBe(input.channel); expect(r.proposal.destination).toBe(input.destination);
    const s = r.proposal.suggestions[0]; expect(s.targetValue).toBeNull(); expect(s.candidate.references.length).toBeGreaterThan(0);
    expect(s.candidate.preconditions.length).toBeGreaterThan(0); expect(s.candidate.verification).toBeTruthy(); expect(s.rollback.automatic).toBe(false);
    expect(s.rollback.previousStateAvailable).toBe(false); expect(s.limitations.join(' ')).toContain('Sem estado anterior validado');
    if (input.destination === 'fones') { expect(s.risk).toBe('high'); expect(s.justification).toContain('AUX1 é compartilhado'); }
    if (input.symptom === 'microfonia') expect(s.candidate.procedureId).toBe('feedback-aux');
    if (input.channel === 8) expect(s.candidate.procedureId).toBe('surdo-body');
  }
  expect(write).not.toHaveBeenCalled();
});
it('nega externo sem consentimento; indisponibilidade degrada sem inventar outro modelo', async () => {
  const g = provider('gemini', true), q = provider('ollama', false);
  const r = await planner([g, q], () => ({ ...policy(), externalConsent: false })).plan(ready());
  expect(g.generate).not.toHaveBeenCalled(); expect(q.generate).toHaveBeenCalledOnce(); expect(r.provider.used).toBe('ollama');
  const offline = await planner([provider('gemini', true, { failure: 'unavailable' }), provider('ollama', false, { failure: 'unavailable' })]).plan(ready());
  expect(offline.kind).toBe('proposal'); expect(offline.provider.used).toBe('deterministic'); expect(offline.provider.attempts).toHaveLength(2);
});
it.each(['timeout', 'quota', 'auth', 'truncated', 'recitation', 'error', 'empty'] as const)('fallback por %s preserva o mesmo contrato', async failure => {
  const q = provider('ollama', false); const r = await planner([provider('gemini', true, { failure }), q]).plan(ready());
  expect(r.provider.used).toBe('ollama'); expect(q.generate).toHaveBeenCalledOnce(); expect(r.kind).toBe('proposal');
});
it('recusa de segurança não passa para outro modelo nem gera plano determinístico', async () => {
  const q = provider('ollama', false); const r = await planner([provider('gemini', true, { failure: 'refused' }), q]).plan(ready());
  expect(r).toMatchObject({ kind: 'refusal', reason: 'provider_refused' }); expect(q.generate).not.toHaveBeenCalled();
});
it.each([
  { kind: 'proposal', candidate: 's1', evidence: ['e1'], frequencyHz: 2500 },
  { kind: 'proposal', candidate: 's1', evidence: ['e1'], tools: [{ execute: 'phantom' }] },
  { kind: 'proposal', candidate: 's1', evidence: ['invented'] },
  { kind: 'proposal', candidate: 's3', evidence: ['e1'] }, // surdo fixture only has two procedures
  { kind: 'proposal', candidate: 's1', evidence: ['e1'], justification: 'Detectei 3000 Hz no REAL' },
  { kind: 'abstain', reason: 'unsafe' }, { kind: 'abstain', reason: 'insufficient_evidence' },
])('modelo não adiciona medições/estado/valores/ferramentas nem contorna bloqueio: %j', async output => {
  const q = provider('ollama', false); const r = await planner([provider('gemini', true, { text: JSON.stringify(output) }), q]).plan(ready());
  expect(r.kind).toBe('refusal'); expect(q.generate).not.toHaveBeenCalled(); expect(JSON.stringify(r)).not.toContain('Detectei');
});
it.each(['not json', '```json\n{}\n```', 'x'.repeat(3000)])('saída inválida é descartada sem exibição', async text => {
  const r = await planner([provider('gemini', true, { text })]).plan(ready()); expect(r).toMatchObject({ kind: 'refusal', reason: 'invalid_model_output' });
});
it.each([{ mode: 'REAL' }, { mode: 'LAB', commands: [{ type: 'set_level' }] }, { ...ready(), phantom: true }, { ...ready(), gain: 30 }, { ...ready(), targets: [1, 2] }, { ...ready(), observation: { verified: true, real: true } }, { ...ready(), externalConsent: true }])('entrada crítica/REAL/lote/estado ou consentimento forjado é recusado antes da IA: %j', async input => {
  const g = provider('gemini', true); expect(await planner([g]).plan(input)).toMatchObject({ kind: 'refusal', reason: 'invalid_input' }); expect(g.generate).not.toHaveBeenCalled();
});
it('canal desconhecido e contradição de instrumento são recusados', async () => {
  expect(await planner().plan({ ...ready(), channel: 12 })).toMatchObject({ kind: 'refusal', reason: 'unsupported_source' });
  expect(await planner().plan({ ...ready(), instrument: 'vozes' })).toMatchObject({ kind: 'refusal', reason: 'unsupported_source' });
});
it('apito ativo/segurança desconhecida interrompe; não usa modelo para ring-out', async () => {
  const g = provider('gemini', true); for (const feedback of ['active', 'unknown']) expect(await planner([g]).plan({ ...autoConfigCases[3]!.input, feedback })).toMatchObject({ kind: 'refusal', reason: 'safety_stop' });
  const r = await planner([g]).plan({ ...autoConfigCases[3]!.input, feedback: undefined }); expect(r.kind).toBe('question'); expect(g.generate).not.toHaveBeenCalled();
});
it('não promove leitura declarada pelo diagnóstico a observação validada', () => {
  const d = diagnose({ symptom: 'magro', instrument: 'surdo', channel: 8, destination: 'pa', evidence: [{ id: 'declared', kind: 'control_state', parameter: 'fader', value: -4, revision: 9, detail: 'caller' }] });
  const input = plannerInputFromConsultation(d.consultation, 'body'); expect(input.reference).toBeUndefined(); expect(input.report).toBeUndefined();
});
it('P3 S e papéis vêm do cadastro, nunca do nome em uma mensagem', () => {
  expect(knowledge.sources().find(s => s.channel === 3)).toMatchObject({ microphone: 'p3s', role: 'lead' });
  for (const ch of [5, 7]) expect(knowledge.sources().find(s => s.channel === ch)).toMatchObject({ microphone: 'unknown', role: 'backing' });
});
it('estado LAB deve ser validado, recente, do mesmo canal/destino/referência e permanecer igual', async () => {
  const input = { ...ready(), reference: { id: 'ref1', version: 1 } };
  const original: LabObservation = { reference: input.reference, mode: 'LAB', channel: 8, destination: 'pa', observedAt: 1000, revision: 2, levelDB: -20, mute: false };
  const read = vi.fn(async () => original);
  const ok = await planner([], policy, { clock: () => 1100, observations: { read } }).plan(input);
  expect(ok.kind).toBe('proposal'); if (ok.kind === 'proposal') expect(ok.proposal.suggestions[0].rollback.previousStateAvailable).toBe(true);
  for (const bad of [{ ...original, mode: 'REAL' }, { ...original, channel: 3 }, { ...original, destination: 'fones' }, { ...original, observedAt: 2000 }, { ...original, observedAt: 0 }, { ...original, reference: { id: 'other', version: 1 } }]) {
    const r = await planner([], policy, { clock: () => 70_000, observations: { read: async () => bad } }).plan(input); expect(r).toMatchObject({ kind: 'refusal', reason: 'stale_observation' });
  }
  const partial = await planner([], policy, { clock: () => 1100, observations: { read: async () => ({ ...original, levelDB: null }) } }).plan(input);
  expect(partial.kind).toBe('proposal'); if (partial.kind === 'proposal') expect(partial.proposal.suggestions[0].rollback.previousStateAvailable).toBe(false);
  let observedAt = 1000;
  const freshRead = await planner([], policy, { clock: () => 1100, observations: { read: async () => ({ ...original, observedAt: observedAt++ }) } }).plan(input);
  expect(freshRead.kind).toBe('proposal'); // a later read timestamp alone does not change state
  let calls = 0; const changing = { read: async () => ({ ...original, revision: calls++ ? 3 : 2 }) };
  expect(await planner([], policy, { clock: () => 1100, observations: changing }).plan(input)).toMatchObject({ kind: 'refusal', reason: 'stale_observation' });
});
it('revogação, troca de provedor ou consentimento durante geração descartam resposta tardia', async () => {
  for (const mutate of [(p: PlannerPolicy) => { p.active = false; }, (p: PlannerPolicy) => { p.externalConsent = false; }, (p: PlannerPolicy) => { p.revision++; }, (p: PlannerPolicy) => { p.selected = 'ollama'; }]) {
    const current = policy(); const g: PlannerProvider = { id: 'gemini', external: true, generate: async () => { mutate(current); return { text: good }; } };
    expect(await planner([g], () => current).plan(ready())).toMatchObject({ kind: 'refusal', reason: 'stale_policy' });
  }
});
it('timeout contém provedor travado e ignora resposta tardia; não reenvia nada', async () => {
  let finish!: (v: { text: string }) => void;
  const g: PlannerProvider = { id: 'gemini', external: true, generate: vi.fn(() => new Promise<{ text: string }>(resolve => { finish = resolve; })) };
  const r = await planner([g], policy, { timeoutMs: 5 }).plan(ready()); expect(r.provider.used).toBe('deterministic');
  finish({ text: good }); await Promise.resolve(); expect(g.generate).toHaveBeenCalledOnce(); expect(r.provider.attempts[0]!.status).toBe('timeout');
});
it('isolamento por chamada: planos e respostas não compartilham mutações ou referência', async () => {
  const p = planner(); const [a, b] = await Promise.all([p.plan(ready()), p.plan(autoConfigCases[1]!.input)]);
  expect(a.kind).toBe('proposal'); expect(b.kind).toBe('proposal');
  if (a.kind === 'proposal' && b.kind === 'proposal') { expect(a.proposal.id).not.toBe(b.proposal.id); a.proposal.suggestions[0].candidate.purpose = 'mutated'; expect(JSON.stringify(b)).not.toContain('mutated'); expect(JSON.stringify(await p.plan(ready()))).not.toContain('mutated'); }
});
it('falha de cadastro ou configuração é contida, sem mensagem privada', async () => {
  const p = new TechnicalPlanner({ knowledge: { sources: () => { throw new Error('private/path'); }, candidates: () => [] }, policy });
  expect(JSON.stringify(await p.plan(ready()))).not.toContain('private'); expect((await p.plan(ready())).kind).toBe('refusal');
});

function loaded(extra = {}): LoadedConfig { return { config: parseConfig({ mixer: { mode: 'lab' }, knowledge: { enabled: true, gemini: { enabled: true }, ollama: { chatModel: 'qwen3:8b', narrative: true }, ...extra } }), channels, configDir: '.', logDir: null, labFile: 'unused', secrets: { geminiApiKey: 'fake-key-not-a-real-credential' } }; }
function wire() {
  const sent: Array<{ url: string; body: any }> = [];
  const fetchFn = vi.fn(async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined; sent.push({ url: String(url), body });
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    if (String(url).endsWith('/api/chat')) return new Response(JSON.stringify({ message: { content: good }, done_reason: 'stop' }));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: good }] }, finishReason: 'STOP' }] }));
  }); return { sent, fetchFn: fetchFn as unknown as typeof fetch };
}
it.each(['gemini', 'ollama'])('clientes existentes: %s sem tools e sem dados privados nas requisições', async selected => {
  const w = wire(); const p = createConfiguredPlanner(loaded(), names, { policy: () => ({ ...policy(), selected }), fetch: w.fetchFn, geminiFetch: w.fetchFn, microphones });
  for (const c of autoConfigCases) expect((await p.plan({ ...c.input, report: { ...c.input.report!, detail: 'Fred token=secret 192.0.2.10 C:\\private\\file documento confidencial' } })).kind).toBe('proposal');
  const all = JSON.stringify(w.sent); expect(all).not.toMatch(/Fred|Lucius|Fernando|192\.0\.2\.10|private|confidencial|token=secret|tools|tool_choice/);
  if (selected === 'ollama') expect(w.sent.find(s => s.url.endsWith('/api/chat'))!.body.model).toBe('qwen3:8b');
  else expect(all).toContain(':generateContent');
});
it('factory respeita configuração, consentimento e escopo LAB sem tocar preferências/segredos', async () => {
  for (const settings of [loaded({ enabled: false }), { ...loaded(), config: parseConfig({ mixer: { mode: 'real' }, knowledge: { enabled: true, gemini: { enabled: true } } }) }]) {
    const w = wire(); const p = createConfiguredPlanner(settings, names, { policy, fetch: w.fetchFn, geminiFetch: w.fetchFn }); expect((await p.plan(ready())).kind).toBe('refusal'); expect(w.sent).toEqual([]);
  }
  const w = wire(); const p = createConfiguredPlanner(loaded(), names, { policy: () => ({ ...policy(), externalConsent: false }), fetch: w.fetchFn, geminiFetch: w.fetchFn });
  expect((await p.plan(ready())).provider.used).toBe('ollama'); expect(w.sent.every(s => !s.url.includes('googleapis'))).toBe(true);
  const remote = wire(); const altered = loaded({ gemini: { enabled: false } }); altered.config.knowledge.ollama.url = 'http://remote.invalid:11434';
  const r = createConfiguredPlanner(altered, names, { policy, fetch: remote.fetchFn, geminiFetch: remote.fetchFn });
  expect((await r.plan(ready())).provider.used).toBe('deterministic'); expect(remote.sent).toEqual([]);
});

it('geração desativada na configuração existente mantém plano determinístico, sem sondar serviços', async () => {
  const w = wire();
  const p = createConfiguredPlanner(loaded({ ollama: { narrative: false } }), names, { policy, fetch: w.fetchFn, geminiFetch: w.fetchFn });
  const r = await p.plan(ready()); expect(r.kind).toBe('proposal'); expect(r.provider.used).toBe('deterministic'); expect(w.sent).toEqual([]);
});
