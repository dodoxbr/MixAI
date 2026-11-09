import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { diagnosticsContainSecret } from '../support/log-secrets.js';
import { silentWav } from '../support/speech-fixtures.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from '../server-support.js';

let dir: string;
let caddy: ChildProcess | undefined;
let t: Awaited<ReturnType<typeof startTestServer>> | undefined;
let origin: string;
let ca: Buffer;
let diagnostics = '';
const sockets: WebSocket[] = [];
const port = async () => {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(r => server.close(() => r()));
  return value;
};
function openssl(args: string[]) {
  const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`OpenSSL indisponível/falhou: ${result.error?.message ?? result.stderr}`);
}
function http(path: string, opts: { trust?: boolean; token?: string; body?: object; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: any }>((resolveResponse, reject) => {
    const req = request(`${origin}${path}`, {
      ca: opts.trust === false ? undefined : ca,
      method: opts.body ? 'POST' : 'GET',
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { 'content-type': Buffer.isBuffer(opts.body) ? 'audio/wav' : 'application/json' } : {}), ...opts.headers },
    }, res => {
      // Decodificar no stream preserva caracteres UTF-8 divididos entre chunks TLS.
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => { let parsed: unknown; try { parsed = JSON.parse(body); } catch { parsed = body; } resolveResponse({ status: res.statusCode!, headers: res.headers, body: parsed }); });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HTTPS timeout')));
    req.end(Buffer.isBuffer(opts.body) ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined);
  });
}
async function socket(token: string) {
  const ws = new WebSocket(`${origin.replace('https:', 'wss:')}/ws`, { ca, origin });
  sockets.push(ws);
  const messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(String(data))));
  const closed = new Promise<number>(r => ws.once('close', r));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token }));
  const next = async (type: string) => {
    for (let i = 0; i < 200; i++) {
      const index = messages.findIndex(m => m.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`WSS timeout: ${type}`);
  };
  return { ws, next, closed };
}
beforeAll(async () => {
  if (!process.env['CADDY_BIN']) throw new Error('Defina CADDY_BIN com o executável Caddy validado. Ver guia E9B.');
  dir = mkdtempSync(join(tmpdir(), 'mixai-e9b-tls-'));
  // Exceção explícita da Issue #22: material descartável somente no runner.
  // Nunca usar esses certificados no Yoga, nunca registrar ou publicar artefatos.
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=MixAI disposable test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost']);
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '1', '-extfile', 'ext.cnf']);
  ca = readFileSync(join(dir, 'ca.pem'));
  const upstreamPort = await port();
  const tlsPort = await port();
  origin = `https://localhost:${tlsPort}`;
  t = await startTestServer({ server: { httpsLab: { enabled: true, origin, port: upstreamPort }, privatePtt: { enabled: true } }, pttRecognizer: { recognize: async () => ({ provider: 'whisper.cpp', language: 'pt-BR', text: 'Prévia simulada: não altere nada.', processingMs: 1, audioSeconds: 0.1, realTimeFactor: 0.01, cpuMs: null, peakRssBytes: null }) } });
  const env = { ...process.env, MIXAI_HTTPS_HOST: 'localhost', MIXAI_HTTPS_BIND: '127.0.0.1', MIXAI_HTTPS_PORT: String(tlsPort), MIXAI_HTTPS_UPSTREAM_PORT: String(upstreamPort), MIXAI_HTTPS_CERT: join(dir, 'leaf.pem'), MIXAI_HTTPS_KEY: join(dir, 'leaf.key'), XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir };
  caddy = spawn(resolve(process.env['CADDY_BIN']), ['run', '--config', resolve('config/https-lab/Caddyfile.example'), '--adapter', 'caddyfile'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  caddy.stdout?.on('data', chunk => { diagnostics += String(chunk); });
  caddy.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  for (let i = 0; i < 150; i++) {
    if (caddy.exitCode !== null) throw new Error(`Caddy falhou: ${diagnostics}`);
    try { if ((await http('/api/hello')).status === 200) return; } catch { /* waiting for bind */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Caddy não iniciou: ${diagnostics}`);
});
afterAll(async () => {
  sockets.forEach(ws => ws.terminate());
  if (caddy && caddy.exitCode === null) { const exited = once(caddy, 'exit'); caddy.kill(); await exited; }
  await t?.server.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('validates TLS chain, proxies routes and retains plain HTTP/WS locally', async () => {
  await expect(http('/api/hello', { trust: false })).rejects.toThrow();
  expect((await http('/api/hello')).body.mode).toBe('lab');
  const root = await http('/');
  expect(root.status).toBe(200);
  expect(root.headers['x-content-type-options']).toBe('nosniff');
  expect(root.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect((await t!.http('/api/hello')).status).toBe(200);
  const plain = await wsClient(t!.base, await t!.login(OPERATOR_PIN));
  try { expect((await plain.next(m => m.type === 'hello')).role).toBe('operator'); } finally { plain.close(); }
});

it('keeps PIN, bearer, role policy and logout intact through HTTPS/WSS', async () => {
  expect((await http('/api/state')).status).toBe(401);
  expect((await http('/api/login', { body: { pin: 'not-a-pin' } })).status).toBe(401);
  const login = await http('/api/login', { body: { pin: MUSICIAN_PIN }, headers: { origin } });
  expect(login.body.role).toBe('musician');
  expect(login.headers['set-cookie']).toBeUndefined();
  const token = login.body.token;
  expect((await http('/api/state', { token })).status).toBe(200);
  const client = await socket(token);
  expect((await client.next('hello')).role).toBe('musician');
  expect((await client.next('snapshot')).snapshot.mode).toBe('lab');
  const command = { type: 'set_master', deltaDB: -2 };
  expect((await http('/api/command', { token, body: { requestId: 'https-denied', command } })).status).toBe(403);
  client.ws.send(JSON.stringify({ type: 'command', requestId: 'wss-denied', command }));
  expect((await client.next('result')).result.code).toBe('FORBIDDEN');
  await http('/api/logout', { token, body: {} });
  expect(await client.closed).toBe(4401);
  expect((await http('/api/state', { token })).status).toBe(401);
  expect(diagnosticsContainSecret(diagnostics, [MUSICIAN_PIN, token])).toBe(false);
});

it('refuses MCP token on the proxy ingress even with forged loopback headers', async () => {
  const token = readFileSync(join(t!.dir, 'agent-lab.token'), 'utf8');
  expect((await t!.http('/api/state', { token })).status).toBe(200);
  expect((await http('/api/state', { token, headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(401);
  const client = await socket(token);
  expect(await client.closed).toBe(4401);
  expect(diagnosticsContainSecret(diagnostics, [token])).toBe(false);
});

it('rejects foreign/null origins and unauthenticated WSS sessions', async () => {
  for (const invalid of ['https://evil.invalid', 'null']) expect((await http('/api/login', { headers: { origin: invalid }, body: { pin: OPERATOR_PIN } })).status).toBe(403);
  const ws = new WebSocket(`${origin.replace('https:', 'wss:')}/ws`, { ca, origin: 'https://evil.invalid' });
  sockets.push(ws);
  const rejected = new Promise<number>(r => ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); r(res.statusCode!); }));
  ws.on('error', () => {});
  expect(await rejected).toBe(403);
  const unauthenticated = await socket('invalid-token');
  expect(await unauthenticated.closed).toBe(4401);
});

it('retains E2 approval over WSS with only the LAB simulator', async () => {
  const agent = readFileSync(join(t!.dir, 'agent-lab.token'), 'utf8');
  const proposal = await t!.http('/api/command', { token: agent, body: { requestId: 'lab-e2', targetMode: 'lab', command: { type: 'set_master', deltaDB: -2 } } });
  expect(proposal.json.result.code).toBe('NEEDS_CONFIRMATION');
  const id = proposal.json.result.pendingId;
  const musician = (await http('/api/login', { body: { pin: MUSICIAN_PIN } })).body.token;
  expect((await http(`/api/pending/${id}/approve`, { token: musician, body: { requestId: 'musician-cannot-approve' } })).status).toBe(403);
  const operator = (await http('/api/login', { body: { pin: OPERATOR_PIN } })).body.token;
  const client = await socket(operator);
  expect((await client.next('hello')).role).toBe('operator');
  client.ws.send(JSON.stringify({ type: 'approve', requestId: 'operator-approve', pendingId: id }));
  expect((await client.next('result')).result.code).toBe('OK');
  expect((await http(`/api/pending/${id}/approve`, { token: operator, body: { requestId: 'cannot-reuse' } })).body.result.code).toBe('CONFIRMATION_USED');
});

it('diagnosis authenticates at ingress: proxy MCP 401, local MCP 403, operator HTTPS/WSS works', async () => {
  const endpoint = '/api/assistant/diagnose';
  const input = { symptom: 'estridente', channel: 1, destination: 'pa', evidence: [] };
  const before = t!.controller.state.snapshot();
  const agent = readFileSync(join(t!.dir, 'agent-lab.token'), 'utf8');
  expect((await http(endpoint, { body: input })).status).toBe(401);
  expect((await http(endpoint, { token: agent, body: input, headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' } })).status).toBe(401);
  // Local MCP is authenticated; diagnosis authorization (operator only) remains 403.
  expect((await t!.http('/api/state', { token: agent })).status).toBe(200);
  expect((await t!.http(endpoint, { token: agent, body: input })).status).toBe(403);
  const localAgent = await wsClient(t!.base, agent);
  try {
    expect((await localAgent.next(m => m.type === 'hello')).role).toBe('agent');
    localAgent.send({ type: 'assistant_diagnose', requestId: 'local-agent-diagnose', input });
    expect((await localAgent.next(m => m.type === 'assistant_reply' && m.requestId === 'local-agent-diagnose')).reply.code).toBe('FORBIDDEN');
  } finally { localAgent.close(); }
  const proxyAgent = await socket(agent);
  expect(await proxyAgent.closed).toBe(4401);

  expect((await http('/api/login', { body: { pin: 'invalid-operator-pin' } })).status).toBe(401);
  const login = await http('/api/login', { body: { pin: OPERATOR_PIN } });
  expect(login.body.role).toBe('operator');
  const operator = login.body.token;
  const result = await http(endpoint, { token: operator, body: input });
  expect(result.status).toBe(200);
  expect(result.body.reply.kind).toBe('diagnosis');
  expect(result.body.reply.diagnosis.audioAnalysis).toBe('not_performed');
  expect(result.body.reply.proposals).toBeUndefined();
  const opSocket = await socket(operator);
  expect((await opSocket.next('hello')).role).toBe('operator');
  opSocket.ws.send(JSON.stringify({ type: 'assistant_diagnose', requestId: 'proxy-operator-diagnose', input }));
  expect((await opSocket.next('assistant_reply')).reply).toEqual(result.body.reply);

  const musicianLogin = await http('/api/login', { body: { pin: MUSICIAN_PIN } });
  expect(musicianLogin.body.role).toBe('musician');
  const musician = musicianLogin.body.token;
  expect((await http(endpoint, { token: musician, body: input })).status).toBe(403);
  const musicianSocket = await socket(musician);
  expect((await musicianSocket.next('hello')).role).toBe('musician');
  musicianSocket.ws.send(JSON.stringify({ type: 'assistant_diagnose', requestId: 'proxy-musician-diagnose', input }));
  expect((await musicianSocket.next('assistant_reply')).reply.code).toBe('FORBIDDEN');
  expect(t!.controller.state.snapshot()).toEqual(before);
  await http('/api/logout', { token: operator, body: {} });
  expect(await opSocket.closed).toBe(4401);
  expect((await http(endpoint, { token: operator, body: input })).status).toBe(401);
});

it('transports bounded PCM through verified TLS only for the LAB operator, without replay or commands', async () => {
  const before = t!.controller.state.snapshot();
  const token = (await http('/api/login', { body: { pin: OPERATOR_PIN } })).body.token;
  const musician = (await http('/api/login', { body: { pin: MUSICIAN_PIN } })).body.token;
  const agent = readFileSync(join(t!.dir, 'agent-lab.token'), 'utf8');
  expect((await t!.http('/api/speech/status', { token })).status).toBe(404);
  expect((await http('/api/speech/status', { token: agent })).status).toBe(401);
  expect((await http('/api/speech/status', { token: musician })).status).toBe(403);
  expect((await http('/api/speech/status', { token })).body.configured).toBe(true);
  expect((await http('/api/speech/ticket', { token, body: {}, headers: { origin: 'null' } })).status).toBe(403);
  const ticket = (await http('/api/speech/ticket', { token, body: {}, headers: { origin } })).body.ticket;
  const result = await http('/api/speech/transcribe', { token, body: silentWav(), headers: { origin, 'x-ptt-ticket': ticket } });
  expect(result.status).toBe(200); expect(result.body).toEqual({ text: 'Prévia simulada: não altere nada.', preview: true, simulated: true });
  expect(result.headers['cache-control']).toBe('no-store');
  expect((await http('/api/speech/transcribe', { token, body: silentWav(), headers: { origin, 'x-ptt-ticket': ticket } })).status).toBe(409);
  expect(t!.controller.state.snapshot()).toEqual(before);
  expect(diagnosticsContainSecret(diagnostics, ['Prévia simulada', ticket])).toBe(false);
});

it('keeps reference/request routes on central HTTPS auth, private sessions and read-only WSS observation', async () => {
  const operator = (await http('/api/login', { body: { pin: OPERATOR_PIN } })).body.token;
  const musician = (await http('/api/login', { body: { pin: MUSICIAN_PIN } })).body.token;
  const other = (await http('/api/login', { body: { pin: MUSICIAN_PIN } })).body.token;
  const agentToken = readFileSync(join(t!.dir, 'agent-lab.token'), 'utf8');
  const workspace = await http('/api/reference-workspace', { token: operator });
  expect(workspace.status).toBe(200); expect(workspace.headers['cache-control']).toBe('no-store');
  expect((await http('/api/reference-workspace', { token: agentToken })).status).toBe(401);
  expect((await t!.http('/api/reference-workspace', { token: agentToken })).status).toBe(403);
  const base = { serverId: workspace.body.serverId };
  const client = await socket(operator); expect((await client.next('hello')).role).toBe('operator');
  const revision = t!.server.core.snapshotFor('operator').revision;
  const capture = { ...base, eventId: 'tls-event-test', eventName: 'TLS LAB', eventDate: '2026-11-07', scope: 'PA', expectedVersion: 0, expectedStateRevision: revision, operatorApproved: true };
  expect((await http('/api/mix-references', { token: musician, body: capture })).status).toBe(403);
  const ref = await http('/api/mix-references', { token: operator, body: capture }); expect(ref.status).toBe(200);
  expect((await http(`/api/mix-references/${ref.body.id}/compare`, { token: operator })).status).toBe(200);
  const identity = (await t!.command(musician, { type: 'musician_identity' })).json.result.data;
  expect((await t!.command(operator, { type: 'musician_bind', sessionId: identity.sessionId, musicianId: 'lucius', name: 'Lucius', channels: [1, 4], mute: true })).json.result.ok).toBe(true);
  const created = await http('/api/mix-requests', { token: musician, body: { ...base, requestId: 'tls-request-test', type: 'meu_canal', channel: 4, report: 'A voz está abafada', destination: 'AUX1' } });
  expect(created.status).toBe(200); expect(created.body.requestedBy).toMatchObject({ verified: true, boundChannels: [1, 4] });
  const advice = await http(`/api/mix-requests/${created.body.id}/assess`, { token: operator, body: { ...base, expectedVersion: 1, expectedStateRevision: t!.server.core.snapshotFor('operator').revision } });
  expect(advice.status).toBe(200); expect(advice.body.recommendation.source).toBe('diagnosis');
  await t!.command(operator, { type: 'musician_revoke', sessionId: identity.sessionId });
  expect((await http(`/api/mix-requests/${created.body.id}/decide`, { token: operator, body: { ...base, expectedVersion: advice.body.version, expectedStateRevision: t!.server.core.snapshotFor('operator').revision, state: 'approved', response: 'Não executar ajustes.' } })).status).toBe(409);
  expect((await http(`/api/mix-requests/${created.body.id}`, { token: other })).status).toBe(404);
  expect((await http('/api/mix-requests', { token: musician, body: { ...base, requestId: 'tls-forged-origin', type: 'mix_geral', report: 'Retorno', destination: 'AUX1' }, headers: { origin: 'https://foreign.invalid' } })).status).toBe(403);
  expect(t!.server.core.snapshotFor('operator').revision).toBe(revision);
  await http('/api/logout', { token: musician, body: {} });
  expect((await http(`/api/mix-requests/${created.body.id}`, { token: musician })).status).toBe(401);
});

it('soundcheck event routes retain operator authorization, proxy MCP rejection and LAB-only records over TLS',async()=>{
 const operator=(await http('/api/login',{body:{pin:OPERATOR_PIN}})).body.token;
 const musician=(await http('/api/login',{body:{pin:MUSICIAN_PIN}})).body.token;
 const agent=readFileSync(join(t!.dir,'agent-lab.token'),'utf8');
 expect((await http('/api/soundchecks')).status).toBe(401);
 expect((await http('/api/soundchecks',{token:agent})).status).toBe(401);
 expect((await http('/api/soundchecks',{token:musician})).status).toBe(403);
 const list=await http('/api/soundchecks',{token:operator});expect(list.status).toBe(200);expect(list.headers['cache-control']).toBe('no-store');
 const before=t!.server.core.snapshotFor('operator').revision;
 const created=await http('/api/soundchecks',{token:operator,body:{serverId:list.body.serverId,id:'tls-soundcheck-event',name:'TLS LAB',date:'2026-11-08',operatorName:'Operador declarado'}});
 expect(created.status).toBe(200);expect(created.body.pendingSteps.length).toBeGreaterThan(0);
 expect((await http(`/api/soundchecks/${created.body.id}`,{token:musician})).status).toBe(403);
 expect(t!.server.core.snapshotFor('operator').revision).toBe(before);
});

it('AutoConfig contracts retain central HTTPS authorization and reject physical/write payloads',async()=>{
 const operator=(await http('/api/login',{body:{pin:OPERATOR_PIN}})).body.token;
 const musician=(await http('/api/login',{body:{pin:MUSICIAN_PIN}})).body.token;
 const agent=readFileSync(join(t!.dir,'agent-lab.token'),'utf8');
 expect((await http('/api/autoconfig')).status).toBe(401);
 expect((await http('/api/autoconfig',{token:agent})).status).toBe(401);
 expect((await t!.http('/api/autoconfig',{token:agent})).status).toBe(403);
 expect((await http('/api/autoconfig',{token:musician})).status).toBe(403);
 const info=await http('/api/autoconfig',{token:operator});expect(info.status).toBe(200);expect(info.body.capabilities.realWrite).toBe(false);
 const snapshot=t!.server.core.snapshotFor('operator');const input={serverId:t!.server.core.serverId,id:'tls-autoconfig-test',title:'Virtual TLS',scope:'AUX1',items:[{id:'tls-level-item',operation:'level_delta',channel:1,deltaDB:1,rationale:'Teste virtual',evidence:[]}]};
 expect((await http('/api/autoconfig',{token:operator,body:{...input,transport:'real'}})).status).toBe(400);
 expect((await http('/api/autoconfig',{token:operator,body:input,headers:{origin:'https://foreign.invalid'}})).status).toBe(403);
 expect((await http('/api/autoconfig',{token:operator,body:input})).status).toBe(200);
 expect(t!.server.core.snapshotFor('operator')).toEqual(snapshot);
});
