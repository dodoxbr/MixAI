import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { AdvisoryResponse, ConsultativeSuggestionSource } from '../src/autoconfig/suggestion-source.js';
import { AutoConfigProposal, type AutoConfigSuggestionSource } from '../src/autoconfig/contracts.js';
import { RealMixer } from '../src/mixer/real.js';
import { LabMixer } from '../src/mixer/lab.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { GeminiClient } from '../src/knowledge/local/gemini.js';
import { OllamaClient } from '../src/knowledge/local/ollama.js';
import { TechnicalPlanner, bandKnowledgeAdapter, autoConfigCases } from '../src/autoconfig/index.js';
import { startTestServer, OPERATOR_PIN, MUSICIAN_PIN } from './server-support.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(t => t.server.close())); vi.restoreAllMocks(); });
async function boot(extra: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer({ channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), ...extra }); servers.push(t);
  const op = await t.login(OPERATOR_PIN);
  return { t, op, suggest: (body: object = {}, token = op) => t.http('/api/autoconfig/suggestions', { token, body: { serverId: t.server.core.serverId, scope: 'AUX1', ...body } }) };
}
async function m1(t: Awaited<ReturnType<typeof startTestServer>>, op: string, text = 'Fred está abafado só no retorno, também sozinho.') {
  const r = await t.http('/api/assistant/conversation', { token: op, body: { text } }); expect(r.status).toBe(200); return r.json.reply;
}
const action = (t: Awaited<ReturnType<typeof startTestServer>>, token: string, plan: any, name: string, extra = {}) => t.http(`/api/autoconfig/${plan.id}/actions`, { token, body: { serverId: t.server.core.serverId, requestId: randomUUID(), expectedVersion: plan.version, action: name, ...extra } });
it('M1 consolidado não repete canal/destino/sintoma/alcance/isolamento; port D gera rascunho sem número e sem mutação', async () => {
  const { t, op, suggest } = await boot(); const before = t.controller.state.snapshot();
  const writes = vi.spyOn(t.mixer, 'write'), real = vi.spyOn(RealMixer.prototype, 'write'), execute = vi.spyOn(t.server.core, 'execute');
  const reply = await m1(t, op);
  const pendingSize = t.server.core.assistant!.diagnosticContexts.size;
  const snapshot = t.server.core.assistant!.planningContext(t.server.core.auth.authenticate(op, '127.0.0.1')!)!;
  const r = await suggest(); expect(r.status).toBe(200);
  expect(AdvisoryResponse.parse(r.json).advice.kind).toBe('proposal'); expect(r.json.advice.proposal).toMatchObject({ channel: 3, destination: 'fones', role: 'lead' });
  expect(r.json.proposal.items[0]).toMatchObject({ operation: 'level_delta', channel: 3 }); expect(r.json.proposal.items[0].deltaDB).toBeUndefined();
  expect(r.json.numericInput).toBe('operator_required'); expect(r.json.createsDraft).toBe(false);
  expect((await t.http('/api/autoconfig', { token: op })).json.plans).toEqual([]);
  expect(t.server.core.assistant!.diagnosticContexts.size).toBe(pendingSize);
  expect(t.server.core.assistant!.planningContext(t.server.core.auth.authenticate(op, '127.0.0.1')!)).toEqual(snapshot);
  expect(reply.diagnosticSession.knownContext).toMatchObject({ channel: 3, scope: 'selected_only', isolation: 'alone' });
  expect(writes).not.toHaveBeenCalled(); expect(real).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(t.controller.state.snapshot()).toEqual(before);
});
it('contrato D permanece estrito e somente número explícito do operador passa por prepare/approve/simulate/review/undo', async () => {
  const { t, op, suggest } = await boot(); await m1(t, op);
  const result = (await suggest()).json, proposal = AutoConfigProposal.parse(result.proposal);
  expect(AdvisoryResponse.safeParse({ ...result, proposal: { ...proposal, items: [{ ...proposal.items[0], deltaDB: 1 }] } }).success).toBe(false);
  const before = t.controller.state.snapshot(), writes = vi.spyOn(t.mixer, 'write'), execute = vi.spyOn(t.server.core, 'execute');
  const create = await t.http('/api/autoconfig', { token: op, body: { serverId: t.server.core.serverId, id: randomUUID(), title: 'Inspeção e valor decidido pelo operador', scope: 'AUX1', items: proposal.items } });
  expect(create.status).toBe(200); let plan = create.json;
  let r = await action(t, op, plan, 'prepare', { confirmed: true }); expect(r.status).toBe(200); plan = r.json;
  expect(plan.state).toBe('needs_info'); expect(plan.items[0].questions.map((q: any) => q.id)).toContain('deltaDB');
  expect((await action(t, op, plan, 'approve', { itemId: plan.items[0].spec.id, digest: plan.items[0].digest, scope: 'simulation_only', expectedStateRevision: before.revision, confirmed: true })).status).toBe(409);
  // The human explicitly supplies 1 dB; neither planner nor adapter computes this number.
  r = await action(t, op, plan, 'revise', { items: [{ ...proposal.items[0], deltaDB: 1 }] }); expect(r.status).toBe(200); plan = r.json;
  plan = (await action(t, op, plan, 'prepare', { confirmed: true })).json; expect(plan.state).toBe('proposed');
  plan = (await action(t, op, plan, 'approve', { itemId: plan.items[0].spec.id, digest: plan.items[0].digest, scope: 'simulation_only', expectedStateRevision: before.revision, confirmed: true })).json;
  plan = (await action(t, op, plan, 'simulate', { itemId: plan.items[0].spec.id, approvalId: plan.items[0].approval.id, expectedStateRevision: before.revision })).json; expect(plan.state).toBe('simulated');
  plan = (await action(t, op, plan, 'review', { itemId: plan.items[0].spec.id, accepted: true, assessment: 'Resultado virtual conferido, sem escuta real' })).json; expect(plan.state).toBe('reviewed');
  plan = (await action(t, op, plan, 'undo', { itemId: plan.items[0].spec.id, resultId: plan.items[0].result.id, confirmed: true, expectedStateRevision: before.revision })).json; expect(plan.state).toBe('rejected');
  expect(plan.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['created', 'prepare', 'revise', 'approve', 'simulation_started', 'simulation_finished', 'review', 'undo']));
  expect(writes).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(t.controller.state.snapshot()).toEqual(before);
});
it('contexto M1 completo continua disponível; reset, TTL e sessão diferente não reaproveitam respostas', async () => {
  const { t, op, suggest } = await boot(); let reply = await m1(t, op);
  reply = (await t.http('/api/assistant/conversation', { token: op, body: { text: 'Não sei a captação', context: { id: reply.diagnosticContext.id, revision: reply.diagnosticContext.revision } } })).json.reply;
  reply = (await t.http('/api/assistant/conversation', { token: op, body: { text: 'Melhorou', context: { id: reply.diagnosticContext.id, revision: reply.diagnosticContext.revision } } })).json.reply;
  expect(reply.diagnosticSession.status).toBe('complete'); expect((await suggest()).json.advice.kind).toBe('proposal');
  const other = await t.login(OPERATOR_PIN); const isolated = await suggest({}, other); expect(isolated.json.advice.question.field).toBe('channel'); expect(JSON.stringify(isolated.json)).not.toContain('fixture-report');
  await t.http('/api/assistant/conversation', { token: op, body: { text: 'reiniciar' } }); expect((await suggest()).json.advice.question.field).not.toBe('comparison');
  t.clock.advance(300_001); t.server.core.sweep(); expect((await suggest()).json.advice.question.field).toBe('channel');
});
it('respostas consultivas são uma por vez, obsoletas não avançam e novo contexto M1 prevalece', async () => {
  const { t, op, suggest } = await boot(); await m1(t, op, 'Fred está abafado no retorno');
  const first = (await suggest()).json.advice; expect(first.question.field).toBe('comparison');
  const next = await suggest({ answer: { inputFingerprint: first.inputFingerprint, value: 'target_only' } }); expect(next.json.advice.question.field).toBe('isolation');
  expect((await suggest({ answer: { inputFingerprint: first.inputFingerprint, value: 'both' } })).status).toBe(409);
  const done = await suggest({ answer: { inputFingerprint: next.json.advice.inputFingerprint, value: 'ensemble' } }); expect(done.json.advice.kind).toBe('proposal');
  await m1(t, op, 'Meu surdo está sem grave no PA'); expect((await suggest()).status).toBe(409);
  expect((await suggest({ scope: 'PA' })).json.advice.proposal?.channel ?? 8).toBe(8);
});
it('permissões, origem, envelope, payloads forjados, modo e apito/piora não liberam aconselhamento indevido', async () => {
  const { t, op, suggest } = await boot(); const musician = await t.login(MUSICIAN_PIN), agent = readFileSync(join(t.dir, 'agent-lab.token'), 'utf8');
  for (const token of [musician, agent]) expect((await suggest({}, token)).status).toBe(403);
  expect((await t.http('/api/autoconfig/suggestions', { body: { serverId: t.server.core.serverId, scope: 'PA' } })).status).toBe(401);
  for (const body of [{ deltaDB: 1 }, { approved: true }, { diagnosticSession: {} }, { observations: { verified: true } }, { externalConsent: true }, { scope: 'REAL' }]) expect((await suggest(body)).status).toBe(400);
  expect((await suggest({ serverId: 'wrong-server' })).status).toBe(409);
  const wrongOrigin = await fetch(t.base + '/api/autoconfig/suggestions', { method: 'POST', headers: { authorization: `Bearer ${op}`, origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ serverId: t.server.core.serverId, scope: 'PA' }) }); expect(wrongOrigin.status).toBe(403);
  await m1(t, op, 'Fred está microfonando no retorno'); const question = (await suggest()).json.advice; expect(question.question.field).toBe('feedback');
  const stopped = await suggest({ answer: { inputFingerprint: question.inputFingerprint, value: 'active' } }); expect(stopped.json.advice).toMatchObject({ kind: 'refusal', reason: 'safety_stop' }); expect(stopped.json.proposal).toBeNull();
  await t.http('/api/logout', { token: op, body: {} }); expect((await suggest()).status).toBe(401);
  const mock = await boot({ mode: 'mock' }); expect((await mock.suggest()).status).toBe(404);
});
it('fonte implementa AutoConfigSuggestionSource sem criar delta ou reinterpretar a inspeção como ajuste', async () => {
  const { t } = await boot(); const input = autoConfigCases[0]!.input;
  const source: AutoConfigSuggestionSource = new ConsultativeSuggestionSource(new TechnicalPlanner({ knowledge: bandKnowledgeAdapter(t.controller.names), policy: () => ({ enabled: true, active: true, selected: 'ollama', externalConsent: false, revision: 1 }) }), input, 'PA');
  const result = await source.propose({ scope: 'PA' }); expect(result.items).toHaveLength(1); expect(result.items[0]!.deltaDB).toBeUndefined(); expect(result.items[0]!.rationale).toContain('não recomendação de alterar nível');
});

