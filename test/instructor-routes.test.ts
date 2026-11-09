import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instructorProcedureSchema, instructorProcedures } from '../src/knowledge/sound-engineer/index.js';
import { agentTokenFile } from '../src/server/start.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer } from './server-support.js';

/**
 * GET /api/instructor/procedures: biblioteca de estudo (somente leitura) para operador E músico autenticados.
 * Não é a rota administrativa /api/knowledge/*, cujas permissões não mudam.
 */
type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
afterEach(async () => { for (const t of running.splice(0)) await t.server.close(); });
async function lab(opts: Parameters<typeof startTestServer>[0] = {}) { const t = await startTestServer(opts); running.push(t); return t; }
const PATH = '/api/instructor/procedures';

describe('rota de leitura do Instrutor Ui16', () => {
  it('operador e músico autenticados recebem a MESMA biblioteca real, sem cache', async () => {
    const t = await lab();
    const op = await t.login(OPERATOR_PIN);
    const mu = await t.login(MUSICIAN_PIN);
    const a = await t.http(PATH, { token: op });
    const b = await t.http(PATH, { token: mu });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json).toEqual(a.json);
    expect(a.json.schemaVersion).toBe(1);
    expect(a.json.procedures).toHaveLength(instructorProcedures.length);
    expect(a.json.procedures.map((p: { id: string }) => p.id)).toEqual(instructorProcedures.map((p) => p.id));
    const res = await fetch(t.base + PATH, { headers: { authorization: `Bearer ${op}` } });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('só texto de estudo: nenhum procedimento executável e nenhum campo fora do contrato estrito', async () => {
    const t = await lab();
    const r = await t.http(PATH, { token: await t.login(OPERATOR_PIN) });
    for (const p of r.json.procedures) {
      expect(() => instructorProcedureSchema.parse(p)).not.toThrow(); // esquema estrito: campo extra = erro
      expect(p).toMatchObject({ execution: 'not_executable', realWrites: false, requiresHumanReview: true, validationStatus: 'theory' });
      for (const s of p.steps) expect(Object.keys(s).sort()).toEqual(['control', 'id', 'instruction', 'notFound', 'origin', 'references', 'risks', 'verification']);
    }
    const text = JSON.stringify(r.json);
    expect(text).not.toMatch(/PinHash|scrypt\$|apiKey|geminiApiKey|postgresPassword|agent-lab\.token|set_level|set_mute|set_master/i);
    expect(text).not.toMatch(/https?:\/\/(?!(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/); // só links https com host (citações)
    expect(text).not.toMatch(/http:\/\//);
  });

  it('acessos negados: sem token, token inválido, agente MCP e sessão encerrada', async () => {
    const t = await lab();
    expect((await t.http(PATH)).status).toBe(401);
    expect((await t.http(PATH, { token: 'x'.repeat(40) })).status).toBe(401);
    const agent = readFileSync(agentTokenFile(t.dir, 'lab'), 'utf8').trim();
    expect((await t.http(PATH, { token: agent })).status).toBe(403);
    const mu = await t.login(MUSICIAN_PIN);
    expect((await t.http(PATH, { token: mu })).status).toBe(200);
    await t.http('/api/logout', { token: mu, body: {} });
    expect((await t.http(PATH, { token: mu })).status).toBe(401);
  });

  it('nenhum método de escrita existe e nenhuma consulta toca a mesa', async () => {
    const t = await lab();
    const write = vi.spyOn(t.mixer, 'write');
    const op = await t.login(OPERATOR_PIN);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const withBody = method !== 'DELETE';
      const res = await fetch(t.base + PATH, { method, headers: { authorization: `Bearer ${op}`, ...(withBody ? { 'content-type': 'application/json' } : {}) }, body: withBody ? '{}' : undefined });
      expect(res.status, method).toBe(404);
    }
    expect((await t.http(PATH + '/qualquer', { token: op })).status).toBe(404);
    await t.http(PATH, { token: op });
    expect(write).not.toHaveBeenCalled();
  });

  it('só existe em LAB: no modo simulado a rota não é registrada', async () => {
    const t = await lab({ mode: 'mock' });
    expect((await t.http(PATH, { token: await t.login(OPERATOR_PIN) })).status).toBe(404);
  });

  it('as rotas administrativas da base continuam fechadas ao músico (permissão inalterada)', async () => {
    const t = await lab();
    const mu = await t.login(MUSICIAN_PIN);
    // Sem base de conhecimento montada a rota nem existe (404); com ela, o músico recebe 403 (testes da base).
    const r = await t.http('/api/knowledge/procedures', { token: mu });
    expect([403, 404]).toContain(r.status);
    expect((await t.http('/api/knowledge/procedures')).status).not.toBe(200);
  });
});
