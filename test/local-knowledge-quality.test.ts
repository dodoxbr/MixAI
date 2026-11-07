import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { isRelevant, loadRelevance, parseRelevance, runEval } from '../src/knowledge/local/eval.js';
import { mentionedModels, modelKeyOf, scopeOf } from '../src/knowledge/local/models.js';
import { OllamaClient } from '../src/knowledge/local/ollama.js';
import { openLocalKnowledge } from '../src/knowledge/local/open.js';
import { createPgClient, PgKnowledgeStore, type SqlClient } from '../src/knowledge/local/pg-store.js';
import { judgeNarrative, LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { chunkText, fuse, reflow } from '../src/knowledge/local/text.js';

const SEED = join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2');
const tmp = () => mkdtempSync(join(tmpdir(), 'mixai-qual-'));
const DIMS = 8;
const OLLAMA = { url: 'http://127.0.0.1:11434', embedModel: 'nomic-embed-text', chatModel: 'llama3.2:3b', embedDimensions: DIMS, timeoutMs: 2000 };

type Chat = string | Error | { status: number };
/** Ollama falso. `chat` pode ser texto, erro (ex.: TimeoutError) ou status HTTP. */
function fakeOllama(opts: { chat?: Chat; chatModel?: boolean; spy?: (url: string, body: { input?: string[]; messages?: Array<{ content: string }> }) => void; options?: Partial<typeof OLLAMA> & { queryPrefix?: string; documentPrefix?: string } } = {}) {
  const fetchFn = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    opts.spy?.(url, body);
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, ...(opts.chatModel === false ? [] : [{ name: 'llama3.2:3b' }])] }));
    if (url.endsWith('/api/embed')) {
      const vec = (t: string) => { const v = new Array(DIMS).fill(0.01); if (/microfonia|feedback/i.test(t)) v[0] = 1; if (/cardioide|polar/i.test(t)) v[2] = 1; return v; };
      return new Response(JSON.stringify({ embeddings: (body.input as string[]).map(vec) }));
    }
    if (url.endsWith('/api/chat')) {
      const c = opts.chat ?? 'Pode ser que o ganho esteja alto; o operador pode conferir o posicionamento do microfone.';
      if (c instanceof Error) throw c;
      if (typeof c === 'object') return new Response('erro interno com segredo-do-servidor', { status: c.status });
      return new Response(JSON.stringify({ message: { content: c } }));
    }
    return new Response('{}', { status: 404 });
  });
  return { client: new OllamaClient({ ...OLLAMA, ...opts.options }, fetchFn as unknown as typeof fetch), fetchFn };
}
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

async function service(opts: { ollama?: OllamaClient; narrative?: boolean; log?: (m: string) => void; search?: 'auto' | 'hybrid'; minScore?: number; docs?: Record<string, string> } = {}) {
  const dir = tmp();
  const store = new FileKnowledgeStore(join(dir, 'knowledge.json'));
  await store.init();
  const k = new LocalKnowledge({ store, ollama: opts.ollama, inboxDir: join(dir, 'inbox'), seedDir: SEED, maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: opts.narrative ?? false, log: opts.log, search: opts.search, minScore: opts.minScore });
  await k.importSeed();
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  for (const [name, text] of Object.entries(opts.docs ?? {})) writeFileSync(join(dir, 'inbox', name), text);
  if (opts.docs) await k.ingest();
  return { k, dir, store };
}
const MIC_DOC = '# Microfonia\n\nA microfonia depende do ganho e do posicionamento do microfone no palco. Reduza o retorno do vocal para evitar a realimentação.';
const narr = (reply: string, log?: (m: string) => void) => service({ ollama: fakeOllama({ chat: reply }).client, narrative: true, log, docs: { 'shure-live.md': MIC_DOC } });
const ask = (k: LocalKnowledge) => k.enrich({ text: 'microfonia no palco', symptom: 'microfonia' });

