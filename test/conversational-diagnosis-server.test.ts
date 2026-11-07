import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { CONTEXT_TTL_MS } from '../src/assistant/diagnostic-context.js';
import { consult, recommendationFromDiagnostic } from '../src/assistant/sound-engineer.js';
import { MockMixer } from '../src/mixer/mock.js';
import { RealMixer } from '../src/mixer/real.js';
import { paramKey } from '../src/core/revisions.js';
import { MASTER } from '../src/mixer/types.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
const clients: Array<{ close(): void }> = [];
afterEach(async () => { clients.splice(0).forEach(c => c.close()); await Promise.all(servers.splice(0).map(s => s.server.close())); vi.restoreAllMocks(); });
async function start() {
  const aiFetch = vi.fn(async () => { throw new Error('No external AI'); });
  const t = await startTestServer({ mode: 'mock', channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), ai: { enabled: true }, aiKey: 'test', aiFetch });
  servers.push(t); return { t, aiFetch };
}
const stamp = (reply: any) => ({ id: reply.diagnosticContext.id, revision: reply.diagnosticContext.revision });
const endpoint = '/api/assistant/conversation';
it('HTTP e WS compartilham etapas curtas com a UI existente; zero builder/execute/write/AI', async () => {
  const { t, aiFetch } = await start(), token = await t.login(OPERATOR_PIN);
  const before = t.controller.state.snapshot(), execute = vi.spyOn(t.server.core, 'execute'), build = vi.spyOn(t.server.core.assistant!.builder, 'build');
  const realWrite = vi.spyOn(RealMixer.prototype, 'write');
  let r = (await t.http(endpoint, { token, body: { text: 'Minha voz está abafada no retorno' } })).json.reply;
  expect(r.diagnosticOptions.map((c: any) => c.label)).toEqual(['Voz Fred', 'Voz Lucius', 'Voz Leandro', 'Voz Fernando', 'Voz Laviquinho']);
  const c = await wsClient(t.base, token); clients.push(c); await c.next(m => m.type === 'snapshot');
  let seq = 0;
  for (const text of ['Fred', 'Só no retorno', 'Só com a banda', 'Sem mudança', 'Melhorou']) {
    const requestId = `conversation-${++seq}`;
    c.send({ type: 'assistant_conversation', requestId, input: { text, context: stamp(r) } });
    r = (await c.next(m => m.type === 'assistant_reply' && m.requestId === requestId)).reply;
    expect(r.kind).toBe('diagnosis'); expect(r.text.split(/\s+/).length).toBeLessThanOrEqual(120);
    expect(r.diagnosticSession.knownContext.channel).toBe(3); expect(r.diagnosticSession.knownContext.destination).toBe('fones');
    expect(r.diagnosis.consultation.proposal).toBeNull(); expect(r.proposals).toBeUndefined();
  }
  expect(r.diagnosticContext).toBeNull(); expect(r.diagnosticSession.status).toBe('complete');
  c.send({ type: 'proposal_apply', requestId: 'forged', proposalId: r.diagnosticSession.sessionId });
  expect((await c.next(m => m.type === 'proposal_result')).status).toBe('not_found');
  expect(execute).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled(); expect(realWrite).not.toHaveBeenCalled(); expect(aiFetch).not.toHaveBeenCalled();
  expect((t.mixer as MockMixer).writes).toEqual([]); expect(t.controller.state.snapshot()).toEqual(before);
  expect((await t.http('/api/pending', { token })).json.items).toEqual([]);
});
it('revisão concorrente, outra sessão e correção de destino não vazam contexto nem repetem fonte', async () => {
  const { t } = await start(), token = await t.login(OPERATOR_PIN), other = await t.login(OPERATOR_PIN);
  const first = (await t.http(endpoint, { token, body: { text: 'Minha voz está abafada no retorno' } })).json.reply;
  expect((await t.http(endpoint, { token: other, body: { text: 'Fred', context: stamp(first) } })).status).toBe(409);
  const [a, b] = await Promise.all(['Fred', 'Leandro'].map(text => t.http(endpoint, { token, body: { text, context: stamp(first) } })));
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const current = (a.status === 200 ? a : b).json.reply;
  const corrected = (await t.http(endpoint, { token, body: { text: 'Na verdade, só no PA', context: stamp(current) } })).json.reply;
  expect(corrected.diagnosticSession.knownContext.channel).toBe(current.diagnosticSession.knownContext.channel);
  expect(corrected.diagnosticSession.knownContext.destination).toBe('pa'); expect(corrected.diagnosticContext.field).toBe('isolation');
  const otherReply = (await t.http(endpoint, { token: other, body: { text: 'PA' } })).json.reply;
  expect(JSON.stringify(otherReply)).not.toMatch(/Voz Fred|Voz Leandro|abafad/);
});
it('revogação/TTL, dados de sessão forjados e comando misturado não geram solicitações', async () => {
  const { t } = await start(), token = await t.login(OPERATOR_PIN);
  const first = (await t.http(endpoint, { token, body: { text: 'Fred está abafado no retorno' } })).json.reply;
  for (const body of [{ text: 'sim', diagnosticSession: first.diagnosticSession }, { text: 'Fred', principalId: 'other' }, { text: 'PA', progress: { scope: 'both' } }, { text: 'sim', approval: true }]) {
    expect((await t.http(endpoint, { token, body })).status).toBe(400);
  }
  expect((await t.http(endpoint, { token, body: { text: 'sobe o Fred no retorno', context: stamp(first) } })).status).toBe(400);
  const musician = await t.login(MUSICIAN_PIN), agent = readFileSync(join(t.dir, 'agent-mock.token'), 'utf8');
  for (const unauthorized of [musician, agent]) expect((await t.http(endpoint, { token: unauthorized, body: { text: 'Fred', context: stamp(first) } })).status).toBe(403);
  t.clock.advance(CONTEXT_TTL_MS); t.server.core.sweep();
  expect((await t.http(endpoint, { token, body: { text: 'Só no retorno', context: stamp(first) } })).status).toBe(409);
  await t.http(endpoint, { token, body: { text: 'Fred está abafado no retorno' } });
  await t.http('/api/logout', { token, body: {} }); expect(t.server.core.assistant!.diagnosticContexts.size).toBe(0);
  expect((await t.http(endpoint, { token, body: { text: 'sim' } })).status).toBe(401);
  expect((t.mixer as MockMixer).writes).toEqual([]);
});
it('mudança externa simulada durante a conversa não é restaurada nem inferida como áudio', async () => {
  const { t } = await start(), token = await t.login(OPERATOR_PIN), mixer = t.mixer as MockMixer;
  const first = (await t.http(endpoint, { token, body: { text: 'Fred está abafado no retorno' } })).json.reply;
  const key = paramKey.level(3, MASTER); mixer.simulateExternalChange(key, -9);
  const next = (await t.http(endpoint, { token, body: { text: 'Só no retorno', context: stamp(first) } })).json.reply;
  expect(next.diagnosticSession.evidence.controlReadings).toEqual([]);
  expect(next.diagnosticSession.safety.observedState).toBe('not_acquired'); expect(mixer.read(key)).toEqual({ known: true, value: -9 }); expect(mixer.writes).toEqual([]);
});
it('adaptador D preserva relato não verificado, é estrutural e não cria pedido ou ação', async () => {
  const { t } = await start();
  const reply = consult({ symptom: 'abafado', channel: 3, destination: 'fones', evidence: [{ id: 'human', kind: 'musician_report', symptom: 'abafado', verification: 'unverified', detail: 'Relato retransmitido.' }] }, t.controller.names, 1);
  const view = recommendationFromDiagnostic(reply);
  expect(view).toMatchObject({ source: 'diagnosis', applicable: false, requiresOperatorReview: true });
  expect(view.diagnosticSession.confidence.basis).toBe('musician_report_only');
  expect(view.diagnosticSession.evidence.reports[0]!.kind).toBe('musician_report');
  expect(reply.diagnosis!.recommendations.every(r => r.kind === 'inspection')).toBe(true);
  expect((t.mixer as MockMixer).writes).toEqual([]);
});
