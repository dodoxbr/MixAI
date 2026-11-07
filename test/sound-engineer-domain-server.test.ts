import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { paramKey } from '../src/core/revisions.js';
import { MockMixer } from '../src/mixer/mock.js';
import { RealMixer } from '../src/mixer/real.js';
import { MASTER } from '../src/mixer/types.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(t => t.server.close())); vi.restoreAllMocks(); });
async function start() {
  const aiFetch = vi.fn(async () => { throw new Error('External AI unavailable'); });
  const t = await startTestServer({ mode: 'mock', ai: { enabled: true }, aiKey: 'test', aiFetch,
    channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))) });
  servers.push(t); return { t, aiFetch };
}
it('queixas novas via HTTP/WS continuam offline, sem proposta, escrita ou aprovação', async () => {
  const { t, aiFetch } = await start(), token = await t.login(OPERATOR_PIN);
  const before = t.controller.state.snapshot(), write = vi.spyOn(RealMixer.prototype, 'write');
  const execute = vi.spyOn(t.server.core, 'execute'), build = vi.spyOn(t.server.core.assistant!.builder, 'build');
  const c = await wsClient(t.base, token);
  try {
    await c.next(m => m.type === 'snapshot'); let i = 0;
    for (const text of ['Fred está microfonando no PA', 'O pandeiro está estridente nos fones', 'O surdo está magro no PA', 'O violão está com chiado nos fones', 'Fred está sibilante no PA', 'O cavaco está clipando no PA']) {
      const http = await t.http('/api/assistant/conversation', { token, body: { text } });
      expect(http.status).toBe(200);
      const requestId = `knowledge-${++i}`; c.send({ type: 'assistant', requestId, text });
      const ws = (await c.next(m => m.type === 'assistant_reply' && m.requestId === requestId)).reply;
      expect(ws).toEqual(http.json.reply);
      expect(ws.diagnosis.consultation.authorizedActions).toEqual([]);
      expect(ws.diagnosis.consultation.proposal).toBeNull(); expect(ws.proposals).toBeUndefined();
      c.send({ type: 'proposal_apply', requestId: `forged-${i}`, proposalId: ws.diagnosis.hypotheses[0].id });
      expect((await c.next(m => m.type === 'proposal_result')).status).toBe('not_found');
    }
    expect(aiFetch).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled(); expect((t.mixer as MockMixer).writes).toEqual([]);
    expect(t.controller.state.snapshot()).toEqual(before);
    expect((await t.http('/api/pending', { token })).json.items).toEqual([]);
  } finally { c.close(); }
});
it('mudança externa simulada e estado antigo nunca são restaurados ou disputados pelo diagnóstico', async () => {
  const { t } = await start(), token = await t.login(OPERATOR_PIN), mixer = t.mixer as MockMixer;
  const key = paramKey.level(3, MASTER);
  mixer.simulateExternalChange(key, -12);
  const payload = { symptom: 'desequilibrio', channel: 3, destination: 'pa', evidence: [
    { id: 'human', kind: 'operator_report', symptom: 'desequilibrio', detail: 'Fred está sumindo com o coro.' },
    { id: 'stale', kind: 'control_state', parameter: key, value: -4, revision: 1, observedAt: '2020-01-01T00:00:00Z', detail: 'Referência velha declarada; não leitura atual.' },
  ] };
  const queries = Array.from({ length: 3 }, () => t.http('/api/assistant/diagnose', { token, body: payload }));
  mixer.simulateExternalChange(key, -9);
  for (const reply of await Promise.all(queries)) {
    expect(reply.status).toBe(200);
    expect(reply.json.reply.diagnosis.consultation.evidence.controlReadings[0].verification).toBe('caller_declared_not_verified');
    expect(reply.json.reply.diagnosis.consultation.authorizedActions).toEqual([]);
    expect(reply.json.reply.diagnosticSession.evidence.controlReadings[0].evidence.observedAt).toBe('2020-01-01T00:00:00Z');
    expect(reply.json.reply.text).not.toContain('2020-01-01');
  }
  expect(await mixer.read(key)).toEqual({ known: true, value: -9 }); expect(mixer.writes).toEqual([]);
});
it('pedidos críticos, dados de espectro forjados e sessão revogada não geram ação', async () => {
  const { t, aiFetch } = await start(), token = await t.login(OPERATOR_PIN);
  for (const text of ['Qual phantom usar no microfone Fred no PA?', 'Como configurar AFS2 no PA?', 'Qual ganho usar no violão no PA?']) {
    const reply = await t.http('/api/assistant/conversation', { token, body: { text } });
    expect(reply.status).toBe(200); expect(reply.json.reply.proposals).toBeUndefined();
    expect(reply.json.reply.diagnosis.consultation.proposal).toBeNull();
  }
  const invalid = await t.http('/api/assistant/diagnose', { token, body: { symptom: 'microfonia', channel: 3, destination: 'pa',
    evidence: [{ id: 'fake', kind: 'real_rta', detail: 'Frequency detected' }], approval: true } });
  expect(invalid.status).toBe(400);
  const musician = await t.login(MUSICIAN_PIN);
  expect((await t.http('/api/assistant/conversation', { token: musician, body: { text: 'Fred está microfonando no PA' } })).status).toBe(403);
  await t.http('/api/logout', { token, body: {} });
  expect((await t.http('/api/assistant/conversation', { token, body: { text: 'Fred está microfonando no PA' } })).status).toBe(401);
  expect(aiFetch).not.toHaveBeenCalled(); expect((t.mixer as MockMixer).writes).toEqual([]);
});
