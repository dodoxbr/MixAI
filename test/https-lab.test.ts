import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import { httpsLabOptions } from '../src/server/https-lab.js';
import { buildHttp } from '../src/server/http.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer } from './server-support.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const origin = 'https://mixai.home.arpa:8443';

it('keeps proxy disabled by default and rejects unsafe modes/configurations', () => {
  expect(httpsLabOptions(parseConfig({}))).toBeUndefined();
  expect(httpsLabOptions(parseConfig({ mixer: { mode: 'lab' }, server: { httpsLab: { enabled: true, origin } } }))).toEqual({ origin, port: 8792 });
  for (const mode of ['real', 'mock']) expect(() => httpsLabOptions(parseConfig({ mixer: { mode }, server: { httpsLab: { enabled: true, origin } } }))).toThrow('modo lab');
  expect(() => httpsLabOptions(parseConfig({ mixer: { mode: 'lab' }, server: { lan: { enabled: true }, httpsLab: { enabled: true, origin } } }))).toThrow('server.lan');
  for (const invalid of ['', 'http://mixai.home.arpa', `${origin}/`, `${origin}/api`, 'https://user:password@mixai.home.arpa', `${origin}?x=1`, `${origin}#x`]) {
    expect(() => httpsLabOptions(parseConfig({ mixer: { mode: 'lab' }, server: { httpsLab: { enabled: true, origin: invalid } } }))).toThrow();
  }
  for (const port of [8790, 8791]) expect(() => httpsLabOptions(parseConfig({ mixer: { mode: 'lab' }, server: { httpsLab: { enabled: true, origin, port } } }))).toThrow('porta');
});

it('isolates proxy authentication, preserves human permissions and rejects foreign origins', async () => {
  const t = await startTestServer();
  cleanups.push(() => t.server.close());
  const ingress = await buildHttp(t.server.core, { labProxyOrigin: origin });
  cleanups.push(() => ingress.close());
  const futureHandler = { called: false };
  ingress.post('/api/future-route', async () => { futureHandler.called = true; return { ok: true }; });
  await ingress.listen({ host: '127.0.0.1', port: 0 });
  const address = ingress.server.address() as { port: number };
  const request = (path: string, token?: string, headers: Record<string, string> = {}, body?: object) => new Promise<{ status: number; json(): Promise<any>; headers: Headers }>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { host: new URL(origin).host, ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text), headers: new Headers(res.headers as Record<string, string>) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  expect((await request('/api/state')).status).toBe(401);
  expect((await request('/api/hello', undefined, { origin: 'https://evil.invalid' })).status).toBe(403);
  expect((await request('/api/hello', undefined, { origin: 'null' })).status).toBe(403);
  expect((await request('/api/hello', undefined, { host: 'evil.invalid' })).status).toBe(403);
  const agent = readFileSync(join(t.dir, 'agent-lab.token'), 'utf8');
  expect((await t.http('/api/state', { token: agent })).status).toBe(200);
  expect((await request('/api/state', agent, { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' })).status).toBe(401);
  // Includes public/new handlers: a forgotten principalOf() cannot admit MCP credentials.
  for (const [path, body] of [
    ['/api/hello', undefined], ['/api/login', { pin: OPERATOR_PIN }], ['/api/logout', {}],
    ['/api/command', {}], ['/api/pending', undefined], ['/api/pending/fake/approve', {}],
    ['/api/pending/fake/reject', {}], ['/api/future-route', {}],
  ] as const) {
    expect((await request(path, agent, {}, body)).status, path).toBe(401);
  }
  expect(futureHandler.called).toBe(false);
  const op = await t.login(OPERATOR_PIN);
  const musician = await t.login(MUSICIAN_PIN);
  expect((await request('/api/state', op, { origin })).status).toBe(200);
  const res = await request('/api/command', musician, { origin }, { requestId: 'proxy-forbidden', command: { type: 'set_master', deltaDB: -2 } });
  expect(res.status).toBe(403);
  expect((await res.json()).result.code).toBe('FORBIDDEN');
  expect((await request('/api/logout', op, { origin }, {})).status).toBe(200);
  expect((await request('/api/state', op)).status).toBe(401);
  expect((await request('/api/hello')).headers.get('set-cookie')).toBeNull();
});
