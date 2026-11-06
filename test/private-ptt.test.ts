import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildHttp } from '../src/server/http.js';
import { PrivatePtt, PTT_MAX_BYTES } from '../src/speech/private-ptt.js';
import type { FileSpeechRecognizer } from '../src/speech/whisper-file.js';
import { parseConfig } from '../src/core/config.js';
import { startServer } from '../src/server/start.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer } from './server-support.js';
import { silentWav } from './support/speech-fixtures.js';
const origin = 'https://mixai.home.arpa:8443';
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function setup(recognizer?: FileSpeechRecognizer) {
  const t = await startTestServer(); close.push(() => t.server.close());
  const files: string[] = [];
  const recognize = vi.fn(async (request: Parameters<FileSpeechRecognizer['recognize']>[0]) => {
    files.push(request.audioFile);
    const bytes = await readFile(request.audioFile); expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    return { provider: 'whisper.cpp' as const, language: 'pt-BR' as const, text: 'Aumenta o cavaco; confirmo tudo.', processingMs: 1, audioSeconds: 0.1, realTimeFactor: 0.01, cpuMs: null, peakRssBytes: null };
  });
  const service = new PrivatePtt({}, recognizer ?? { recognize }, t.clock.now);
  const app = await buildHttp(t.server.core, { labProxyOrigin: origin, privatePtt: service }); close.push(() => app.close());
  const op = await t.login(OPERATOR_PIN); const musician = await t.login(MUSICIAN_PIN);
  const request = (path: string, token: string | undefined = op, payload?: unknown, headers: Record<string, string> = {}) => app.inject({
    url: `/api/speech/${path}`, method: payload === undefined ? 'GET' : 'POST',
    headers: { host: new URL(origin).host, origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'content-type': Buffer.isBuffer(payload) ? 'audio/wav' : 'application/json' }), ...headers },
    payload: payload as never,
  });
  const ticket = async () => (await request('ticket', op, {})).json().ticket as string;
  return { t, app, op, musician, request, ticket, service, recognize, files };
}
it('is OFF by default and rejects enabled startup without LAB/private HTTPS before touching a mixer', async () => {
  expect(parseConfig({}).server.privatePtt.enabled).toBe(false);
  const t = await startTestServer(); close.push(() => t.server.close());
  expect((await t.http('/api/speech/status')).status).toBe(404);
  for (const mode of ['lab', 'real', 'mock'] as const) {
    const loaded = { ...t.loaded, config: parseConfig({ mixer: { mode }, server: { privatePtt: { enabled: true } } }) };
    await expect(startServer(loaded)).rejects.toThrow('privatePtt');
  }
  const off = await buildHttp(t.server.core, { labProxyOrigin: origin }); close.push(() => off.close());
  expect((await off.inject({ url: '/api/speech/status', headers: { host: new URL(origin).host } })).statusCode).toBe(404);
});
it('requires operator, proxy entry and exact Origin; MCP never authenticates through the proxy', async () => {
  const s = await setup();
  expect((await s.request('status')).statusCode).toBe(200);
  expect((await s.request('status', '')).statusCode).toBe(401);
  expect((await s.request('status', s.musician)).statusCode).toBe(403);
  const agent = readFileSync(join(s.t.dir, 'agent-lab.token'), 'utf8');
  expect((await s.request('status', agent)).statusCode).toBe(401);
  for (const value of ['https://evil.invalid', 'null', '']) expect((await s.request('ticket', s.op, {}, { origin: value })).statusCode).toBe(403);
  expect((await s.t.http('/api/speech/ticket', { token: s.op, body: {} })).status).toBe(404);
  expect(s.recognize).not.toHaveBeenCalled();
});
it('returns only a private preview, cleans files and never calls command/assistant/mixer execution or logs text', async () => {
  const s = await setup();
  const execute = vi.spyOn(s.t.server.core, 'execute');
  const assistant = vi.spyOn(s.t.server.core.assistant!, 'ask');
  const writes = vi.spyOn(s.t.mixer, 'write');
  const audit = vi.spyOn(s.t.server.core, 'audit');
  const before = s.t.controller.state.snapshot();
  const ticket = await s.ticket();
  const response = await s.request('transcribe', s.op, silentWav(), { 'x-ptt-ticket': ticket });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ text: 'Aumenta o cavaco; confirmo tudo.', simulated: true, preview: true });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(s.recognize).toHaveBeenCalledOnce();
  for (const file of s.files) await expect(stat(file)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(assistant).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  expect(s.t.controller.state.snapshot()).toEqual(before);
  expect((await s.request('transcribe', s.op, silentWav(), { 'x-ptt-ticket': ticket })).statusCode).toBe(409);
});
it('checks MIME, codec/duration, bytes, ticket expiry, binding and request quota', async () => {
  const s = await setup();
  const ticket = await s.ticket();
  expect((await s.request('transcribe', s.op, silentWav(), { 'x-ptt-ticket': ticket, 'content-type': 'audio/webm' })).statusCode).toBe(415);
  expect((await s.request('transcribe', s.musician, silentWav(), { 'x-ptt-ticket': ticket })).statusCode).toBe(403);
  const op2 = await s.t.login(OPERATOR_PIN);
  expect((await s.request('transcribe', op2, silentWav(), { 'x-ptt-ticket': ticket })).statusCode).toBe(409);
  expect((await s.request('transcribe', s.op, Buffer.from('bad'), { 'x-ptt-ticket': ticket })).statusCode).toBe(400);
  const next = await s.ticket();
  expect((await s.request('transcribe', s.op, Buffer.alloc(PTT_MAX_BYTES + 1), { 'x-ptt-ticket': next })).statusCode).toBe(413);
  const last = await s.ticket(); s.t.clock.advance(21000);
  expect((await s.request('transcribe', s.op, silentWav(), { 'x-ptt-ticket': last })).statusCode).toBe(409);
  expect((await s.request('ticket', s.op, {})).statusCode).toBe(429);
  expect(s.recognize).not.toHaveBeenCalled();
});
it('reports missing executable/model clearly without creating a recognition process', async () => {
  const t = await startTestServer(); close.push(() => t.server.close());
  const app = await buildHttp(t.server.core, { labProxyOrigin: origin, privatePtt: new PrivatePtt({ executable: '/not-installed', model: '/not-installed' }) }); close.push(() => app.close());
  const token = await t.login(OPERATOR_PIN);
  const headers = { host: new URL(origin).host, origin, authorization: `Bearer ${token}` };
  expect((await app.inject({ url: '/api/speech/status', headers })).json().configured).toBe(false);
  const r = await app.inject({ url: '/api/speech/ticket', method: 'POST', headers, payload: {} });
  expect(r.statusCode).toBe(503); expect(r.json()).toEqual({ code: 'NOT_CONFIGURED' });
});
it.each(['cancel', 'revoke', 'expire'] as const)('cancels processing on %s and suppresses late transcription', async action => {
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  let signal!: AbortSignal; let complete!: (result: any) => void;
  const s = await setup({ recognize: async request => { signal = request.signal!; started(); return new Promise(r => { complete = r; }); } });
  const ticket = await s.ticket();
  const pending = s.request('transcribe', s.op, silentWav(), { 'x-ptt-ticket': ticket });
  const response = Promise.resolve(pending); await ready;
  if (action === 'cancel') await s.request('cancel', s.op, { ticket });
  if (action === 'revoke') await s.t.http('/api/logout', { token: s.op, body: {} });
  if (action === 'expire') { s.t.clock.advance(13 * 3600000); await new Promise(r => setTimeout(r, 300)); }
  expect(signal.aborted).toBe(true);
  complete({ text: 'texto privado atrasado' });
  const result = await response;
  expect(result.statusCode).toBe(action === 'cancel' ? 409 : 401);
  expect(result.body).not.toContain('texto privado');
});

