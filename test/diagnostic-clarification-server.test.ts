import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { OPERATOR_PIN, startTestServer } from './server-support.js';

/** M1 — o cadastro de microfones da banda (CH3/CH4/CH6 com AKG P3 S; CH5/CH7 sem modelo) alimenta a conversa pelo servidor real. */
const dirs: string[] = [];
const running: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { for (const t of running.splice(0)) await t.server.close(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); });

async function lab(seed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-m1-')); dirs.push(dir);
  const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
  const knowledge = new LocalKnowledge({ store, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
  if (seed) await knowledge.importSeed();
  vi.spyOn(knowledge, 'enrich').mockResolvedValue({ mode: 'vector', degraded: false, passages: [], narrativeStatus: { status: 'disabled' } });
  const channels = parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8')));
  const t = await startTestServer({ channels, knowledge, dir }); running.push(t);
  return t;
}
async function say(t: Awaited<ReturnType<typeof lab>>, token: string, text: string, ctx?: { id: string; revision: number }) {
  const r = await t.http('/api/assistant/conversation', { token, body: ctx ? { text, context: ctx } : { text } });
  const reply = r.json['reply'] ?? {};
  const dc = reply.diagnosticContext as { id: string; revision: number; field: string } | null | undefined;
  return { status: r.status, reply, field: dc?.field, ctx: dc ? { id: dc.id, revision: dc.revision } : undefined, capture: reply.diagnosticSession?.knownContext?.capture as string | null | undefined };
}

describe('cadastro de microfones × conversa', () => {
  it('Fred (CH3, AKG P3 S confirmado): não pergunta a captação; vai de isolamento a verificação', async () => {
    const t = await lab(); const token = await t.login(OPERATOR_PIN);
    const write = vi.spyOn(t.mixer, 'write');
    let s = await say(t, token, 'A voz do Fred está abafada no retorno');
    expect(s.field).toBe('isolation'); expect(s.capture).toBe('microphone');
    s = await say(t, token, 'Também sozinha', s.ctx);
    expect(s.field).toBe('check');
    expect(s.reply.diagnosticContext.question).not.toMatch(/microfone ou captador/i);
    expect(write).not.toHaveBeenCalled();
  });
  it('Leandro (CH5, sem modelo confirmado): a captação continua sendo perguntada', async () => {
    const t = await lab(); const token = await t.login(OPERATOR_PIN);
    let s = await say(t, token, 'A voz do Leandro está abafada no retorno');
    expect(s.capture).toBeNull();
    s = await say(t, token, 'Também sozinha', s.ctx);
    expect(s.field).toBe('capture');
  });
  it('sem cadastro na base, nada é presumido: Fred volta a ter a captação perguntada', async () => {
    const t = await lab(false); const token = await t.login(OPERATOR_PIN);
    let s = await say(t, token, 'A voz do Fred está abafada no retorno');
    expect(s.capture).toBeNull();
    s = await say(t, token, 'Também sozinha', s.ctx);
    expect(s.field).toBe('capture');
  });
});
