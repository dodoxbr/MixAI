import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { RealMixer } from '../src/mixer/real.js';
import type { MockMixer } from '../src/mixer/mock.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((t) => t.server.close())); vi.restoreAllMocks(); });

async function knowledgeAt(dir: string) {
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json'));
  await store.init();
  return new LocalKnowledge({ store, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
}
async function start(withKnowledge = true) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-ks-'));
  const knowledge = withKnowledge ? await knowledgeAt(dir) : undefined;
  const t = await startTestServer({ mode: 'mock', knowledge, dir,
    channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))) });
  servers.push(t);
  return { t, knowledge, dir };
}
const same = (t: { base: string }, path: string, token: string, init: RequestInit = {}) =>
  fetch(`${t.base}${path}`, { ...init, body: init.body ?? (init.method === 'POST' ? '{}' : undefined), headers: { authorization: `Bearer ${token}`, ...(init.method === 'POST' || init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });

describe('API de administração da base de conhecimento', () => {
  it('é exclusiva do operador: músico recebe 403, sem sessão 401', async () => {
    const { t } = await start();
    const musician = await t.login(MUSICIAN_PIN);
    for (const [method, path] of [['GET', '/api/knowledge/status'], ['GET', '/api/knowledge/microphones'], ['POST', '/api/knowledge/import-seed'], ['POST', '/api/knowledge/ingest'], ['POST', '/api/knowledge/search'], ['POST', '/api/knowledge/microphones'], ['DELETE', '/api/knowledge/documents/dabcd']] as const) {
      const res = await same(t, path, musician, { method, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await fetch(`${t.base}/api/knowledge/status`)).status).toBe(401);
    expect((await t.http('/api/knowledge/status', { token: 'invalido' })).status).toBe(401);
  });
  it('sem a base ligada, as rotas nem existem', async () => {
    const { t } = await start(false);
    const token = await t.login(OPERATOR_PIN);
    expect((await same(t, '/api/knowledge/status', token)).status).toBe(404);
  });
  it('operador importa o pacote, vê microfones, confirma um canal e pesquisa', async () => {
    const { t, dir } = await start();
    const token = await t.login(OPERATOR_PIN);
    expect((await (await same(t, '/api/knowledge/status', token)).json()).mode).toBe('deterministic');
    const imported = await same(t, '/api/knowledge/import-seed', token, { method: 'POST' });
    expect(await imported.json()).toMatchObject({ models: 1, assignments: 5, cases: 6 });
    const mics = await (await same(t, '/api/knowledge/microphones', token)).json();
    expect(mics.models['akg-p3s'].model).toBe('AKG Perception P3 S');
    expect(mics.assignments.CH5.modelId).toBeNull();
    const set = await same(t, '/api/knowledge/microphones', token, { method: 'POST', body: JSON.stringify({ channel: 5, modelId: 'akg-p3s' }) });
    expect((await set.json()).assignment).toMatchObject({ evidence: 'operator_confirmed', musician: 'Leandro' });
    expect((await same(t, '/api/knowledge/microphones', token, { method: 'POST', body: JSON.stringify({ channel: 5, modelId: 'sm58' }) })).status).toBe(400);
    expect((await same(t, '/api/knowledge/microphones', token, { method: 'POST', body: JSON.stringify({ channel: 5, modelId: 'akg-p3s', extra: 1 }) })).status).toBe(400);
    expect((await same(t, '/api/knowledge/microphones', token, { method: 'POST', body: JSON.stringify({ channel: 1, modelId: 'akg-p3s' }) })).status).toBe(404);

    mkdirSync(join(dir, 'inbox'), { recursive: true });
    writeFileSync(join(dir, 'inbox', 'akg-p3.md'), '# Padrão\n\nO P3 S é cardioide e rejeita o som que chega por trás do microfone.');
    const ingest = await (await same(t, '/api/knowledge/ingest', token, { method: 'POST' })).json();
    expect(ingest.items[0]).toMatchObject({ status: 'ingested', sourceId: 'akg-p3' });
    expect(JSON.stringify(ingest)).not.toContain(dir);
    const found = await (await same(t, '/api/knowledge/search', token, { method: 'POST', body: JSON.stringify({ query: 'padrão cardioide' }) })).json();
    expect(found.passages[0]).toMatchObject({ sourceId: 'akg-p3', url: 'https://br.akg.com/P3.html' });
    const docs = (await (await same(t, '/api/knowledge/documents', token)).json()).documents;
    expect((await same(t, `/api/knowledge/documents/${docs[0].id}`, token, { method: 'DELETE' })).status).toBe(200);
    expect((await same(t, `/api/knowledge/documents/${docs[0].id}`, token, { method: 'DELETE' })).status).toBe(404);
    expect((await same(t, '/api/knowledge/documents/..%2F..%2Fx', token, { method: 'DELETE' })).status).toBe(400);
  });
  it('escrita exige a mesma origem (anti-CSRF) e entrada inválida é recusada sem vazar detalhes', async () => {
    const { t } = await start();
    const token = await t.login(OPERATOR_PIN);
    const foreign = await same(t, '/api/knowledge/import-seed', token, { method: 'POST', headers: { origin: 'http://evil.example' } });
    expect(foreign.status).toBe(403);
    expect((await same(t, '/api/knowledge/search', token, { method: 'POST', body: JSON.stringify({ query: 'x' }) })).status).toBe(400);
    const bad = await same(t, '/api/knowledge/search', token, { method: 'POST', body: '{"query": 5}' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: 'INVALID' });
  });
  it('importações simultâneas não se atropelam (a segunda recebe recusa)', async () => {
    const { t, knowledge } = await start();
    const token = await t.login(OPERATOR_PIN);
    let release!: () => void;
    vi.spyOn(knowledge!, 'importSeed').mockImplementation(() => new Promise((resolve) => { release = () => resolve({ sources: 0, models: 0, assignments: 0, cases: 0 }); }));
    const first = same(t, '/api/knowledge/import-seed', token, { method: 'POST' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await same(t, '/api/knowledge/import-seed', token, { method: 'POST' })).status).toBe(400);
    release();
    expect((await first).status).toBe(200);
  });
});

describe('diagnóstico com a base local (motor determinístico preservado)', () => {
  const TEXT = 'Fred está microfonando no PA';

  it('acrescenta fontes e a ficha do microfone, sem proposta, escrita ou aprovação', async () => {
    const { t, knowledge, dir } = await start();
    await knowledge!.importSeed();
    mkdirSync(join(dir, 'inbox'), { recursive: true });
    writeFileSync(join(dir, 'inbox', 'shure-live.md'), '# Microfonia\n\nA microfonia depende do ganho do sistema e do posicionamento do microfone em relação às caixas.');
    await knowledge!.ingest();
    const token = await t.login(OPERATOR_PIN);
    const before = t.controller.state.snapshot();
    const write = vi.spyOn(RealMixer.prototype, 'write');
    const execute = vi.spyOn(t.server.core, 'execute');
    const build = vi.spyOn(t.server.core.assistant!.builder, 'build');

    const http = await t.http('/api/assistant/conversation', { token, body: { text: TEXT } });
    const reply = http.json.reply;
    expect(reply.kind).toBe('diagnosis');
    expect(reply.knowledge).toMatchObject({ mode: 'keyword', degraded: true });
    expect(reply.knowledge.passages[0]).toMatchObject({ sourceId: 'shure-live' });
    expect(reply.knowledge.microphone).toMatchObject({ channel: 'CH3', model: 'AKG Perception P3 S' });
    expect(reply.knowledge.caseRef).toEqual({ id: 'microfonia', title: 'Microfonia' });
    // O diagnóstico em si é o do motor determinístico, intacto.
    expect(reply.diagnosis.consultation.authorizedActions).toEqual([]);
    expect(reply.diagnosis.consultation.proposal).toBeNull();
    expect(reply.proposals).toBeUndefined();

    const c = await wsClient(t.base, token);
    try {
      await c.next((m) => m.type === 'snapshot');
      c.send({ type: 'assistant', requestId: 'k1', text: TEXT });
      const ws = (await c.next((m) => m.type === 'assistant_reply' && m.requestId === 'k1')).reply;
      expect(ws.knowledge.microphone.channel).toBe('CH3');
      c.send({ type: 'assistant_conversation', requestId: 'k2', input: { text: TEXT } });
      expect((await c.next((m) => m.type === 'assistant_reply' && m.requestId === 'k2')).reply.knowledge).toBeDefined();
      c.send({ type: 'assistant_diagnose', requestId: 'k3', input: { symptom: 'microfonia', channel: 3, destination: 'pa', evidence: [] } });
      expect((await c.next((m) => m.type === 'assistant_reply' && m.requestId === 'k3')).reply.knowledge).toBeDefined();
    } finally { c.close(); }

    expect(execute).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect((t.mixer as MockMixer).writes).toEqual([]);
    expect(t.controller.state.snapshot()).toEqual(before);
    expect((await t.http('/api/pending', { token })).json.items).toEqual([]);
  });

  it('sem base ligada a resposta é a mesma de antes (sem campo knowledge)', async () => {
    const { t } = await start(false);
    const token = await t.login(OPERATOR_PIN);
    const reply = (await t.http('/api/assistant/conversation', { token, body: { text: TEXT } })).json.reply;
    expect(reply.kind).toBe('diagnosis');
    expect('knowledge' in reply).toBe(false);
  });

  it('base quebrada: a resposta determinística continua igual, só com a base marcada como indisponível', async () => {
    const withK = await start();
    const without = await start(false);
    vi.spyOn(withK.knowledge!.store, 'search').mockRejectedValue(new Error('falha interna em C:\\data\\segredo'));
    vi.spyOn(withK.knowledge!.store, 'getMicrophones').mockRejectedValue(new Error('x'));
    const a = (await withK.t.http('/api/assistant/conversation', { token: await withK.t.login(OPERATOR_PIN), body: { text: TEXT } })).json.reply;
    const b = (await without.t.http('/api/assistant/conversation', { token: await without.t.login(OPERATOR_PIN), body: { text: TEXT } })).json.reply;
    const { knowledge, ...rest } = a;
    expect(knowledge).toMatchObject({ mode: 'deterministic', degraded: true, passages: [] });
    expect(JSON.stringify(knowledge)).not.toContain('segredo');
    expect(rest.diagnosis).toEqual(b.diagnosis);
    expect(rest.text).toEqual(b.text);
  });

  it('o músico não recebe consulta técnica nem conteúdo da base', async () => {
    const { t } = await start();
    const token = await t.login(MUSICIAN_PIN);
    const res = await t.http('/api/assistant/conversation', { token, body: { text: TEXT } });
    expect(res.json.reply.kind).toBe('error');
    expect(JSON.stringify(res.json)).not.toContain('knowledge');
  });
});

describe('isolamento e infraestrutura', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  it('o módulo da base não importa mesa, controlador, fila, autenticação nem o servidor', () => {
    const files = walk(join(PROJECT_ROOT, 'src', 'knowledge', 'local')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(6);
    for (const f of files) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports.filter((s) => s.startsWith('.'))) {
        expect(spec, `${f} importa ${spec}`).not.toMatch(/mixer|controller|\/server\/|auth|queue|assistant|\/mcp\//);
        if (spec.includes('core/')) expect(spec, `${f}`).toMatch(/core\/config\.js$/);
      }
    }
  });
  it('docker-compose: só loopback, sem senha embutida, volumes nomeados e senha obrigatória', () => {
    const compose = parse(readFileSync(join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8')) as { services: Record<string, any>; volumes: Record<string, unknown> };
    expect(Object.keys(compose.services).sort()).toEqual(['ollama', 'postgres']);
    for (const svc of Object.values(compose.services)) {
      for (const port of svc.ports as string[]) expect(port, port).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
      expect(svc.security_opt).toContain('no-new-privileges:true');
      expect(svc.healthcheck).toBeDefined();
    }
    expect(compose.services.postgres.image).toContain('pgvector');
    expect(compose.services.postgres.environment.POSTGRES_PASSWORD).toMatch(/^\$\{MIXAI_PG_PASSWORD:\?/);
    expect(Object.keys(compose.volumes)).toEqual(['mixai_pg', 'mixai_ollama']);
    const raw = readFileSync(join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
    expect(raw).not.toMatch(/^\s*POSTGRES_PASSWORD:\s*(?!\$\{MIXAI_PG_PASSWORD:\?)\S/m);
    expect(raw).not.toContain('0.0.0.0');
  });
  it('.env.example não contém senha e é versionável, enquanto .env segue ignorado', () => {
    const example = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8');
    expect(example).toMatch(/^MIXAI_PG_PASSWORD=$/m);
    const ignore = readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('.env');
    expect(ignore).toContain('!.env.example');
    expect(ignore.indexOf('!.env.example')).toBeGreaterThan(ignore.indexOf('.env.*'));
  });
  it('a configuração padrão do repositório mantém a base desligada e a mesa em modo seguro', () => {
    const cfg = parse(readFileSync(join(PROJECT_ROOT, 'config/config.yaml'), 'utf8')) as { knowledge: { enabled: boolean; store: string }; mixer: { mode: string } };
    expect(cfg.knowledge).toMatchObject({ enabled: false, store: 'file' });
    expect(cfg.mixer.mode).not.toBe('real');
  });
});
