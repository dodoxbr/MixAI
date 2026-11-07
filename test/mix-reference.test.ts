import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startTestServer, OPERATOR_PIN, MUSICIAN_PIN } from './server-support.js';
import { ReferenceStore } from '../src/reference/store.js';
import { ReferenceService } from '../src/reference/service.js';
import { SceneStore } from '../src/core/scene-store.js';
import { deviceProfileOf } from '../src/core/scene.js';
import type { ReferencePorts } from '../src/reference/contracts.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { parse } from 'yaml';
import type { ParamKey, ParamValue } from '../src/core/revisions.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const t of servers.splice(0)) await t.server.close(); });
async function boot(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer({ channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), ...opts }); servers.push(t);
  const op = await t.login(OPERATOR_PIN); const music = await t.login(MUSICIAN_PIN);
  const base = { serverId: t.server.core.serverId };
  const view = async (token = op) => (await t.http('/api/reference-workspace', { token })).json;
  const capture = (extra: Record<string, unknown> = {}, token = op) => t.http('/api/mix-references', { token, body: { ...base, eventId: 'event-test', eventName: 'Passagem LAB', eventDate: '2026-11-07', scope: 'PA', expectedVersion: 0, expectedStateRevision: t.server.core.snapshotFor('operator').revision, operatorApproved: true, ...extra } });
  const create = (extra: Record<string, unknown> = {}, token = music) => t.http('/api/mix-requests', { token, body: { ...base, requestId: randomUUID(), type: 'mix_geral', report: 'O pandeiro está alto no retorno', channel: 9, destination: 'AUX1', ...extra } });
  const decide = (request: Record<string, any>, state = 'suggested', extra: Record<string, unknown> = {}) => t.http(`/api/mix-requests/${request.id}/decide`, { token: op, body: { ...base, expectedVersion: request.version, expectedStateRevision: t.server.core.snapshotFor('operator').revision, state, response: 'Orientação teórica, avaliar por ouvido; não aplicar automaticamente.', ...extra } });
  return { t, op, music, base, view, capture, create, decide };
}
async function external(t: Awaited<ReturnType<typeof startTestServer>>, key: ParamKey, value: ParamValue) {
  // Test-only observer notification on LAB, equivalent to the existing MockMixer external fixture.
  await t.mixer.write(key, value);
  (t.mixer as unknown as { emitChange(k: ParamKey, v: ParamValue, origin: string): void }).emitChange(key, value, 'external');
}
it('saves approved E5 LAB reference, preserves unknowns and compares read-only with delta current minus reference', async () => {
  const s = await boot(); const execute = vi.spyOn(s.t.server.core, 'execute'); const write = vi.spyOn(s.t.mixer, 'write');
  const result = await s.capture(); expect(result.status).toBe(200); const ref = result.json;
  expect(ref).toMatchObject({ version: 1, scope: 'PA', validationStatus: 'UNVERIFIED', source: { mode: 'lab' }, scene: { kind: 'mixai-scene', schemaVersion: 2 }, approvedBy: { role: 'operator' } });
  expect(ref.operatorApprovedAt).toBeTruthy(); expect(existsSync(join(s.t.dir, 'scenes', `${ref.scene.id}.json`))).toBe(true);
  expect(write).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  const before = ref.observations['ch.3.main.level'].value;
  await external(s.t, 'ch.3.main.level', before - 4); await external(s.t, 'master.level', -8);
  const changes = await s.t.http(`/api/mix-references/${ref.id}/compare`, { token: s.op });
  expect(changes.json.rows.find((r: any) => r.key === 'ch.3.main.level')).toMatchObject({ delta: -4, changed: true, relevant: true });
  expect(changes.json.rows.some((r: any) => r.key === 'master.level' && r.changed)).toBe(true);
  expect(s.t.mixer.read('ch.3.main.level')).toMatchObject({ value: before - 4 });
  expect((await s.capture({ expectedVersion: 1 })).json.version).toBe(2);
  const aux = await s.capture({ scope: 'AUX1' }); expect(aux.json.scope).toBe('AUX1');
  expect(Object.keys(aux.json.observations).every(k => k.includes('.aux.1.'))).toBe(true);
});
it('authorizes roles, revocation, mode and denies impersonation/forged apply or extra fields', async () => {
  const s = await boot();
  expect((await s.t.http('/api/reference-workspace')).status).toBe(401);
  expect((await s.capture({}, s.music)).status).toBe(403);
  expect((await s.view(s.music)).references).toEqual([]);
  expect((await s.create({ requestedBy: { verified: true, musicianId: 'fake' } })).status).toBe(400);
  const req = (await s.create()).json;
  expect((await s.t.http(`/api/mix-requests/${req.id}/decide`, { token: s.music, body: { ...s.base, expectedVersion: 1, expectedStateRevision: 0, state: 'approved', response: 'fake' } })).status).toBe(403);
  expect((await s.decide(req, 'applied')).status).toBe(400);
  await s.t.http('/api/logout', { token: s.op, body: {} }); expect((await s.view()).result.code).toBe('UNAUTHORIZED');
  const mock = await boot({ mode: 'mock' }); expect((await mock.t.http('/api/reference-workspace', { token: mock.op })).status).toBe(404);
  const service = new ReferenceService(new ReferenceStore(join(s.t.dir, 'unused.json')), { mode: 'real', serverId: 'none', snapshot: () => { throw new Error('must not read'); }, channels: () => [], device: { model: 'ui16', inputs: 12, aux: 6 }, scenes: {} as SceneStore, supports: () => false, active: () => true });
  expect(() => service.view({ id: 'session', role: 'operator', label: 'operator' })).toThrow('MODE_MISMATCH');
});
it('enforces capture CAS, server/state revisions and explicit approval; reference versions remain immutable', async () => {
  const s = await boot();
  expect((await s.capture({ operatorApproved: false })).status).toBe(400);
  expect((await s.capture({ serverId: 'old-server' })).status).toBe(409);
  expect((await s.capture({ expectedStateRevision: 999999 })).status).toBe(409);
  const results = await Promise.all([s.capture(), s.capture()]); expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  const old = results.find(r => r.status === 200)!.json;
  expect((await s.capture({ expectedVersion: 1 })).json.version).toBe(2);
  const document = JSON.parse(readFileSync(join(s.t.dir, 'mix-reference-requests.json'), 'utf8'));
  expect(document.references[0]).toEqual(old); expect(document.references[1].history).toHaveLength(2);
  const file = join(s.t.dir, 'mix-reference-requests.json'); expect(existsSync(`${file}.bak`)).toBe(true);
});
it('isolates multiple musician sessions, sanitizes, deduplicates and refuses stale approvals after observed changes', async () => {
  const s = await boot(); const other = await s.t.login(MUSICIAN_PIN);
  const requestId = randomUUID();
  const [a, b] = await Promise.all([s.create({ requestId, report: '<script>nunca executar</script>' }), s.create({}, other)]);
  expect(a.status).toBe(200); expect(b.status).toBe(200); expect((await s.view()).requests).toHaveLength(2);
  expect((await s.view(s.music)).requests).toHaveLength(1); expect((await s.view(other)).requests).toHaveLength(1);
  expect((await s.create({ requestId, report: '<script>nunca executar</script>' })).json.id).toBe(a.json.id);
  expect((await s.create({ requestId, report: 'mudou' })).status).toBe(409);
  expect((await s.t.http(`/api/mix-requests/${a.json.id}/cancel`, { token: other, body: { ...s.base, expectedVersion: 1 } })).status).toBe(404);
  expect((await s.create({ report: 'linha\ncontrole' })).status).toBe(400);
  const suggested = (await s.decide(a.json)).json;
  await external(s.t, 'ch.1.main.level', -18);
  expect((await s.decide(suggested, 'approved')).status).toBe(409);
  const evaluated = (await s.decide(suggested, 'suggested')).json;
  const approval = await s.decide(evaluated, 'approved'); expect(approval.status).toBe(200);
  expect((await s.decide(evaluated, 'approved')).status).toBe(409);
  expect((await s.t.http(`/api/mix-requests/${approval.json.id}/cancel`, { token: s.music, body: { ...s.base, expectedVersion: approval.json.version } })).json.state).toBe('cancelled');
});
it('persists across restart, does not infer identity from PIN and protects old unlinked session requests', async () => {
  const s = await boot(); const ref = (await s.capture()).json; const own = (await s.create({ type: 'meu_canal' })).json;
  expect(own.requestedBy.verified).toBe(false); expect(own.state).toBe('needs_information');
  await s.t.server.close(); const again = await boot({ dir: s.t.dir });
  expect((await again.view()).references[0].id).toBe(ref.id);
  expect((await again.view()).requests[0].id).toBe(own.id);
  expect((await again.view(again.music)).requests).toHaveLength(0);
  const reply = await again.t.http(`/api/mix-requests/${own.id}/reply`, { token: again.op, body: { ...s.base, expectedVersion: own.version, text: 'stale' } }); expect(reply.status).toBe(409);
});
it('marks unknown/unavailable states, never invents values or restores after lost connection', async () => {
  const s = await boot(); const realRead = s.t.mixer.read.bind(s.t.mixer);
  vi.spyOn(s.t.mixer, 'read').mockImplementation(key => key === 'ch.4.main.level' ? { known: false } : realRead(key));
  const ref = (await s.capture()).json;
  expect(ref.observations['ch.4.main.level'].status).toBe('unknown'); expect(ref.scene.params['ch.4.main.level']).toBeUndefined();
  const write = vi.spyOn(s.t.mixer, 'write'); await s.t.mixer.disconnect();
  const compare = await s.t.http(`/api/mix-references/${ref.id}/compare`, { token: s.op });
  expect(compare.json.available).toBe(false); expect(compare.json.rows.every((r: any) => r.stale && r.delta === null)).toBe(true);
  expect((await s.capture({ expectedVersion: 1 })).status).toBe(409); expect(write).not.toHaveBeenCalled();
});
it('fails closed on corrupted storage, preserves primary/backup and enforces CAS across store instances', async () => {
  const s = await boot(); await s.capture(); await s.create(); const file = join(s.t.dir, 'mix-reference-requests.json');
  const a = new ReferenceStore(file); const b = new ReferenceStore(file); const current = a.read(); a.commit(current, current.revision);
  expect(() => b.commit(current, current.revision)).toThrow('CONFLICT');
  const backup = readFileSync(`${file}.bak`, 'utf8'); writeFileSync(file, '{corrupt');
  expect((await s.t.http('/api/reference-workspace', { token: s.op })).status).toBe(503);
  expect(readFileSync(file, 'utf8')).toBe('{corrupt'); expect(readFileSync(`${file}.bak`, 'utf8')).toBe(backup);
});
it('expires requests with persisted audit and keeps diagnosis optional, bounded to advice, never commands', async () => {
  const s = await boot(); const request = (await s.create()).json;
  expect((await s.t.http(`/api/mix-requests/${request.id}/assess`, { token: s.op, body: { ...s.base, expectedVersion: 1, expectedStateRevision: s.t.server.core.snapshotFor('operator').revision } })).status).toBe(503);
  s.t.clock.advance(600001); expect((await s.view()).requests[0].state).toBe('expired');
  const detail = await s.t.http(`/api/mix-requests/${request.id}`, { token: s.music }); expect(detail.json.history.at(-1).action).toBe('expired');
  expect((await s.decide({ id: request.id, version: 2 }, 'approved')).status).toBe(409);
});
it('integrates trusted identity/diagnosis ports without granting command permissions or accepting stale asynchronous advice', async () => {
  let done!: (value: any) => void; let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
  const ports: ReferencePorts = { identity: { resolve: () => ({ verified: true, musicianId: 'musician-test', displayName: 'Músico teste', channel: 1 }) }, recommendations: { recommend: async () => { ready(); return new Promise(r => { done = r; }); } } };
  const s = await boot({ referencePorts: ports });
  expect((await s.create({ type: 'meu_canal', channel: 9 })).status).toBe(403);
  const request = (await s.create({ type: 'meu_canal', channel: 1 })).json; expect(request.requestedBy.verified).toBe(true);
  const pending = s.t.http(`/api/mix-requests/${request.id}/assess`, { token: s.op, body: { ...s.base, expectedVersion: 1, expectedStateRevision: s.t.server.core.snapshotFor('operator').revision } });
  await started; await external(s.t, 'ch.1.main.level', -20); done({ text: 'Orientação sem ação', source: 'diagnosis' });
  expect((await pending).status).toBe(409);
  expect((await s.view()).requests[0].version).toBe(1);
});
it('records trusted advice as data only and rejects forged recommendations', async () => {
  let response: any = { source: 'diagnosis', text: 'Inspecionar por ouvido sem inferir microfonia medida.', references: ['https://www.soundcraft.com/'] };
  const s = await boot({ referencePorts: { recommendations: { recommend: async () => response } } });
  const request = (await s.create()).json; const execute = vi.spyOn(s.t.server.core, 'execute'); const write = vi.spyOn(s.t.mixer, 'write');
  const assess = () => s.t.http(`/api/mix-requests/${request.id}/assess`, { token: s.op, body: { ...s.base, expectedVersion: 1, expectedStateRevision: s.t.server.core.snapshotFor('operator').revision } });
  response = { ...response, command: { type: 'set_master' } }; expect((await assess()).status).toBe(400);
  delete response.command; response.references = ['javascript:alert(1)']; expect((await assess()).status).toBe(400);
  response.references = []; const r = await assess(); expect(r.status).toBe(200); expect(r.json.recommendation.source).toBe('diagnosis');
  expect(execute).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
it('discards diagnosis completing after operator session revocation without persisting a decision', async () => {
  let done!: (value: any) => void; let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
  const s = await boot({ referencePorts: { recommendations: { recommend: async () => { ready(); return new Promise(r => { done = r; }); } } } });
  const request = (await s.create()).json;
  const pending = s.t.http(`/api/mix-requests/${request.id}/assess`, { token: s.op, body: { ...s.base, expectedVersion: 1, expectedStateRevision: s.t.server.core.snapshotFor('operator').revision } });
  await started; await s.t.http('/api/logout', { token: s.op, body: {} });
  done({ source: 'diagnosis', text: 'Não aplicar nenhum ajuste.' }); expect((await pending).status).toBe(401);
  const replacement = await s.t.login(OPERATOR_PIN); expect((await s.view(replacement)).requests[0]).toMatchObject({ version: 1, state: 'received' });
});
