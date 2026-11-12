import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { paramKey } from '../src/core/revisions.js';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { RealMixer } from '../src/mixer/real.js';
import { startTestServer, OPERATOR_PIN, MUSICIAN_PIN, wsClient } from './server-support.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(t => t.server.close())); vi.restoreAllMocks(); });
function band(violaoAt3 = false, ambiguous = false) {
  return parseChannels({ channels: [
    { number: 1, name: 'Cavaco', aliases: ['cavaco', 'cavaquinho'] },
    { number: 2, name: violaoAt3 ? 'Voz Fred' : 'Violão seis cordas', aliases: violaoAt3 ? ['fred'] : ['violao', 'violao seis cordas'] },
    { number: 3, name: violaoAt3 || ambiguous ? 'Violão sete cordas' : 'Voz Fred', aliases: violaoAt3 || ambiguous ? ['violao', 'sete cordas'] : ['fred'] },
    { number: 4, name: 'Voz Lucius', aliases: ['lucius', 'voz lucius'] },
    { number: 7, name: 'Voz Laviquinho', aliases: ['laviquinho'] }, { number: 8, name: 'Surdo', aliases: ['surdo'] },
  ], aux: [{ number: 1, name: 'Fones', aliases: ['fones', 'retorno', 'monitor'] }, { number: 5, name: 'Retorno Lucius', aliases: ['retorno do lucius', 'retorno lucius'] }] });
}
const model = 'fixture-model';
const levelIntent = { schemaVersion: 1, operation: 'level', channel: 'c1', destination: 'pa', direction: 'up', amount: 'configured', mode: 'relative' };
async function boot(extra: { violaoAt3?: boolean; ambiguous?: boolean; channels?: ReturnType<typeof band>; provider?: 'ollama' | 'gemini' | 'deepseek' | 'anthropic' | 'openai'; output?: unknown; defer?: boolean; failure?: number; timeout?: boolean; legacyAI?: boolean } = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const fake: typeof fetch = async (url, init) => {
    const address = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url: address, body });
    if (!body) {
      if (address.endsWith('/api/tags')) return Response.json({ models: [{ name: model }] });
      if (address === 'https://api.deepseek.com/models') return Response.json({ data: [{ id: model }] });
      return Response.json({ id: address.split('/').at(-1) });
    }
    started(); if (extra.defer) await new Promise<void>(resolve => { release = resolve; });
    if (extra.timeout) throw Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' });
    if (extra.failure) return new Response('private upstream detail', { status: extra.failure });
    const text = typeof extra.output === 'string' ? extra.output : JSON.stringify(extra.output ?? levelIntent);
    if (address.endsWith('/responses')) return Response.json({ status: 'completed', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 30, output_tokens: 20 } });
    if (address.endsWith('/messages')) return Response.json({ model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 30, output_tokens: 20 } });
    if (address.endsWith('/chat/completions')) return Response.json({ model, choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 30, completion_tokens: 20 } });
    if (address.includes(':generateContent')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 30, totalTokenCount: 50 } });
    if (address.endsWith('/api/chat')) return Response.json({ message: { content: text }, done_reason: 'stop', prompt_eval_count: 30, eval_count: 20 });
    throw Error('Unmocked API');
  };
  const config = Object.fromEntries(['ollama', 'gemini', 'deepseek', 'anthropic', 'openai'].map(id => [id, { enabled: true, models: [model], prices: { [model]: { inputPerMTok: 1, outputPerMTok: 2 } } }]));
  const t = await startTestServer({ channels: extra.channels ?? band(extra.violaoAt3, extra.ambiguous), modelCatalog: { enabled: true, providers: config }, modelCatalogFetch: fake,
    ai: { enabled: extra.legacyAI ?? false }, aiFetch: async () => { throw Error('Legacy provider must not be called'); },
    knowledgeConfig: { external: { maxRequestsPerMinute: 100 } }, openaiApiKey: 'FAKE_OPERATOR_OPENAI_KEY', geminiApiKey: 'FAKE_OPERATOR_GEMINI_KEY', deepseekApiKey: 'FAKE_OPERATOR_DEEPSEEK_KEY', aiKey: 'FAKE_OPERATOR_ANTHROPIC_KEY' });
  servers.push(t); const token = await t.login(OPERATOR_PIN); let seq = 0;
  const ask = async (text: string, who = token) => (await t.http('/api/assistant/ask', { token: who, body: { text } })).json.reply;
  const apply = async (id: string, who = token) => (await t.http(`/api/assistant/proposals/${id}/apply`, { token: who, body: { requestId: `operator-${++seq}` } })).json;
  const choose = async (provider = extra.provider ?? 'ollama', who = token, expectedRevision = 0) => {
    const result = await t.http('/api/ai/models/selection', { token: who, body: { schemaVersion: 1, provider, model, expectedRevision, confirmExternal: true } });
    expect(result.status).toBe(200);
  };
  return { ...t, token, ask, apply, choose, calls, waiting, release: () => release() };
}
const value = (t: Awaited<ReturnType<typeof boot>>, key: string) => (t.mixer.read(key as never) as { value?: unknown }).value;
it('1: violão CH3 no AUX5 +2 dB, prévia correta, execução única pelo core e leitura de retorno', async () => {
  const t = await boot({ violaoAt3: true }), execute = vi.spyOn(t.server.core, 'execute'), write = vi.spyOn(t.mixer, 'write');
  const key = paramKey.level(3, auxBus(5)), reply = await t.ask('Sobe 2 dB do meu violão no AUX 5.');
  expect(reply.kind).toBe('proposals'); const card = reply.proposals[0];
  expect(card).toMatchObject({ title: 'AUX 5: Violão sete cordas', current: '−20.0 dB', result: '−18.0 dB', bus: { kind: 'aux', aux: 5 } });
  expect(card.parameters[0]).toMatchObject({ key, previous: -20, target: -18 }); expect(write).not.toHaveBeenCalled();
  const applied = await t.apply(card.id); expect(applied.status).toBe('applied'); expect(applied.verification.outcome).toBe('confirmed');
  expect(value(t, key)).toBe(-18); expect(execute).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1); expect(t.calls).toHaveLength(0);
  expect((await t.apply(card.id)).status).toBe('not_found'); expect(write).toHaveBeenCalledTimes(1);
});
it('mapa real atual resolve violão CH2 e Fred CH3; não troca instrumento para satisfazer exemplo fixo', async () => {
  const channels = parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8')));
  const t = await boot({ channels }); const reply = await t.ask('Sobe o violão no PA');
  expect(reply.proposals[0].parameters[0].key).toBe('ch.2.main.level');
  const conflict = await t.ask('Sobe o violão CH3 no PA'); expect(conflict.kind).toBe('clarify'); expect(conflict.proposals).toBeUndefined();
});
it('2: abaixar cavaco no PA usa passo configurado e não escreve até Aplicar', async () => {
  const t = await boot(); const r = await t.ask('Abaixa um pouco o cavaco no PA');
  expect(r.proposals[0]).toMatchObject({ current: '−10.0 dB', result: '−12.0 dB' }); expect(value(t, 'ch.1.main.level')).toBe(-10);
  expect((await t.apply(r.proposals[0].id)).status).toBe('applied'); expect(value(t, 'ch.1.main.level')).toBe(-12);
});
it('3: mutar/desmutar CH7 é reversível e se limita ao parâmetro confirmado', async () => {
  const t = await boot();
  for (const [text, expected] of [['Muta o canal 7 no PA', true], ['Desmuta CH7 no PA', false]] as const) {
    const r = await t.ask(text); expect(r.kind).toBe('proposals'); expect((await t.apply(r.proposals[0].id)).verification.outcome).toBe('confirmed'); expect(value(t, 'ch.7.main.mute')).toBe(expected);
  }
});
it('4: fonte e retorno do músico são resolvidos em diretórios separados', async () => {
  const t = await boot(); const r = await t.ask('Abaixa um pouco o cavaco no retorno do Lucius');
  expect(r.proposals).toHaveLength(1); expect(r.proposals[0].parameters[0].key).toBe('ch.1.aux.5.level');
  const voice = await t.ask('Muta Lucius no PA'); expect(voice.proposals[0].parameters[0].key).toBe('ch.4.main.mute');
});
it('retorno sem alias não é inventado a partir do músico', async () => {
  const t = await boot({ channels: parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))) });
  const r = await t.ask('Abaixa o cavaco no retorno do Lucius'); expect(r.kind).toBe('clarify'); expect(r.proposals).toBeUndefined();
});
it('5: destino ausente faz uma pergunta, preserva o pedido e aceita resposta PA', async () => {
  const t = await boot(); const r = await t.ask('Aumenta meu violão'); expect(r.kind).toBe('clarify'); expect(r.proposals).toBeUndefined();
  const answered = await t.ask('PA'); expect(answered.kind).toBe('proposals'); expect(answered.proposals[0].parameters[0].key).toBe('ch.2.main.level');
});
it('6: alias singular duplicado pergunta o canal, sem aplicar nos dois', async () => {
  const t = await boot({ ambiguous: true }); const r = await t.ask('Sobe o violão no PA'); expect(r.kind).toBe('clarify'); expect(r.proposals).toBeUndefined();
  const answered = await t.ask(r.options[1].text); expect(answered.kind).toBe('proposals'); expect(answered.proposals).toHaveLength(1); expect(answered.proposals[0].parameters[0].key).toBe('ch.3.main.level');
});
it('7: limite absoluto inválido é recusado; passo crítico válido exige aprovação humana do core', async () => {
  const t = await boot(); const write = vi.spyOn(t.mixer, 'write');
  const invalid = await t.ask('Sobe o cavaco 999 dB no PA'); expect(invalid.proposals).toBeUndefined();
  const large = await t.ask('Sobe 8 dB o cavaco no PA'); expect(large.proposals[0].needsApproval).toBe(true);
  const pending = await t.apply(large.proposals[0].id); expect(pending.status).toBe('awaiting_approval'); expect(write).not.toHaveBeenCalled();
  const approved = await t.http(`/api/pending/${pending.result.pendingId}/approve`, { token: t.token, body: { requestId: 'approve-critical' } });
  expect(approved.status).toBe(200); expect(write).toHaveBeenCalledTimes(1);
});
it('8: mudança externa entre prévia e confirmação exige nova prévia', async () => {
  const t = await boot(), r = await t.ask('Sobe 2 dB do violão no AUX5');
  await t.command(t.token, { type: 'set_level', channel: 2, aux: 5, db: -25 });
  const write = vi.spyOn(t.mixer, 'write'), apply = await t.apply(r.proposals[0].id);
  expect(apply.status).toBe('recalculated'); expect(apply.proposal).toMatchObject({ current: '−25.0 dB', result: '−23.0 dB' }); expect(write).not.toHaveBeenCalled();
});
it('9: desfazer usa a mesma pilha e confirma leitura; alterar a prévia retornada não muda a pilha', async () => {
  const t = await boot(); const r = await t.ask('Sobe 2 dB do violão no AUX5'); await t.apply(r.proposals[0].id);
  const preview = t.controller.peekUndo()!; preview.targets[0].before = -1;
  const undo = await t.ask('Desfaz o último ajuste'); expect(undo.kind).toBe('proposals');
  const applied = await t.apply(undo.proposals[0].id); expect(applied.status).toBe('applied'); expect(applied.verification.outcome).toBe('confirmed'); expect(value(t, 'ch.2.aux.5.level')).toBe(-20);
});
it('10: desconexão impede preparar/aplicar, sem reenvio ao recuperar', async () => {
  const t = await boot(), r = await t.ask('Sobe o cavaco no PA'); await t.mixer.disconnect(); const write = vi.spyOn(t.mixer, 'write');
  const now = await t.ask('Sobe o cavaco no PA'); expect(now.proposals).toBeUndefined(); expect((await t.apply(r.proposals[0].id)).status).toBe('failed');
  await t.mixer.connect(); expect(write).not.toHaveBeenCalled();
});
it('11: falta de grave no surdo CH8 usa diagnóstico existente e observações LAB sem correção automática', async () => {
  const t = await boot(); const write = vi.spyOn(t.mixer, 'write');
  const reply = await t.ask('O surdo do canal 8 está sem grave no PA.');
  expect(reply.kind).toBe('diagnosis'); expect(reply.observations).toMatchObject({ channel: 8, destination: 'PA', mode: 'lab' });
  expect(reply.observations.parameters.find((p: any) => p.key === 'ch.8.eq.hpf.freq')).toMatchObject({ status: 'known', capability: 'simulated_only', value: 20 });
  expect(reply.observations.unavailable).toEqual(expect.arrayContaining(['preamp_gain', 'hardware_routing', 'audio_spectrum']));
  expect(reply.proposals).toBeUndefined(); expect(write).not.toHaveBeenCalled();
});
it('12: músico só consulta/ajusta canal vinculado e AUX autorizado; sem master ou AUX5', async () => {
  const t = await boot(), musician = await t.login(MUSICIAN_PIN, [2]);
  const own = await t.ask('Sobe o violão nos fones', musician); expect(own.kind).toBe('proposals'); expect((await t.apply(own.proposals[0].id, musician)).status).toBe('applied');
  expect((await t.ask('Sobe o cavaco nos fones', musician)).code).toBe('FORBIDDEN');
  expect((await t.ask('Sobe o violão no AUX5', musician)).code).toBe('FORBIDDEN');
  expect((await t.ask('Quanto está o cavaco nos fones?', musician)).code).toBe('FORBIDDEN');
});
it('consulta e explicação usam leitura real do espelho, sem inventar valor ou executar comando', async () => {
  const t = await boot(); const execute = vi.spyOn(t.server.core, 'execute');
  expect((await t.ask('Quanto está o surdo no PA?')).text).toContain('−10.0 dB');
  const config = await t.ask('Explique a configuração do surdo no PA'); expect(config.observations.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'ch.8.eq.b1.gain' })]));
  await t.mixer.disconnect(); expect((await t.ask('Quanto está o surdo no PA?')).text).toContain('indisponível'); expect(execute).not.toHaveBeenCalled();
});
it.each(['ollama', 'gemini', 'deepseek', 'anthropic', 'openai'] as const)('provedor %s selecionado interpreta intenção estrita sem executar por conta própria', async provider => {
  const t = await boot({ provider }); await t.choose();
  const r = await t.ask('Dê um reforço ao cavaco no PA'); expect(r.source).toBe('ai'); expect(r.kind).toBe('proposals'); expect(value(t, 'ch.1.main.level')).toBe(-10);
  expect((await t.apply(r.proposals[0].id)).status).toBe('applied'); expect(value(t, 'ch.1.main.level')).toBe(-8);
  expect(t.calls.filter(c => c.body)).toHaveLength(1);
});
it.each([{ failure: 503 }, { timeout: true }])('13: falha/timeout do modelo não cria proposta nem altera mesa (%j)', async options => {
  const t = await boot(options); await t.choose('openai'); const write = vi.spyOn(t.mixer, 'write');
  const r = await t.ask('Dê um reforço ao cavaco no PA'); expect(r.kind).toBe('error'); expect(r.proposals).toBeUndefined(); expect(write).not.toHaveBeenCalled();
});
it('14: guardas REAL bloqueiam propostas/aplicar sem instanciar ou escrever RealMixer', async () => {
  const t = await boot(), proposed = await t.ask('Sobe o cavaco no PA');
  const realWrite = vi.spyOn(RealMixer.prototype, 'write'), localWrite = vi.spyOn(t.mixer, 'write');
  const descriptor = Object.getOwnPropertyDescriptor(t.mixer, 'mode')!;
  Object.defineProperty(t.mixer, 'mode', { configurable: true, value: 'real' });
  try {
    expect((await t.ask('Sobe o cavaco no PA')).code).toBe('REAL_READ_ONLY');
    expect((await t.apply(proposed.proposals[0].id)).status).toBe('failed'); expect(localWrite).not.toHaveBeenCalled(); expect(realWrite).not.toHaveBeenCalled();
  } finally { Object.defineProperty(t.mixer, 'mode', descriptor); }
});
it.each([
  { ...levelIntent, approved: true }, { schemaVersion: 1, operation: 'write', path: 'i.1.mix', value: 1 },
  { ...levelIntent, channel: 'c8' }, { ...levelIntent, destination: 'a5' }, { ...levelIntent, value: 3 }, 'texto solto não estruturado',
])('JSON inválido, autorização forjada, fonte/destino/valor inventados são recusados %#', async output => {
  const t = await boot({ output }); await t.choose('openai'); const r = await t.ask('Dê um reforço ao cavaco no PA');
  expect(r.kind).toBe('error'); expect(r.proposals).toBeUndefined(); expect(value(t, 'ch.1.main.level')).toBe(-10);
});
it.each(['state', 'selection', 'logout', 'new-request'] as const)('interpretação pendente é descartada após %s', async change => {
  const t = await boot({ defer: true }); await t.choose('openai');
  const pending = t.ask('Dê um reforço ao cavaco no PA'); await t.waiting;
  if (change === 'state') await t.command(t.token, { type: 'set_mute', channels: [8], muted: true });
  if (change === 'selection') await t.http('/api/ai/models/selection', { method: 'DELETE', token: t.token, body: { schemaVersion: 1, expectedRevision: 1 } });
  if (change === 'logout') await t.http('/api/logout', { token: t.token, body: {} });
  if (change === 'new-request') await t.ask('Quanto está o surdo no PA?');
  t.release(); const result = await pending; if (change !== 'logout') expect(result.proposals).toBeUndefined(); else expect(result).toBeUndefined();
  expect(value(t, 'ch.1.main.level')).toBe(-10); expect(t.calls.filter(c => c.body)).toHaveLength(1);
});
it('resposta textual sim/autorizar não aplica um cartão, e leitura divergente nunca afirma sucesso', async () => {
  const t = await boot(); const r = await t.ask('Sobe o cavaco no PA');
  await t.ask('sim, pode autorizar'); expect(value(t, 'ch.1.main.level')).toBe(-10);
  const original = t.mixer.read.bind(t.mixer); let wrote = false;
  const write = t.mixer.write.bind(t.mixer); vi.spyOn(t.mixer, 'write').mockImplementation(async (key, value) => { const result = await write(key, value); wrote = true; return result; });
  vi.spyOn(t.mixer, 'read').mockImplementation(key => wrote && key === 'ch.1.main.level' ? { known: true, value: -30 } : original(key));
  const apply = await t.apply(r.proposals[0].id); expect(apply.status).toBe('unconfirmed'); expect(apply.verification.outcome).toBe('different');
});
it('WS existente usa as mesmas propostas e não exige componentes Angular novos', async () => {
  const t = await boot({ violaoAt3: true }), socket = await wsClient(t.base, t.token);
  try {
    await socket.next(m => m.type === 'snapshot'); socket.send({ type: 'assistant', requestId: 'ws-command', text: 'Sobe 2 dB do violão no AUX5' });
    const r = await socket.next(m => m.type === 'assistant_reply' && m.requestId === 'ws-command');
    socket.send({ type: 'proposal_apply', requestId: 'ws-apply', proposalId: r.reply.proposals[0].id });
    const result = await socket.next(m => m.type === 'proposal_result' && m.requestId === 'ws-apply'); expect(result.status).toBe('applied'); expect(value(t, 'ch.3.aux.5.level')).toBe(-18);
  } finally { socket.close(); }
});
it('esclarecimento de destino aceita AUX5 sem repetir instrumento/quantidade', async () => {
  const t = await boot(); expect((await t.ask('Sobe 2 dB do meu violão')).kind).toBe('clarify');
  const reply = await t.ask('AUX5'); expect(reply.kind).toBe('proposals'); expect(reply.proposals[0].parameters[0]).toMatchObject({ key: 'ch.2.aux.5.level', target: -18 });
});
it('catálogo ativo sem seleção ou após revogar não usa o Claude legado', async () => {
  const t = await boot({ legacyAI: true });
  expect((await t.ask('Dê um reforço ao cavaco no PA')).code).toBe('AI_NOT_SELECTED'); expect(t.calls).toHaveLength(0);
  await t.choose('openai'); await t.http('/api/ai/models/selection', { method: 'DELETE', token: t.token, body: { schemaVersion: 1, expectedRevision: 1 } });
  expect((await t.ask('Dê um reforço ao cavaco no PA')).code).toBe('AI_NOT_SELECTED'); expect(t.calls.filter(c => c.body)).toHaveLength(0);
});
it('API HTTP recusa autorização, comandos brutos, sessão forjada, outra origem e outro dono do cartão', async () => {
  const t = await boot(), card = (await t.ask('Sobe o cavaco no PA')).proposals[0];
  expect((await t.http('/api/assistant/ask', { body: { text: 'Sobe o cavaco' } })).status).toBe(401);
  expect((await t.http('/api/assistant/ask', { token: t.token, body: { text: 'Sobe o cavaco', approved: true } })).status).toBe(400);
  const other = await t.login(OPERATOR_PIN); expect((await t.apply(card.id, other)).status).toBe('not_found');
  const foreign = await fetch(t.base + '/api/assistant/ask', { method: 'POST', headers: { authorization: `Bearer ${t.token}`, origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Muta CH7 no PA' }) });
  expect(foreign.status).toBe(403); expect(value(t, 'ch.7.main.mute')).toBe(false);
  const forged = await t.http(`/api/assistant/proposals/${card.id}/apply`, { token: t.token, body: { requestId: 'invalid-extra', command: { type: 'set_level' }, approved: true } }); expect(forged.status).toBe(400);
});
it('prompt usa estado do AUX pedido e histórico sanitizado, sem IDs de sessão/chaves/tools', async () => {
  const t = await boot({ output: { ...levelIntent, channel: 'c2', destination: 'a5' } });
  const setup = await t.command(t.token, { type: 'set_level', channel: 2, aux: 5, db: -23 }); expect(setup.json.result.ok).toBe(true); await t.choose('openai');
  const reply = await t.ask('Dê um reforço ao violão no AUX5'); expect(reply.kind).toBe('proposals');
  const request = t.calls.find(c => c.body)!.body, prompt = JSON.parse(request.input);
  expect(prompt.state).toMatchObject({ channel: 2, destination: 'AUX5', mode: 'lab' });
  expect(prompt.state.parameters.find((p: any) => p.key === 'ch.2.aux.5.level')).toMatchObject({ value: -23, status: 'known' });
  expect(prompt.history.operations.at(-1)).toMatchObject({ action: 'set_level' });
  expect(request.tools).toBeUndefined(); expect(JSON.stringify(request)).not.toMatch(/FAKE_OPERATOR|Bearer|actorId|sessionId|apiKey/);
});
it('pedido negativo não prepara uma operação positiva', async () => {
  const t = await boot(); const result = await t.ask('Não muta o canal 7 no PA'); expect(result.kind).toBe('answer'); expect(result.proposals).toBeUndefined();
});
it('nome do músico junto ao instrumento não transforma uma fonte ambígua em lote', async () => {
  const t = await boot(); const result = await t.ask('Abaixa o cavaco do Lucius no PA');
  expect(result.kind).toBe('clarify'); expect(result.proposals).toBeUndefined(); expect(value(t, 'ch.1.main.level')).toBe(-10); expect(value(t, 'ch.4.main.level')).toBe(-10);
});
it('aprovação crítica obsoleta após mudança externa não aplica o alvo antigo', async () => {
  const t = await boot(); const reply = await t.ask('Sobe 8 dB do cavaco no PA'); const pending = await t.apply(reply.proposals[0].id);
  expect(pending.status).toBe('awaiting_approval');
  const setup = await t.command(t.token, { type: 'set_level', channel: 1, db: -13 }); expect(setup.json.result.ok).toBe(true);
  const write = vi.spyOn(t.mixer, 'write'); const result = await t.http(`/api/pending/${pending.result.pendingId}/approve`, { token: t.token, body: { requestId: 'stale-approve' } });
  expect(result.json.result.ok).toBe(false); expect(write).not.toHaveBeenCalled(); expect(value(t, 'ch.1.main.level')).toBe(-13);
});
it('logout de operador enquanto sua alteração espera na fila bloqueia a escrita', async () => {
  const t = await boot(); const reply = await t.ask('Sobe o cavaco no PA');
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const original = t.mixer.write.bind(t.mixer);
  const write = vi.spyOn(t.mixer, 'write').mockImplementationOnce(async (key, value) => { entered(); await new Promise<void>(resolve => { release = resolve; }); return original(key, value); });
  const other = await t.login(OPERATOR_PIN);
  const held = t.command(other, { type: 'set_mute', channels: [8], muted: true });
  await waiting;
  const execute = vi.spyOn(t.server.core, 'execute'), apply = t.apply(reply.proposals[0].id);
  await vi.waitFor(() => expect(execute.mock.calls.some(([, request]) => (request.command as any)?.type === 'set_level')).toBe(true), { timeout: 5000 });
  await t.http('/api/logout', { token: t.token, body: {} }); release(); await held; await apply;
  expect(write.mock.calls.filter(([key]) => key === 'ch.1.main.level')).toHaveLength(0); expect(value(t, 'ch.1.main.level')).toBe(-10);
});

it('diagnóstico de retorno cadastrado AUX5 não é silenciosamente convertido em FONES/AUX1', async () => {
  const t = await boot(), write = vi.spyOn(t.mixer, 'write');
  for (const text of ['O surdo está sem grave no AUX5', 'O surdo está sem grave no retorno do Lucius']) {
    const reply = await t.ask(text); expect(reply.code).toBe('DIAGNOSIS_DESTINATION_UNSUPPORTED'); expect(reply.observations).toBeUndefined(); expect(reply.proposals).toBeUndefined();
  }
  expect(write).not.toHaveBeenCalled();
});

it('retorno sem nome seguido de complemento após pontuação continua sendo FONES (regressão do diagnóstico de M1)', async () => {
  const { resolveDestination } = await import('../src/assistant/mixer-operator/parser.js');
  const { ChannelMap } = await import('../src/core/channels.js');
  const names = new ChannelMap(band(), { inputs: 12, aux: 6 });
  expect(resolveDestination('Fred está abafado só no retorno, também sozinho.', names)).toMatchObject({ dest: 'fones' });
  expect(resolveDestination('Fred está abafado só no retorno, também sozinho.', names).problemCode).toBeUndefined();
  expect(resolveDestination('o surdo está sem grave no retorno do Lucius', names)).toMatchObject({ dest: 'fones', aux: 5 });
});
