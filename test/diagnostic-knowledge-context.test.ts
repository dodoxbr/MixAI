import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import type { KnowledgeContext } from '../src/knowledge/local/index.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { OPERATOR_PIN, startTestServer } from './server-support.js';

/**
 * A1 — contexto consolidado. A base (e o modelo local) recebem o relato ORIGINAL + sintoma + fonte + destino + esclarecimentos,
 * nunca a última resposta isolada ("Fones", "Microfone"). Cada sessão tem o seu contexto; nada vaza entre elas.
 */
const dirs: string[] = [];
const running: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { for (const t of running.splice(0)) await t.server.close(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); });

interface Call { text: string; symptom?: string; instrument?: string; channel?: number; destination?: string }
const FRESH = (): KnowledgeContext => ({ mode: 'vector', degraded: false, passages: [], narrativeStatus: { status: 'disabled' } });

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-ctx-')); dirs.push(dir);
  const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
  const knowledge = new LocalKnowledge({ store, inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
  const calls: Call[] = [];
  vi.spyOn(knowledge, 'enrich').mockImplementation(async (input) => { calls.push(structuredClone(input) as Call); return FRESH(); });
  const channels = parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8')));
  const t = await startTestServer({ channels, knowledge, dir });
  running.push(t);
  const principalId = async (token: string) => t.server.core.auth.authenticate(token, '127.0.0.1')!.id;
  const cache = () => (t.server.core.assistant as unknown as { knowledgeCache: Map<string, unknown> }).knowledgeCache;
  return { t, calls, principalId, cache };
}
type Lab = Awaited<ReturnType<typeof lab>>;

/** Uma volta da conversa, como a tela faz (texto + carimbo do esclarecimento pendente). */
async function say(l: Lab, token: string, text: string, ctx?: { id: string; revision: number }) {
  const r = await l.t.http('/api/assistant/conversation', { token, body: ctx ? { text, context: ctx } : { text } });
  const reply = r.json['reply'] ?? {};
  const dc = reply.diagnosticContext as { id: string; revision: number } | null | undefined;
  return { status: r.status, reply, raw: JSON.stringify(r.json), ctx: dc ? { id: dc.id, revision: dc.revision } : undefined,
    pick: (re: RegExp) => (reply.diagnosticOptions ?? []).find((o: { label: string }) => re.test(o.label))?.label as string | undefined };
}

describe('a base recebe o contexto consolidado, não a última resposta', () => {
  it('jornada de voz abafada: relato → fonte → destino já no relato → esclarecimentos → diagnóstico', async () => {
    const l = await lab();
    const token = await l.t.login(OPERATOR_PIN);
    const write = vi.spyOn(l.t.mixer, 'write');
    const COMPLAINT = 'A voz está abafada no retorno.';
    let step = await say(l, token, COMPLAINT);
    expect(step.reply.clarification.field).toBe('channel');
    step = await say(l, token, step.pick(/fred/i)!, step.ctx);                  // fonte
    expect(step.reply.clarification.question).toMatch(/sozinha/);               // o destino já veio no relato: não se pergunta PA/fones de novo
    step = await say(l, token, step.pick(/também sozinha/i)!, step.ctx);         // esclarecimento: isolamento
    step = await say(l, token, step.pick(/^microfone$/i)!, step.ctx);            // esclarecimento: captação
    const last = await say(l, token, step.pick(/encontrei um problema/i)!, step.ctx);
    expect(last.reply.clarification).toBeUndefined();                           // diagnóstico final

    expect(l.calls.length).toBeGreaterThanOrEqual(4);
    for (const c of l.calls) {
      expect(c.text.startsWith('A voz está abafada no retorno'), `relato original primeiro: "${c.text}"`).toBe(true);
      expect(c.symptom).toBe('abafado');
      expect(c.instrument).toBe('vozes');
      expect(c.destination).toBe('fones');
    }
    // nenhuma resposta isolada chega à base como se fosse a pergunta
    for (const c of l.calls) expect(['Voz Fred', 'Fones', 'PA', 'Só no retorno', 'Também sozinha', 'Microfone', 'Encontrei um problema']).not.toContain(c.text);
    // a fonte escolhida e os esclarecimentos foram consolidados
    const withFred = l.calls.filter((c) => c.channel === 3);
    expect(withFred.length).toBeGreaterThanOrEqual(3);
    expect(withFred.at(-1)!.text).not.toMatch(/Só no retorno|Só no PA/);
    expect(withFred.at(-1)!.text).toContain('Soa assim também sozinha.');
    expect(withFred.at(-1)!.text).toContain('A fonte usa microfone.');
    // o resultado da verificação final não muda a consulta: reaproveita a anterior em vez de buscar de novo
    expect(l.calls.length).toBeLessThan(6);
    // nada foi proposto nem enviado à mesa
    expect(write).not.toHaveBeenCalled();
    for (const s of [step, last]) expect(s.raw).not.toMatch(/"proposals"|"approval"|knowledgeQuery/);
  });

  it('contexto que não mudou NÃO consulta a base de novo (detalhes, repetição) e mudou → consulta', async () => {
    const l = await lab();
    const token = await l.t.login(OPERATOR_PIN);
    let s = await say(l, token, 'Falta grave no surdo.');
    expect(l.calls).toHaveLength(1);
    const again = await say(l, token, 'detalhes', s.ctx);          // mesma pergunta, mesmo contexto
    expect(again.status).toBe(200);
    expect(l.calls).toHaveLength(1);
    s = await say(l, token, s.pick(/fones/i)!, s.ctx);             // destino novo → contexto mudou
    expect(l.calls).toHaveLength(2);
    expect(l.calls[1]).toMatchObject({ symptom: 'magro', instrument: 'surdo', channel: 8, destination: 'fones' });
    expect(l.calls[1]!.text.startsWith('Falta grave no surdo')).toBe(true);
  });

  it('relato vago: a base só é consultada depois do esclarecimento, preservando o relato original', async () => {
    const l = await lab();
    const token = await l.t.login(OPERATOR_PIN);
    const first = await say(l, token, 'O som do violão está horrível.');
    expect(first.status).toBe(200);
    expect(first.reply.kind).toBe('diagnosis');
    expect(first.reply.clarification.field).toBe('symptom');
    expect(first.reply.diagnosticOptions.length).toBeLessThanOrEqual(6);
    expect(first.raw).not.toMatch(/"proposals"/);
    expect(l.calls).toHaveLength(0);                                // nada de busca para um relato sem sintoma
    const next = await say(l, token, first.pick(/estridente/i)!, first.ctx);
    expect(l.calls).toHaveLength(1);
    expect(l.calls[0]).toMatchObject({ symptom: 'estridente', instrument: 'violao' });
    expect(l.calls[0]!.text.startsWith('O som do violão está horrível')).toBe(true);
    expect(next.reply.clarification).toBeDefined();
  });
});

describe('sessões, expiração e revogação', () => {
  it('duas sessões simultâneas não compartilham contexto, consulta nem cache', async () => {
    const l = await lab();
    const a = await l.t.login(OPERATOR_PIN);
    const b = await l.t.login(OPERATOR_PIN);
    expect(await l.principalId(a)).not.toBe(await l.principalId(b));
    let sa = await say(l, a, 'A voz está abafada no retorno.');
    let sb = await say(l, b, 'O surdo está sem grave.');
    sa = await say(l, a, sa.pick(/fred/i)!, sa.ctx);
    sb = await say(l, b, sb.pick(/fones/i)!, sb.ctx);
    const fromA = l.calls.filter((c) => c.symptom === 'abafado'), fromB = l.calls.filter((c) => c.symptom === 'magro');
    expect(fromA.length + fromB.length).toBe(l.calls.length);
    expect(fromA.length).toBeGreaterThanOrEqual(2);
    expect(fromB.length).toBeGreaterThanOrEqual(2);
    for (const c of fromA) { expect(c.text).not.toMatch(/surdo|grave/i); expect(c.channel === undefined || c.channel === 3).toBe(true); }
    for (const c of fromB) { expect(c.text).not.toMatch(/voz|abafad|Fred/i); expect(c.channel).toBe(8); expect(c.instrument).toBe('surdo'); }
    expect(l.cache().size).toBe(2);
    // o carimbo de uma sessão não vale para a outra
    const crossed = await say(l, b, 'Fones', sa.ctx);
    expect(crossed.reply.code ?? crossed.reply.kind).not.toBe('diagnosis');
    expect(sb.reply.diagnosticContext?.id).not.toBe(sa.reply.diagnosticContext?.id);
  });

  it('logout revoga a sessão e descarta o contexto e a consulta guardados; reiniciar começa do zero', async () => {
    const l = await lab();
    const token = await l.t.login(OPERATOR_PIN);
    const id = await l.principalId(token);
    await say(l, token, 'Falta grave no surdo.');
    expect(l.cache().has(id)).toBe(true);
    await l.t.http('/api/logout', { token, body: {} });
    expect(l.cache().has(id)).toBe(false);
    expect((await say(l, token, 'Falta grave no surdo.')).status).toBe(401);
    expect(l.calls).toHaveLength(1);
    // nova sessão do mesmo PIN não herda nada
    const fresh = await l.t.login(OPERATOR_PIN);
    expect(await l.principalId(fresh)).not.toBe(id);
    const s = await say(l, fresh, 'Falta grave no surdo.');
    expect(s.reply.diagnosticContext!.id).toBeTruthy();
    expect(l.calls).toHaveLength(2);
  });

  it('a consulta guardada expira em 60 s; o esclarecimento expira em 5 min e deixa de chamar a base', async () => {
    const l = await lab();
    const token = await l.t.login(OPERATOR_PIN);
    const s = await say(l, token, 'Falta grave no surdo.');
    expect(l.calls).toHaveLength(1);
    l.t.clock.advance(61_000);
    const again = await say(l, token, 'detalhes', s.ctx);
    expect(again.status).toBe(200);
    expect(l.calls, 'passou 1 min: consulta de novo').toHaveLength(2);
    l.t.clock.advance(5 * 60_000);
    const stale = await say(l, token, 'Fones', s.ctx);
    expect(stale.reply.kind).not.toBe('diagnosis');                    // contexto vencido: não chama a base com uma resposta solta
    expect(l.calls).toHaveLength(2);
  });

  it('resultado degradado (base ou Ollama fora) não é guardado: a volta seguinte tenta de novo', async () => {
    const l = await lab();
    const k = (l.t.server.core.assistant as unknown as { opts: { knowledge: LocalKnowledge } }).opts.knowledge;
    (k.enrich as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: Call) => { l.calls.push(structuredClone(input)); return { ...FRESH(), mode: 'keyword', degraded: true }; });
    const token = await l.t.login(OPERATOR_PIN);
    const s = await say(l, token, 'Falta grave no surdo.');
    await say(l, token, 'detalhes', s.ctx);
    expect(l.calls).toHaveLength(2);
    expect(l.cache().size).toBe(0);
  });
});

