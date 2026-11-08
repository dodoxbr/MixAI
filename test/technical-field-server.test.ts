import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { instructorGuidanceSchema, instructorProcedureSchema } from '../src/knowledge/sound-engineer/index.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { RealMixer } from '../src/mixer/real.js';
import { MockMixer } from '../src/mixer/mock.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer } from './server-support.js';
const instances: Awaited<ReturnType<typeof startTestServer>>[] = [];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(t => t.server.close())); dirs.splice(0).forEach(d => rmSync(d, { force: true, recursive: true })); vi.restoreAllMocks(); });
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-field-http-')); dirs.push(dir);
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json')); await store.init();
  const knowledge = new LocalKnowledge({ store, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge/seed/banda-v1_2'), maxDocumentBytes: 100000, maxPassages: 4, narrative: false });
  await knowledge.importSeed(); await knowledge.importTechnical();
  const t = await startTestServer({ mode: 'mock', knowledge, dir, channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))) });
  instances.push(t); return t;
}
const input = { symptom: 'magro', instrument: 'surdo', channel: 8, destination: 'pa', evidence: [{ kind: 'operator_report', id: 'report', symptom: 'magro', detail: 'Sem grave, causa não validada.' }] };
it('API existente e Instrutor consultam dados tipados, sem builder/execute/propostas ou writes', async () => {
  const t = await boot(), token = await t.login(OPERATOR_PIN);
  const before = t.controller.state.snapshot();
  const execute = vi.spyOn(t.server.core, 'execute'), builder = vi.spyOn(t.server.core.assistant!.builder, 'build'), write = vi.spyOn(RealMixer.prototype, 'write');
  const catalog = await t.http('/api/knowledge/procedures', { token }); expect(catalog.status).toBe(200);
  catalog.json.procedures.forEach((p: unknown) => expect(instructorProcedureSchema.safeParse(p).success).toBe(true));
  const query = await t.http('/api/knowledge/procedures/query', { token, body: input }); expect(query.status).toBe(200);
  expect(instructorGuidanceSchema.parse(query.json).procedures.map(p => p.id)).toContain('surdo-body');
  const diagnosis = await t.http('/api/assistant/diagnose', { token, body: input }); expect(diagnosis.status).toBe(200);
  expect(diagnosis.json.reply.technicalDetails.instructor).toEqual(query.json);
  const chat = await t.http('/api/assistant/conversation', { token, body: { text: 'O surdo tá sem grave no PA' } });
  expect(chat.status).toBe(200); expect(chat.json.reply.diagnosticSession.knownContext).toMatchObject({ channel: 8, symptom: 'magro', destination: 'pa' });
  expect(chat.json.reply.text.split(/\s+/).length).toBeLessThanOrEqual(120);
  expect((await t.http('/api/pending', { token })).json.items).toEqual([]);
  expect(execute).not.toHaveBeenCalled(); expect(builder).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect((t.mixer as MockMixer).writes).toEqual([]); expect(t.controller.state.snapshot()).toEqual(before);
});
it('rota do Instrutor mantém permissões, origem, logout, payload estrito e não autoriza aplicação', async () => {
  const t = await boot(), token = await t.login(OPERATOR_PIN), music = await t.login(MUSICIAN_PIN);
  const agent = readFileSync(join(t.dir, 'agent-mock.token'), 'utf8');
  for (const unauthorized of [music, agent]) {
    expect((await t.http('/api/knowledge/procedures', { token: unauthorized })).status).toBe(403);
    expect((await t.http('/api/knowledge/procedures/query', { token: unauthorized, body: input })).status).toBe(403);
  }
  expect((await t.http('/api/knowledge/procedures/query', { body: input })).status).toBe(401);
  expect((await t.http('/api/knowledge/procedures/query', { token, body: { ...input, command: 'apply' } })).status).toBe(400);
  expect((await t.http('/api/knowledge/procedures/query', { token, body: { ...input, evidence: [{ kind: 'rta', frequency: 1000 }] } })).status).toBe(400);
  const external = await fetch(t.base + '/api/knowledge/procedures/query', { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://external.invalid', 'content-type': 'application/json' }, body: JSON.stringify(input) });
  expect(external.status).toBe(403);
  const noEvidence = await t.http('/api/knowledge/procedures/query', { token, body: { ...input, evidence: [] } }); expect(noEvidence.status).toBe(200); expect(noEvidence.json.procedures).toEqual([]);
  await t.http('/api/logout', { token, body: {} }); expect((await t.http('/api/knowledge/procedures', { token })).status).toBe(401);
  expect((t.mixer as MockMixer).writes).toEqual([]);
});