describe('divisor de trechos de PDF', () => {
  it('reconstrói parágrafos: junta linhas, une hifenização e descarta número de página e pontilhado', () => {
    const page = 'Os microfo-\nnes dinâmicos são\nrobustos para o palco.\n12\nSumário .......... 4\nUse sempre o cabo balanceado.';
    expect(reflow(page)).toBe('Os microfones dinâmicos são robustos para o palco. Use sempre o cabo balanceado.');
  });
  it('página sem linhas em branco vira vários trechos, cortados só em fim de frase, com a última frase repetida', () => {
    const sentence = (n: number) => `Esta é a frase número ${n} do manual sobre posicionamento de microfones no palco.`;
    const page = Array.from({ length: 40 }, (_, i) => sentence(i + 1)).join('\n');
    const chunks = chunkText(page, 'p.7');
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.locator).toBe('p.7');
      expect(c.text.length).toBeLessThanOrEqual(1100);
      expect(c.text).toMatch(/^Esta é a frase/); // nunca começa no meio de uma palavra
      expect(c.text).toMatch(/palco\.$/);
    }
    const lastOfFirst = chunks[0]!.text.match(/Esta é a frase número \d+[^.]*\.$/)![0];
    expect(chunks[1]!.text.startsWith(lastOfFirst)).toBe(true);
  });
  it('frase gigante é cortada em palavras inteiras; texto curto demais não vira trecho', () => {
    const big = 'palavra '.repeat(400).trim();
    const chunks = chunkText(big, 'texto');
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => /^palavra( palavra)*$/.test(c.text))).toBe(true);
    expect(chunkText('oi', 'p.1')).toEqual([]);
  });
});

describe('RRF (busca híbrida)', () => {
  const p = (id: string, score: number, method: string) => ({ documentId: id, locator: 'p.1', excerpt: id, score, method });
  it('trecho que aparece nas duas listas sobe; método vira hybrid; respeita o limite', () => {
    const out = fuse([p('a', 0.9, 'vector'), p('b', 0.8, 'vector'), p('c', 0.7, 'vector')], [p('c', 5, 'keyword'), p('d', 4, 'keyword')], 3);
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).map((x) => x.documentId)).toEqual(['c', 'a']); // 3º lugar é empate legítimo (b e d)
    expect(out.every((x) => x.method === 'hybrid')).toBe(true);
  });
});

describe('modelos de microfone (não misturar P3 S com P5)', () => {
  it('reconhece modelos da família sem confundir com outras palavras', () => {
    expect([...mentionedModels('P3 P5/P5 S Polar pattern cardiod')].sort()).toEqual(['P3', 'P5']);
    expect([...mentionedModels('AKG P5S e P 2')].sort()).toEqual(['P2', 'P5']);
    expect(mentionedModels('PA, P30, SP3 e P10').size).toBe(0);
    expect(modelKeyOf('AKG Perception P3 S')).toBe('P3');
    expect(modelKeyOf('Shure SM58')).toBeUndefined();
    expect(modelKeyOf(null)).toBeUndefined();
  });
  it('escopo do trecho em relação ao microfone do canal', () => {
    expect(scopeOf([], 'P3')).toBe('none');
    expect(scopeOf(['P3'], 'P3')).toBe('match');
    expect(scopeOf(['P3', 'P5'], 'P3')).toBe('mixed');
    expect(scopeOf(['P5'], 'P3')).toBe('other');
    expect(scopeOf(['P5'], undefined)).toBe('none');
    expect(scopeOf(['P3', 'P5'], undefined)).toBe('mixed');
  });
  it('canal com P3 S não recebe trechos que só descrevem o P5; tabela com os dois leva aviso e fica fora do resumo', async () => {
    const seen: string[] = [];
    const docs = {
      'akg-p5.md': '# P5\n\nO P5 tem padrão polar supercardioide e microfonia reduzida em palco barulhento.',
      'akg-p3.md': '# P3\n\nO P3 tem padrão polar cardioide e serve para backing vocals, com microfonia controlável.',
      'akg-family-pdf.md': '# Tabela\n\nP3 P5/P5 S padrão polar cardioide supercardioide microfonia sensibilidade 2.5 mV.',
    };
    const { k } = await service({ docs, narrative: true, ollama: fakeOllama({ spy: (u, b) => { if (u.endsWith('/api/chat')) seen.push(b.messages!.map((m) => m.content).join('\n')); } }).client });
    const generic = await k.enrich({ text: 'padrão polar e microfonia', symptom: 'microfonia' });
    expect(generic.passages.some((x) => x.sourceId === 'akg-p5')).toBe(true); // sem canal: nada é filtrado
    expect(generic.passages.find((x) => x.sourceId === 'akg-family-pdf')?.caution).toMatch(/mais de um modelo \(P3, P5\)/);

    const ch3 = await k.enrich({ text: 'padrão polar e microfonia', symptom: 'microfonia', channel: 3 });
    expect(ch3.passages.some((x) => x.sourceId === 'akg-p5')).toBe(false);
    expect(ch3.modelFilter).toMatchObject({ model: 'P3' });
    expect(ch3.modelFilter!.excluded).toBeGreaterThan(0);
    expect(ch3.passages.some((x) => x.sourceId === 'akg-p3')).toBe(true);
    expect(seen.at(-1)).not.toContain('supercardioide'); // tabela mista não vai para o modelo

    const ch5 = await k.enrich({ text: 'padrão polar e microfonia', symptom: 'microfonia', channel: 5 }); // CH5: modelo não confirmado
    expect(ch5.modelFilter).toBeUndefined();
  });
});

