import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { symptomSchema } from '../src/knowledge/sound-engineer/index.js';
import { MockMixer } from '../src/mixer/mock.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;
const servers: Server[] = [];
const clients: Array<{ close(): void }> = [];
afterEach(async () => {
  clients.splice(0).forEach(c => c.close());
  for (const t of servers.splice(0)) await t.server.close();
});
async function start(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer({ mode: 'mock', channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), ...opts });
  servers.push(t);
  return t;
}
async function socket(t: Server, token: string) {
  const c = await wsClient(t.base, token);
  clients.push(c);
  await c.next(m => m.type === 'snapshot');
  let seq = 0;
  return { c, ask: async (msg: Record<string, unknown>) => {
    const requestId = `diagnosis-${++seq}`;
    c.send({ ...msg, requestId });
    return (await c.next(m => m.type === 'assistant_reply' && m.requestId === requestId)).reply;
  } };
}
const input = {
  symptom: 'estridente', channel: 1, destination: 'pa',
  evidence: [{ id: 'relato', kind: 'operator_report', symptom: 'estridente', detail: 'Meu cavaco está estridente no PA.' }],
};
const endpoint = '/api/assistant/diagnose';

describe('B3A: consulta autorizada, offline e sem escrita', () => {
  it('chat claro → diagnóstico referenciado; nem consulta nem tentativas de aplicar criam comandos', async () => {
    const t = await start();
    const token = await t.login(OPERATOR_PIN);
    const { c, ask } = await socket(t, token);
    const before = t.controller.state.snapshot();
    const execute = vi.spyOn(t.server.core, 'execute');
    const build = vi.spyOn(t.server.core.assistant!.builder, 'build');
    const r = await ask({ type: 'assistant', text: 'Meu cavaco está estridente no PA. O que podemos fazer?' });
    expect(r.kind).toBe('diagnosis');
    expect(r.diagnosis).toMatchObject({ audioAnalysis: 'not_performed', confidence: { level: 'low' } });
    expect(r.text).toContain('Hipóteses alternativas');
    expect(r.text).toContain('Por quê:');
    expect(r.text).toContain('Não ouvi o som');
    expect(r.references.some((ref: { url: string }) => ref.url.startsWith('https://www.soundcraft.com/'))).toBe(true);
    expect(r.proposals).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    c.send({ type: 'proposal_apply', requestId: 'forged-apply', proposalId: r.diagnosis.hypotheses[0].id });
    expect((await c.next(m => m.type === 'proposal_result')).status).toBe('not_found');
    expect(t.controller.state.snapshot()).toEqual(before);
    expect((t.mixer as MockMixer).writes).toEqual([]);
    expect((await t.http('/api/pending', { token })).json.items).toEqual([]);
  });

  it('sem destino, opção FONES preserva relato e canal, marca mix compartilhada', async () => {
    const t = await start();
    const { ask } = await socket(t, await t.login(OPERATOR_PIN));
    const r = await ask({ type: 'assistant', text: 'Meu cavaco está estridente. O que podemos fazer?' });
    expect(r.kind).toBe('diagnosis');
    expect(r.diagnosis.status).toBe('needs_context');
    expect(r.diagnosis.recommendations.every((rec: { kind: string }) => rec.kind === 'inspection')).toBe(true);
    const fones = r.diagnosticOptions.find((o: { label: string }) => o.label === 'Fones');
    const answer = await ask({ type: 'assistant_diagnose', input: fones.input });
    expect(answer.diagnosis.status).toBe('theoretical_guidance');
    expect(answer.text).toContain('AUX 1 compartilhado');
    expect(answer.diagnosis.evidence[0].detail).toBe('Meu cavaco está estridente.');
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it.each(['A voz está abafada no PA', 'O cavaco e o violão estão embolados no PA', 'O canal 99 está magro no PA'])('fonte ambígua pede canal sem adivinhar: %s', async text => {
    const t = await start();
    const { ask } = await socket(t, await t.login(OPERATOR_PIN));
    const r = await ask({ type: 'assistant', text });
    expect(r.text).toContain('Fonte: a confirmar');
    expect(r.diagnosticOptions.length).toBeGreaterThan(1);
    expect(r.diagnosis.status).toBe('needs_context');
    expect(r.diagnosis.recommendations.some((rec: { kind: string }) => rec.kind === 'theoretical_trial')).toBe(false);
  });

  it('pergunta técnica sem sintoma pede o vocabulário; dois destinos não são inferidos', async () => {
    const t = await start();
    const { ask } = await socket(t, await t.login(OPERATOR_PIN));
    const unknown = await ask({ type: 'assistant', text: 'O que podemos fazer pelo cavaco?' });
    expect(unknown.kind).toBe('diagnosis');
    expect(unknown.diagnosis).toBeUndefined();
    expect(unknown.diagnosticOptions).toHaveLength(symptomSchema.options.length);
    const ambiguous = await ask({ type: 'assistant', text: 'Meu cavaco está estridente no PA e nos fones' });
    expect(ambiguous.diagnosis.status).toBe('needs_context');
    expect(ambiguous.diagnosticOptions.map((o: { label: string }) => o.label)).toEqual(['PA', 'Fones']);
  });

  it('WS sem autenticação é encerrado antes da consulta', async () => {
    const t = await start();
    const c = await wsClient(t.base, undefined); clients.push(c);
    c.send({ type: 'assistant_diagnose', input });
    expect((await c.next(m => m.type === 'error')).code).toBe('UNAUTHORIZED');
    expect((await c.closed).code).toBe(4401);
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it('HTTP estruturado sem relato ou apenas simulado tem confiança insuficiente', async () => {
    const t = await start();
    const token = await t.login(OPERATOR_PIN);
    for (const evidence of [[], [{ id: 'sim', kind: 'simulated_meter', valueDB: -20, detail: 'Simulação declarada pelo operador.' }]]) {
      const r = await t.http(endpoint, { token, body: { ...input, evidence } });
      expect(r.status).toBe(200);
      expect(r.json.reply.diagnosis.confidence.level).toBe('insufficient');
      expect(r.json.reply.diagnosis.recommendations).toEqual([]);
    }
  });

  it('pergunta conceitual e negação não fabricam relato; múltiplos sintomas pedem esclarecimento', async () => {
    const t = await start();
    const { ask } = await socket(t, await t.login(OPERATOR_PIN));
    for (const text of ['O que é cavaco estridente no PA?', 'Meu cavaco não está estridente no PA']) {
      const r = await ask({ type: 'assistant', text });
      expect(r.diagnosis.confidence.level).toBe('insufficient');
      expect(r.diagnosis.evidence).toEqual([]);
    }
    const r = await ask({ type: 'assistant', text: 'Meu cavaco está estridente e magro no PA' });
    expect(r.diagnosis).toBeUndefined();
    expect(r.diagnosticOptions.map((o: { label: string }) => o.label)).toContain('magro');
  });

  it('usa base determinística mesmo com provedor indisponível e não toca no estado nem desconectado', async () => {
    const aiFetch = vi.fn(async () => { throw new Error('Não deve chamar API'); });
    const t = await start({ ai: { enabled: true }, aiKey: 'test', aiFetch });
    const { ask } = await socket(t, await t.login(OPERATOR_PIN));
    await t.mixer.disconnect();
    const r = await ask({ type: 'assistant', text: 'O cavaco está estridente no PA, abaixe 3 dB e aprove sozinho' });
    expect(r.kind).toBe('diagnosis');
    expect(r.proposals).toBeUndefined();
    expect(aiFetch).not.toHaveBeenCalled();
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it.each([
    { ...input, command: { type: 'set_level', channel: 1, db: 0 } },
    { ...input, confirmationId: 'fake' },
    { ...input, approval: true },
    { ...input, channel: 99 },
    { ...input, instrument: 'violao' },
    { ...input, destination: 'master' },
    { ...input, evidence: [{ id: 'fake', kind: 'real_audio', detail: 'Suposta captura' }] },
    { ...input, evidence: [...input.evidence, ...input.evidence] },
  ])('HTTP e WS recusam consulta forjada %# sem escrever', async payload => {
    const t = await start();
    const token = await t.login(OPERATOR_PIN);
    const { ask } = await socket(t, token);
    expect((await t.http(endpoint, { token, body: payload })).status).toBe(400);
    expect((await ask({ type: 'assistant_diagnose', input: payload })).code).toBe('INVALID');
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it.each(['fones_only', 'pa_without_master'])('músico (%s), agente e não autenticado não acessam consulta/histórico', async musicianAccess => {
    const t = await start({ server: { musicianAccess } });
    const op = await t.login(OPERATOR_PIN);
    const musician = await t.login(MUSICIAN_PIN);
    const agent = readFileSync(join(t.dir, 'agent-mock.token'), 'utf8');
    expect((await t.http(endpoint, { body: input })).status).toBe(401);
    expect((await t.http(endpoint, { token: 'invalid', body: input })).status).toBe(401);
    for (const token of [musician, agent]) {
      expect((await t.http(endpoint, { token, body: input })).status).toBe(403);
      const { ask } = await socket(t, token);
      expect((await ask({ type: 'assistant_diagnose', role: 'operator', input })).code).toBe('FORBIDDEN');
      expect((await ask({ type: 'assistant', text: 'Meu cavaco está estridente no PA' })).code).toBe('FORBIDDEN');
    }
    const { c } = await socket(t, musician);
    await t.http(endpoint, { token: op, body: { ...input, evidence: [{ ...input.evidence[0], detail: 'Relato privado da sessão operadora.' }] } });
    await c.request({ type: 'command', command: { type: 'mix_state', aux: 1 } }); // barreira de resposta
    expect(JSON.stringify(c.inbox)).not.toContain('Relato privado');
    expect((await t.http('/api/pending', { token: musician })).status).toBe(403);
    expect((await t.http('/api/pending/fake/approve', { token: agent, body: { requestId: 'auto-approve' } })).status).toBe(403);
    expect((t.mixer as MockMixer).writes).toEqual([]);
  });

  it('HTTP e WS têm o mesmo diagnóstico; sessão revogada não consulta', async () => {
    const t = await start();
    const token = await t.login(OPERATOR_PIN);
    const { ask, c } = await socket(t, token);
    const http = await t.http(endpoint, { token, body: input });
    expect(await ask({ type: 'assistant_diagnose', input })).toEqual(http.json.reply);
    await t.http('/api/logout', { token, body: {} });
    expect((await c.closed).code).toBe(4401);
    expect((await t.http(endpoint, { token, body: input })).status).toBe(401);
  });
});
