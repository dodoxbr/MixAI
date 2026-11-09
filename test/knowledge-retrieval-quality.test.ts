import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../src/core/config.js';
import type { AiProvider } from '../src/knowledge/local/provider.js';
import type { RetrievalTuning } from '../src/knowledge/local/query.js';
import { LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';
import { normalize } from '../src/knowledge/local/text.js';

/**
 * M3 — regressão da recuperação documental. Um embedder DETERMINÍSTICO (saco de palavras com hash) faz o trabalho do modelo,
 * de modo que o teste prova o mecanismo: sem o ajuste o problema aparece (pré-condição), com ele some.
 * Corpus: um trecho "Chorus FX" (falso cognato de "coro"), um artigo de mascaramento por vozes de apoio, um artigo de
 * microfonia e uma tabela de posicionamento da Shure (o ruído medido na validação).
 */
const DIMS = 128;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const STOP = new Set(['a', 'o', 'as', 'os', 'de', 'do', 'da', 'no', 'na', 'em', 'e', 'que', 'com', 'esta', 'est', 'um', 'uma', 'para']);
function hashVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of normalize(text).split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !STOP.has(x))) {
    let h = 7; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
    v[h % DIMS]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
function embedder() {
  const queries: string[] = [];
  const p: AiProvider = {
    id: 'ollama', external: false,
    health: async () => ({ reachable: true, embedModel: true, chatModel: true, detail: 'ok' }),
    embed: async (texts, kind) => { if (kind === 'query') queries.push(...texts); return texts.map(hashVector); },
    generateDetailed: async () => ({ failure: 'unavailable' }),
  };
  return { p, queries };
}

const DOCS: Array<{ sourceId: string; file: string; text: string }> = [
  { sourceId: 'soundcraft-pt-pdf', file: 'chorus.md', text: '7.3: Chorus FX EDIT > CHORUS. Chorus cria um som completo combinando dois ou mais sinais: efeito coro com a voz principal e o coro de vozes.' },
  { sourceId: 'mixai-technical-v1', file: 'voice-balance.md', text: 'Voz principal sumindo quando o coro canta: mascaramento pelas vozes de apoio. Compare a voz sozinha e com o coro antes de subir o master.' },
  { sourceId: 'mixai-technical-v1', file: 'feedback.md', text: 'Microfonia e apito no PA: realimentação (feedback) depende do ganho, das caixas e do posicionamento do microfone. Interrompa a escuta se apitar.' },
  { sourceId: 'shure-live', file: 'placement.md', text: 'LIVE SOUND Microphone Techniques for Microphone Placement Tonal Balance Comments French horn: microphone aiming toward the bell microfone microfone microfone do Fred.' },
];

async function build(tuning: Partial<RetrievalTuning>) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-m3-')); dirs.push(dir);
  const store = new FileKnowledgeStore(join(dir, 'k.json')); await store.init();
  const e = embedder();
  const k = new LocalKnowledge({ store, ollama: e.p, chatProviders: [e.p], inboxDir: join(dir, 'inbox'), seedDir: join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2'), maxDocumentBytes: 1024 * 1024, maxPassages: 4, narrative: false, minScore: 0.05, retrieval: tuning });
  await k.importSeed(); // traz o cadastro dos músicos (Fred, Lucius…) e o catálogo de fontes
  for (const d of DOCS) await store.replaceDocument({ sourceId: d.sourceId, fileName: d.file, sha256: d.file, bytes: d.text.length, chunks: [{ ordinal: 0, locator: 'p1', text: d.text, embedding: hashVector(d.text) }] });
  return { k, queries: e.queries };
}
const OFF: Partial<RetrievalTuning> = { stripNames: false, disambiguate: false, expandSymptoms: false, relativeCutoff: 0, sourcePrior: 0 };
const has = (list: Array<{ excerpt: string }>, re: RegExp) => list.some((p) => re.test(p.excerpt));

describe('coro (vozes) × Chorus FX (efeito)', () => {
  const Q = 'Coro cobrindo a voz do Fred';
  it('PRÉ-CONDIÇÃO: sem o ajuste, o trecho do efeito Chorus aparece para uma pergunta sobre o coro de vozes', async () => {
    const { k } = await build(OFF);
    const r = await k.enrich({ text: Q, symptom: 'desequilibrio', instrument: 'vozes' });
    expect(has(r.passages, /Chorus FX/)).toBe(true);
  });
  it('com a desambiguação, o efeito não aparece e o artigo de mascaramento sobe', async () => {
    const { k } = await build({ ...OFF, disambiguate: true });
    const r = await k.enrich({ text: Q, symptom: 'desequilibrio', instrument: 'vozes' });
    expect(has(r.passages, /Chorus FX/)).toBe(false);
    expect(r.passages.length).toBeGreaterThan(0);
    expect(r.passages[0]!.excerpt).toMatch(/mascaramento/);
  });
  it('quem pergunta pelo EFEITO continua achando o efeito (a desambiguação não bloqueia o que é legítimo)', async () => {
    const { k } = await build({ ...OFF, disambiguate: true });
    for (const q of ['Como usar o efeito chorus na mesa', 'Para que serve o chorus FX']) expect(has((await k.search(q)).passages, /Chorus FX/), q).toBe(true);
  });
  it('vale também para a busca livre (painel e CLI), sem sintoma', async () => {
    const { k } = await build({ ...OFF, disambiguate: true });
    expect(has((await k.search('coro cobrindo a voz principal')).passages, /Chorus FX/)).toBe(false);
  });
});

describe('o que chega ao vetor', () => {
  it('relato + termos do sintoma e do instrumento; sem os identificadores crus; nome do músico fica (padrão)', async () => {
    const { k, queries } = await build({});
    await k.enrich({ text: 'Está dando microfonia no microfone do Fred', symptom: 'microfonia', instrument: 'vozes' });
    const q = queries.at(-1)!;
    expect(q.startsWith('Está dando microfonia no microfone do Fred')).toBe(true);
    expect(q).toContain('realimentação feedback');
    expect(q.startsWith('microfonia vozes')).toBe(false);
  });
  it('com stripNames o nome do músico (cadastrado) não chega ao vetor; sem ele chega', async () => {
    const on = await build({ stripNames: true });
    await on.k.enrich({ text: 'Tá microfonando quando o Fred canta', symptom: 'microfonia', instrument: 'vozes' });
    expect(on.queries.at(-1)).not.toMatch(/Fred/);
    expect(on.queries.at(-1)).toContain('microfonando quando canta');
    const off = await build({ stripNames: false });
    await off.k.enrich({ text: 'Tá microfonando quando o Fred canta', symptom: 'microfonia', instrument: 'vozes' });
    expect(off.queries.at(-1)).toMatch(/Fred/);
  });
  it('desligado, o formato é o antigo ("sintoma instrumento texto") e a busca livre não ganha termos', async () => {
    const { k, queries } = await build(OFF);
    await k.enrich({ text: 'A voz está abafada no retorno', symptom: 'abafado', instrument: 'vozes' });
    expect(queries.at(-1)).toBe('abafado vozes A voz está abafada no retorno');
    await k.search('Está dando microfonia');
    expect(queries.at(-1)).toBe('Está dando microfonia');
  });
});

describe('microfonia: o artigo certo vence a tabela de posicionamento', () => {
  it('PRÉ-CONDIÇÃO: sem o glossário a tabela de posicionamento (ruído) vem antes do artigo', async () => {
    const { k } = await build(OFF);
    const r = await k.enrich({ text: 'Está dando microfonia no microfone do Fred', symptom: 'microfonia', instrument: 'vozes' });
    const at = (re: RegExp) => r.passages.findIndex((p) => re.test(p.excerpt));
    expect(at(/French horn/)).toBeGreaterThanOrEqual(0);
    expect(at(/French horn/)).toBeLessThan(at(/realimenta/) < 0 ? 99 : at(/realimenta/));
  });
  it('com o glossário o artigo de microfonia é o 1º resultado', async () => {
    const { k } = await build({ ...OFF, expandSymptoms: true });
    const r = await k.enrich({ text: 'Está dando microfonia no microfone do Fred', symptom: 'microfonia', instrument: 'vozes' });
    expect(r.passages[0]!.excerpt).toMatch(/realimenta/);
  });
});

describe('segurança e isolamento', () => {
  it('só muda a consulta e a seleção: a base, os vetores e o cadastro não são tocados', async () => {
    const { k } = await build({ stripNames: true, disambiguate: true, expandSymptoms: true, relativeCutoff: 0.9, sourcePrior: 0.1 });
    const before = (await k.status()).chunks;
    await k.enrich({ text: 'Coro cobrindo a voz do Fred', symptom: 'desequilibrio', instrument: 'vozes' });
    await k.search('Está dando microfonia');
    expect((await k.status()).chunks).toBe(before);
    expect((await k.microphones()).assignments['CH3']?.musician).toBe('Fred'); // o nome continua no cadastro; só sai da CONSULTA
  });
});