describe('mensagens quando o sistema não entende', () => {
  it('mostram exemplos de PROBLEMA e de comando, e dizem que nada foi ajustado', async () => {
    const l = await lab();
    const token = await l.t.login(OPERATOR_PIN);
    const principal = l.t.server.core.auth.authenticate(token, '127.0.0.1')!;
    const unknown = await l.t.server.core.assistant!.ask(principal, 'blá blá blá qualquer coisa');
    expect(unknown.text).toContain('A voz está abafada no retorno');
    expect(unknown.text).toContain('O surdo está sem grave');
    expect(unknown.text).toContain('sobe o surdo no PA');
    expect(unknown.text).toContain('Nada foi ajustado');
    const api = await say(l, token, 'blá blá blá qualquer coisa');
    expect(api.status).toBe(400);
    expect(api.reply.text).toContain('Descreva o problema');
    expect(api.reply.text).toContain('A voz está abafada no retorno');
  });

  it('o chat de comandos trata relato de problema como consulta (nunca como comando de volume)', async () => {
    const l = await lab();
    const token = await l.t.login(OPERATOR_PIN);
    const principal = l.t.server.core.auth.authenticate(token, '127.0.0.1')!;
    const write = vi.spyOn(l.t.mixer, 'write');
    for (const phrase of ['Falta grave no surdo', 'Coro cobrindo a voz do Fred', 'O Fred não aparece quando o coro entra', 'O som do violão está horrível', 'O surdo tá seco']) {
      const r = await l.t.server.core.assistant!.ask(principal, phrase);
      expect(r.kind, phrase).toBe('diagnosis');
      expect(JSON.stringify(r), phrase).not.toMatch(/"proposals"|set_level|set_mute|set_master/);
    }
    expect(write).not.toHaveBeenCalled();
  });
});