const selectedJSON = JSON.stringify({ kind: 'proposal', candidate: 's1', evidence: ['e1'] });
async function modeled(extra: { defer?: boolean; quota?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-advisor-model-')), requests: Array<{ url: string; body: any }> = [];
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(r => { started = r; });
  const fetchFn: typeof fetch = async (url, init) => {
    const address = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ url: address, body });
    if (address.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    if (address.endsWith('/api/chat')) return new Response(JSON.stringify({ message: { content: selectedJSON }, done_reason: 'stop' }));
    if (address.includes(':generateContent')) {
      started(); if (extra.defer) await new Promise<void>(r => { release = r; });
      if (extra.quota) return new Response('{}', { status: 429 });
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: selectedJSON }] } }] }));
    }
    return new Response('{}'); // explicit provider health checks, fake HTTP only
  };
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json')); await store.init();
  const knowledge = new LocalKnowledge({ store, seedDir: join(PROJECT_ROOT, 'knowledge/seed/banda-v1_2'), inboxDir: join(dir, 'inbox'), narrative: false, maxPassages: 3, maxDocumentBytes: 100000,
    chatProviders: [new OllamaClient({ url: 'http://127.0.0.1:11434', chatModel: 'qwen3:8b', embedModel: 'unused', embedDimensions: 8, timeoutMs: 1000 }, fetchFn),
      new GeminiClient({ chatModel: 'gemini-fixture', embedModel: 'embed-fixture', embedDimensions: 8, timeoutMs: 1000 }, 'fake-not-a-real-gemini-key', fetchFn)] });
  await knowledge.importSeed();
  const s = await boot({ dir, knowledge, knowledgeConfig: { enabled: true, ollama: { narrative: true, chatModel: 'qwen3:8b' }, gemini: { enabled: true } }, geminiApiKey: 'fake-not-a-real-gemini-key', autoConfigPlannerFetch: fetchFn, autoConfigPlannerGeminiFetch: fetchFn });
  await m1(s.t, s.op);
  const select = (chat: string, confirmed = false, token = s.op) => s.t.http('/api/knowledge/providers', { token, body: { chat, confirmExternal: confirmed } });
  return { ...s, requests, select, waiting, release: () => release() };
}
it('Gemini e Qwen usam seleção existente; consentimento é explícito por sessão e payload não leva dados privados', async () => {
  const s = await modeled();
  expect((await s.suggest()).json.advice.provider.used).toBe('ollama'); expect(s.requests.some(r => r.url.includes(':generateContent'))).toBe(false);
  expect((await s.select('gemini')).status).toBe(400);
  expect((await s.select('gemini', true)).status).toBe(200);
  const r = await s.suggest({ report: 'segredo fictício, IP de documentação 192.0.2.10 e C:\\dados\\arquivo' }); expect(r.json.advice.provider.used).toBe('gemini'); expect(r.json.proposal.items[0].deltaDB).toBeUndefined();
  const other = await s.t.login(OPERATOR_PIN); await m1(s.t, other);
  expect((await s.suggest({}, other)).json.advice.provider.used).toBe('ollama'); // selection is global, external grant is NOT
  expect((await s.select('ollama')).status).toBe(200); expect((await s.suggest()).json.advice.provider.used).toBe('ollama');
  const calls = s.requests.filter(r => r.body).map(r => JSON.stringify(r.body)).join(' ');
  expect(calls).not.toMatch(/Fred|Lucius|Fernando|192\.0\.2\.10|dados|arquivo|segredo|tool_choice|"tools"/);
  expect(s.requests.find(r => r.url.endsWith('/api/chat'))!.body.model).toBe('qwen3:8b');
  const audits = s.t.server.app.log.recent(100).filter(e => e.action === 'autoconfig_advice'); expect(audits.length).toBeGreaterThan(0); expect(JSON.stringify(audits)).not.toContain('segredo');
});
it('quota Gemini usa Qwen sem alterar o port D nem inserir número', async () => {
  const s = await modeled({ quota: true }); await s.select('gemini', true);
  const r = await s.suggest(); expect(r.status).toBe(200); expect(r.json.advice.provider.used).toBe('ollama');
  expect(r.json.advice.provider.attempts.map((a: any) => a.status)).toEqual(['quota', 'used']); expect(r.json.proposal.items[0].deltaDB).toBeUndefined();
});
it.each(['logout', 'm1', 'consent', 'connection'] as const)('resposta tardia após %s é descartada; nenhuma aprovação, número ou simulação aparece', async change => {
  const s = await modeled({ defer: true }); await s.select('gemini', true);
  const pending = s.suggest(); await s.waiting;
  expect((await s.suggest()).status).toBe(409); // one in-flight request per principal
  if (change === 'logout') await s.t.http('/api/logout', { token: s.op, body: {} });
  if (change === 'm1') await m1(s.t, s.op, 'Na verdade, só no PA');
  if (change === 'consent') await s.select('ollama');
  if (change === 'connection') await s.t.mixer.disconnect();
  s.release(); const r = await pending; expect([401, 409]).toContain(r.status);
  expect(JSON.stringify(r.json)).not.toContain('items');
  if (change !== 'logout') expect((await s.t.http('/api/autoconfig', { token: s.op })).json.plans).toEqual([]);
});