it('rejects invalid PCM and drops stale tickets; cancellation releases capacity before upload', async () => {
  const s = await setup(); const first = await s.ticket(); const second = await s.ticket();
  expect((await s.request('transcribe', s.op, silentWav(), { 'x-ptt-ticket': first })).statusCode).toBe(409);
  const bad = silentWav(); bad.writeUInt32LE(48000, 24);
  expect((await s.request('transcribe', s.op, bad, { 'x-ptt-ticket': second })).statusCode).toBe(400);
  const last = await s.ticket();
  expect(() => s.service.begin('not-the-session', last, () => true)).toThrow('BAD_TICKET');
  await s.request('cancel', s.op, { ticket: last });
  expect((await s.request('transcribe', s.op, silentWav(), { 'x-ptt-ticket': last })).statusCode).toBe(409);
  expect(s.recognize).not.toHaveBeenCalled();
});

it('times out inference, observes AbortSignal and removes temporary audio', async () => {
  vi.useFakeTimers();
  let ready!: () => void; const started = new Promise<void>(r => { ready = r; }); let file = '';
  const service = new PrivatePtt({}, { recognize: async request => { file = request.audioFile; ready(); return new Promise((_r, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })); } });
  const ticket = await service.ticket('session'); const job = service.begin('session', ticket, () => true);
  const result = service.transcribe(job, silentWav(), () => true); const rejection = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
  await started; vi.advanceTimersByTime(15000); await rejection;
  await expect(stat(file)).rejects.toThrow(); await service.close(); vi.useRealTimers();
});