describe('resumo do modelo local: motivos de descarte', () => {
  it('desligado ou sem trechos: não é falha e não entra nas estatísticas', async () => {
    const off = await service({ ollama: fakeOllama().client, narrative: false, docs: { 'shure-live.md': MIC_DOC } });
    expect((await ask(off.k)).narrativeStatus).toMatchObject({ status: 'disabled' });
    const none = await service({ ollama: fakeOllama().client, narrative: true });
    expect((await none.k.enrich({ text: 'zzzz qqqq', symptom: 'microfonia' })).narrativeStatus).toMatchObject({ status: 'no_passages' });
    expect((await off.k.status()).narrativeStats).toEqual({ used: 0, usedBy: {}, dropped: {} });
  });
  it('texto bom é mostrado, conta como usado e as tags <trecho> repetidas são removidas', async () => {
    const { k } = await narr('<trecho n="1">ruído</trecho> Pode ser que o ganho esteja alto no canal; o operador pode conferir o posicionamento.');
    const r = await ask(k);
    expect(r.narrativeStatus).toMatchObject({ status: 'used' });
    expect(r.narrative).toMatchObject({ source: 'ollama', verified: false });
    expect(r.narrative!.text).not.toMatch(/<\/?trecho/);
    expect((await k.status()).narrativeStats.used).toBe(1);
  });
  it.each([
    ['valor_de_processamento', 'Pode ser que falte brilho; tente cortar 3 dB em 250 Hz no canal para testar.'],
    ['comando_da_mesa', 'Pode ser o ganho; envie set_level para o canal e confira o resultado depois.'],
    ['verbo_de_execucao', 'Pode ser o ganho alto; aplique uma redução e confira o resultado com cuidado.'],
    ['afirma_ter_ouvido_ou_medido', 'Pelo que ouvi no áudio do retorno, existe um excesso de graves no vocal agora.'],
    ['afirma_ter_ouvido_ou_medido', 'Eu medi o nível do canal e identifiquei uma sobra de energia no vocal agora.'],
    ['phantom', 'Pode ser que o phantom esteja desligado; o operador pode conferir o microfone e o cabo.'],
    ['phantom', 'Pode ser a alimentação de 48V ausente; o operador pode conferir o microfone e o cabo.'],
  ])('regra %s descarta o texto e registra só o código (nunca o conteúdo)', async (rule, reply) => {
    const logs: string[] = [];
    const { k } = await narr(reply, (m) => logs.push(m));
    const r = await ask(k);
    expect(r.narrative).toBeUndefined();
    expect(r.narrativeStatus).toMatchObject({ status: 'blocked', rule });
    const line = logs.join('\n');
    expect(line).toContain(`motivo=blocked:${rule}`);
    expect(line).not.toMatch(/graves|ganho|vocal|brilho|set_level|phantom e|48V/);
    expect((await k.status()).narrativeStats.dropped[`blocked:${rule}`]).toBe(1);
  });
  it('eco do prompt (só repete o trecho) e resposta vazia são descartados com motivo próprio', async () => {
    const echo = await narr(`<trecho n="1">${MIC_DOC}</trecho>`);
    expect((await ask(echo.k)).narrativeStatus).toMatchObject({ status: 'echo' });
    const empty = await narr('   ');
    expect((await ask(empty.k)).narrativeStatus).toMatchObject({ status: 'empty' });
    const noBase = await narr('Não há base suficiente nos trechos.');
    expect((await ask(noBase.k)).narrativeStatus).toMatchObject({ status: 'empty', rule: 'sem_base' });
  });
  it('timeout, serviço fora e erro HTTP viram motivos distintos, sem vazar a mensagem do servidor', async () => {
    const logs: string[] = [];
    const slow = await narr('x', (m) => logs.push(m));
    const slowClient = fakeOllama({ chat: timeoutError() }).client;
    const t = await service({ ollama: slowClient, narrative: true, log: (m) => logs.push(m), docs: { 'shure-live.md': MIC_DOC } });
    expect((await ask(t.k)).narrativeStatus).toMatchObject({ status: 'timeout' });
    const http = await service({ ollama: fakeOllama({ chat: { status: 500 } }).client, narrative: true, log: (m) => logs.push(m), docs: { 'shure-live.md': MIC_DOC } });
    expect((await ask(http.k)).narrativeStatus).toMatchObject({ status: 'error' });
    const noChat = await service({ ollama: fakeOllama({ chatModel: false }).client, narrative: true, log: (m) => logs.push(m), docs: { 'shure-live.md': MIC_DOC } });
    expect((await ask(noChat.k)).narrativeStatus).toMatchObject({ status: 'unavailable' });
    expect(slow).toBeDefined();
    expect(logs.join('\n')).not.toContain('segredo-do-servidor');
  });
  it('judgeNarrative: as proteções originais continuam valendo e o texto é limitado a 700 caracteres', () => {
    expect(judgeNarrative('Use 250 Hz agora mesmo para resolver o problema do vocal.', [])).toMatchObject({ status: 'blocked' });
    const long = judgeNarrative(`${'Pode ser que o ganho esteja alto no canal. '.repeat(40)}`, []);
    expect('text' in long && long.text.length <= 700).toBe(true);
  });
});

describe('cliente Ollama: geração com motivo e prefixos de embedding', () => {
  it('generateDetailed mapeia a falha sem expor o servidor', async () => {
    expect(await fakeOllama({ chat: timeoutError() }).client.generateDetailed('s', 'u')).toEqual({ failure: 'timeout' });
    expect(await fakeOllama({ chat: { status: 503 } }).client.generateDetailed('s', 'u')).toEqual({ failure: 'error' });
    expect(await fakeOllama({ chat: '  ' }).client.generateDetailed('s', 'u')).toEqual({ failure: 'empty' });
    expect(await fakeOllama({ chatModel: false }).client.generateDetailed('s', 'u')).toEqual({ failure: 'unavailable' });
    expect(await fakeOllama({ chat: 'ok' }).client.generate('s', 'u')).toBe('ok');
  });
  it('prefixos só quando configurados: consulta usa o de consulta, documento usa o de documento', async () => {
    const inputs: string[][] = [];
    const spy = (u: string, b: { input?: string[] }) => { if (u.endsWith('/api/embed')) inputs.push(b.input!); };
    const plain = fakeOllama({ spy }).client;
    await plain.embed(['abc'], 'query');
    const prefixed = fakeOllama({ spy, options: { queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' } }).client;
    await prefixed.embed(['abc'], 'query');
    await prefixed.embed(['abc'], 'document');
    await prefixed.embed(['abc']);
    expect(inputs).toEqual([['abc'], ['search_query: abc'], ['search_document: abc'], ['search_document: abc']]);
  });
});

describe('busca híbrida e limiar configuráveis', () => {
  const rows = (store: FileKnowledgeStore) => store.replaceDocument({
    sourceId: 'shure-live', fileName: 'a.md', sha256: 'x', bytes: 1,
    chunks: [
      { ordinal: 0, locator: 'p.1', text: 'ganho antes da microfonia e posicionamento do palco', embedding: [1, 0, 0, 0, 0, 0, 0, 0] },
      { ordinal: 1, locator: 'p.2', text: 'efeito de proximidade aumenta os graves do vocal', embedding: [0.6, 0.8, 0, 0, 0, 0, 0, 0] },
      { ordinal: 2, locator: 'p.3', text: 'cabos balanceados e conectores xlr', embedding: [0, 0, 1, 0, 0, 0, 0, 0] },
    ],
  });
  it('minScore alto faz o modo auto cair para palavras; híbrido funde os dois e marca hybrid', async () => {
    const store = new FileKnowledgeStore(join(tmp(), 'k.json'));
    await store.init();
    await rows(store);
    const q = [0.9, 0.1, 0, 0, 0, 0, 0, 0];
    expect((await store.search('proximidade graves', q, 3, { mode: 'auto', minScore: 0.3 }))[0]!.method).toBe('vector');
    expect((await store.search('proximidade graves', q, 3, { mode: 'auto', minScore: 0.999 }))[0]!.method).toBe('keyword');
    const hybrid = await store.search('proximidade graves', q, 3, { mode: 'hybrid', minScore: 0.3 });
    expect(hybrid.every((p) => p.method === 'hybrid')).toBe(true);
    expect(hybrid.map((p) => p.locator)).toContain('p.2');
    expect((await store.search('proximidade graves', q, 3))[0]!.method).toBe('vector'); // padrão antigo preservado
  });
  it('no serviço, hybrid continua sendo "busca semântica" para o operador', async () => {
    const { k } = await service({ ollama: fakeOllama().client, search: 'hybrid', docs: { 'shure-live.md': MIC_DOC } });
    const r = await k.search('microfonia no palco');
    expect(r.mode).toBe('vector');
    expect(r.passages.length).toBeGreaterThan(0);
  });
});

describe('coleções reversíveis', () => {
  const loaded = (dir: string, knowledge: Record<string, unknown>) => ({ config: parseConfig({ knowledge: { enabled: true, ...knowledge } }), channels: { channels: [], aux: [] }, configDir: dir, logDir: null, labFile: join(dir, 'lab.json'), dataDir: dir, secrets: {} }) as never;
  it('coleção padrão usa knowledge.json; outra usa arquivo próprio e nunca toca no original', async () => {
    const dir = tmp();
    const def = await openLocalKnowledge(loaded(dir, {}));
    await def!.importSeed();
    const bge = await openLocalKnowledge(loaded(dir, { collection: 'bgem3' }));
    await bge!.importSeed();
    expect(existsSync(join(dir, 'knowledge', 'knowledge.json'))).toBe(true);
    expect(existsSync(join(dir, 'knowledge', 'knowledge-bgem3.json'))).toBe(true);
  });
  it('nome de coleção inválido é recusado na configuração', () => {
    for (const bad of ['Maiuscula', '1abc', 'a-b', 'a b', 'x; DROP SCHEMA public', '']) expect(() => parseConfig({ knowledge: { collection: bad } }), bad).toThrow();
    expect(parseConfig({}).knowledge.collection).toBe('default');
  });
  it('PostgreSQL: coleção vira schema próprio; o padrão continua em public', async () => {
    const calls: string[] = [];
    const client: SqlClient = { query: async (t: string) => { calls.push(t); return { rows: [] } as never; }, end: async () => undefined };
    await new PgKnowledgeStore(client, 1024, Date.now, 'kb_bgem3').init();
    expect(calls).toContain('CREATE SCHEMA IF NOT EXISTS kb_bgem3');
    expect(calls.join('\n')).toContain('vector(1024)');
    calls.length = 0;
    await new PgKnowledgeStore(client, 768).init();
    expect(calls.some((c) => c.includes('CREATE SCHEMA'))).toBe(false);
    expect(() => new PgKnowledgeStore(client, 768, Date.now, 'kb; DROP')).toThrow(/Schema/);
    expect(() => createPgClient({ host: '127.0.0.1', port: 5433, database: 'mixai', user: 'mixai', password: 'x', schema: 'a-b' })).toThrow(/Schema/);
  });
  it('trocar de modelo sem trocar de coleção é detectado: dimensão da coluna x configuração', async () => {
    const client: SqlClient = {
      query: async (t: string) => ({ rows: t.includes('pg_extension') ? [{ v: '0.8.7' }] : t.includes('atttypmod') ? [{ d: 768 }] : [] }) as never,
      end: async () => undefined,
    };
    const bad = await new PgKnowledgeStore(client, 1024).health();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/768 dimensões.*1024.*outra knowledge\.collection/);
    expect((await new PgKnowledgeStore(client, 768).health()).ok).toBe(true);
  });
  it('limiar, tempo do resumo e modo de busca têm padrão seguro e limites', () => {
    const k = parseConfig({}).knowledge;
    expect(k.search).toBe('auto');
    expect(k.ollama.minScore).toBe(0.3);
    expect(k.ollama.narrativeTimeoutMs).toBe(30_000);
    expect(k.ollama.queryPrefix).toBe('');
    expect(() => parseConfig({ knowledge: { search: 'magico' } })).toThrow();
    expect(() => parseConfig({ knowledge: { ollama: { minScore: 1 } } })).toThrow();
    expect(() => parseConfig({ knowledge: { ollama: { narrativeTimeoutMs: 100 } } })).toThrow();
  });
});

describe('avaliação de relevância', () => {
  it('o conjunto versionado é válido: 24 perguntas em 6 temas, cada uma com critério verificável', () => {
    const cases = loadRelevance(join(PROJECT_ROOT, 'knowledge', 'eval', 'relevance-ptbr.json'));
    expect(cases).toHaveLength(24);
    expect(new Set(cases.map((c) => c.topic)).size).toBe(6);
    expect(new Set(cases.map((c) => c.id)).size).toBe(24);
    expect(() => parseRelevance({ schemaVersion: 1, description: 'x', cases: [{ id: 'a', topic: 't', query: 'q?', anyOf: [] }] })).toThrow();
    expect(() => parseRelevance({ schemaVersion: 2, description: 'x', cases: [] })).toThrow();
  });
  it('isRelevant ignora acento e maiúsculas e respeita a restrição de fonte', () => {
    const c = { id: 'a', topic: 't', query: 'pergunta', anyOf: ['passa-alto', 'Proximity Effect'] };
    expect(isRelevant(c, 'O filtro PASSA-ALTO (HPF)', 'x')).toBe(true);
    expect(isRelevant(c, 'o efeito proximity effect aparece', 'x')).toBe(true);
    expect(isRelevant(c, 'cabos balanceados', 'x')).toBe(false);
    expect(isRelevant({ ...c, sources: ['shure-live'] }, 'passa-alto', 'soundcraft')).toBe(false);
    expect(isRelevant({ ...c, anyOf: ['passa alto'] }, 'filtro passa-alto', 'x')).toBe(false); // literal, não regex frouxa
  });
  it('runEval mede os modos de busca em índice temporário e não toca na base de produção', async () => {
    const chunks = [
      { sourceId: 'shure-live', locator: 'p.1', text: 'O efeito de proximidade aumenta os graves quando o vocal chega perto.' },
      { sourceId: 'shure-live', locator: 'p.2', text: 'Cabos balanceados reduzem ruído em lances longos.' },
    ];
    const cases = [{ id: 'c1', topic: 'voz', query: 'voz grave demais perto', anyOf: ['proximidade'] }];
    const embed = async (texts: string[]) => texts.map((t) => (/proximidade|grave|perto/i.test(t) ? [1, 0, 0, 0] : [0, 1, 0, 0]));
    const r = await runEval({ chunks, cases, k: 2, embedder: { name: 'falso', embed }, sweep: [0.5] });
    expect(r.methods.map((m) => m.method)).toEqual(['keyword', 'vector', 'auto', 'hybrid', 'auto@0.5']);
    const vector = r.methods.find((m) => m.method === 'vector')!;
    expect(vector).toMatchObject({ hit1: 1, hitK: 1, mrr: 1, misses: [] });
    expect(r).toMatchObject({ embedder: 'falso', dimensions: 4, chunks: 2, cases: 1 });
    expect((await runEval({ chunks, cases, k: 2 })).methods.map((m) => m.method)).toEqual(['keyword']);
  });
});

describe('base fora do ar (PostgreSQL parado)', () => {
  it('o status descreve a indisponibilidade em vez de falhar e não vaza a mensagem do banco', async () => {
    const { k, store } = await service({ ollama: fakeOllama().client, docs: { 'shure-live.md': MIC_DOC } });
    const boom = new Error('connect ECONNREFUSED 127.0.0.1:5433 senha=segredo');
    vi.spyOn(store, 'listSources').mockRejectedValue(boom);
    vi.spyOn(store, 'listDocuments').mockRejectedValue(boom);
    const s = await k.status();
    expect(s).toMatchObject({ mode: 'deterministic', sources: 0, documents: 0, chunks: 0, packLoaded: false });
    expect(s.store).toMatchObject({ ok: false, detail: 'Base indisponível no momento.' });
    expect(s.note).toMatch(/motor determinístico/);
    expect(JSON.stringify(s)).not.toMatch(/segredo|ECONNREFUSED|5433/);
  });
  it('a ficha do microfone continua vindo do pacote versionado, com o aviso de segurança', async () => {
    const { k, store } = await service();
    vi.spyOn(store, 'getMicrophones').mockRejectedValue(new Error('banco fora'));
    vi.spyOn(store, 'search').mockRejectedValue(new Error('banco fora'));
    const r = await k.enrich({ text: 'Fred está microfonando', symptom: 'microfonia', channel: 3 });
    expect(r).toMatchObject({ mode: 'deterministic', degraded: true, passages: [], reason: 'Base de conhecimento indisponível.' });
    expect(r.microphone).toMatchObject({ channel: 'CH3', musician: 'Fred', model: 'AKG Perception P3 S' });
    expect(r.microphone!.note).toMatch(/Não aplicar EQ\/preset uniforme/);
    const unconfirmed = await k.enrich({ text: 'x microfonia', symptom: 'microfonia', channel: 5 });
    expect(unconfirmed.microphone).toMatchObject({ model: null });
  });
});

describe('busca por palavras no PostgreSQL (fallback sem Ollama)', () => {
  it('pergunta natural vira consulta OR: não exige todas as palavras no mesmo trecho', async () => {
    const { orTsQuery } = await import('../src/knowledge/local/pg-store.js');
    expect(orTsQuery('O Fred está microfonando no PA')).toBe('fred | está | microfonando');
    expect(orTsQuery('Voz abafada no retorno!')).toBe('voz | abafada | retorno');
    expect(orTsQuery('de a o')).toBe('');
  });
  it('só letras e números entram: operadores do tsquery não passam', async () => {
    const { orTsQuery } = await import('../src/knowledge/local/pg-store.js');
    const q = orTsQuery("microfonia' & !(grave) | <-> :* ; DROP TABLE knowledge_chunks --");
    expect(q).not.toMatch(/[&!()<>:*;'-]/);
    expect(q.split(' | ').every((w) => /^[\p{L}\p{N}]+$/u.test(w))).toBe(true);
    expect(orTsQuery(Array.from({ length: 40 }, (_, i) => `palavra${i}`).join(' ')).split(' | ')).toHaveLength(12);
  });
  it('o SQL usa to_tsquery parametrizado com a consulta OR e nada de texto livre interpolado', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const client: SqlClient = { query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return { rows: [] } as never; }, end: async () => undefined };
    const store = new PgKnowledgeStore(client, 8);
    await store.search("O Fred está microfonando'; DROP TABLE x;--", undefined, 4);
    const sql = calls.at(-1)!;
    expect(sql.text).toContain("to_tsquery('portuguese', $1)");
    expect(sql.text).not.toContain('plainto_tsquery');
    expect(sql.params[0]).toBe('fred | está | microfonando | drop | table');
    expect(sql.text).not.toMatch(/DROP|Fred/);
    calls.length = 0;
    expect(await store.search('a o', undefined, 4)).toEqual([]);
    expect(calls).toHaveLength(0); // sem palavras úteis nem consulta ao banco
  });
});

describe('ingestão: tabelas de códigos e versão do pipeline', () => {
  it('trecho dominado por códigos de modelo é ignorado; texto normal e trechos curtos não', async () => {
    const { mostlyCodes } = await import('../src/knowledge/local/ingest.js');
    expect(mostlyCodes('Live Vocals BETA58A SM58 BETA53 BETA54 BETA87A BETA87C KSM9 KSM9HS SM35 SM87A SM86 PG58 PGA31 PG48 PG42')).toBe(true);
    expect(mostlyCodes('O microfone SM58 é dinâmico e cardioide, robusto para voz no palco, com cabo XLR de 3 pinos e boa rejeição.')).toBe(false);
    expect(mostlyCodes('SM58 SM57 PG48')).toBe(false);
  });
  it('documento ingerido por um pipeline antigo é reindexado uma vez; depois fica "unchanged"', async () => {
    const { createHash } = await import('node:crypto');
    const { k, store, dir } = await service({});
    const text = '# Microfonia\n\nA microfonia depende do ganho e do posicionamento do microfone no palco. Reduza o retorno do vocal.';
    writeFileSync(join(dir, 'inbox', 'shure-live.md'), text);
    // Como o pipeline anterior gravava: hash só dos bytes do arquivo.
    await store.replaceDocument({ sourceId: 'shure-live', fileName: 'shure-live.md', sha256: createHash('sha256').update(text).digest('hex'), bytes: text.length, chunks: [{ ordinal: 0, locator: 'x', text }] });
    expect((await k.ingest()).items[0]).toMatchObject({ file: 'shure-live.md', status: 'ingested' });
    expect((await k.ingest()).items[0]).toMatchObject({ status: 'unchanged' });
  });
  it('a ingestão informa quando ignora tabela de códigos e não a indexa', async () => {
    const table = 'Live Vocals BETA58A SM58 BETA53 BETA54 BETA87A BETA87C KSM9 KSM9HS SM35 SM87A SM86 PG58 PGA31 PG48 PG42 SM48 BETA27';
    const { k, dir } = await service({});
    writeFileSync(join(dir, 'inbox', 'shure-live.md'), `# Tabela

${table}

# Texto

A microfonia depende do ganho e do posicionamento do microfone no palco.`);
    const report = await k.ingest();
    expect(report.items[0]).toMatchObject({ status: 'ingested', chunks: 1 });
    expect(report.items[0]!.reason).toMatch(/1 trecho\(s\) de tabela de códigos ignorado\(s\)/);
    const found = await k.search('BETA58A SM58 PG48 KSM9');
    expect(found.passages.some((p) => /BETA58A/.test(p.excerpt))).toBe(false);
  });
});

describe('embeddings na ingestão: timeout, nova tentativa e reparo de lacunas', () => {
  /** Ollama cujo /api/embed falha nas chamadas indicadas (500) e responde nas demais. */
  function flaky(failOn: (call: number) => boolean) {
    let calls = 0;
    const fetchFn = async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }] }));
      if (url.endsWith('/api/embed')) {
        calls++;
        if (failOn(calls)) return new Response('x', { status: 500 });
        const body = JSON.parse(String(init!.body)) as { input: string[] };
        return new Response(JSON.stringify({ embeddings: body.input.map(() => new Array(DIMS).fill(0.5)) }));
      }
      return new Response('{}', { status: 404 });
    };
    return { client: new OllamaClient(OLLAMA, fetchFn as unknown as typeof fetch), calls: () => calls };
  }
  const LONG = Array.from({ length: 260 }, (_, i) => `Frase ${i + 1} sobre microfonia, ganho e posicionamento do microfone no palco do evento.`).join('\n');

  it('lote de documento usa tempo maior que o da consulta', async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return real(ms); });
    const { client } = flaky(() => false);
    await client.embed(['pergunta'], 'query');
    await client.embed(['trecho'], 'document');
    expect(timeouts.slice(-2)).toEqual([2000, 60_000]);
  });
  it('falha passageira de um lote é repetida uma vez: o documento fica 100% com embedding', async () => {
    const { client } = flaky((n) => n === 1);
    const { k } = await service({ ollama: client, docs: { 'shure-live.md': LONG } });
    const doc = (await k.documents())[0]!;
    expect(doc.chunks).toBeGreaterThan(1);
    expect(doc.embedded).toBe(doc.chunks);
  });
  it('documento só parcialmente embedado é reingerido (não fica "unchanged") quando o serviço volta', async () => {
    const down = flaky((n) => n >= 2); // 1º lote passa; 2º e a repetição falham
    const a = await service({ ollama: down.client, docs: { 'shure-live.md': LONG } });
    const partial = (await a.k.documents())[0]!;
    expect(partial.embedded).toBeGreaterThan(0);
    expect(partial.embedded).toBeLessThan(partial.chunks);

    const up = flaky(() => false);
    const b = new LocalKnowledge({ store: a.store, ollama: up.client, inboxDir: join(a.dir, 'inbox'), seedDir: SEED, maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: false });
    const item = (await b.ingest()).items[0]!;
    expect(item.status).toBe('ingested');
    const full = (await b.documents())[0]!;
    expect(full.embedded).toBe(full.chunks);
    expect((await b.ingest()).items[0]!.status).toBe('unchanged'); // agora sim
  });
});
