import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { evalLiveCases, loadRelevance, type RelevanceCase } from '../src/knowledge/local/eval.js';
import { disambiguate, INSTRUMENT_GLOSSARY, NEUTRAL_TUNING, prepareQuery, refinePassages, stripNames, SYMPTOM_GLOSSARY, TECHNICAL_SOURCE, type RetrievalTuning } from '../src/knowledge/local/query.js';
import { symptomSchema } from '../src/knowledge/sound-engineer/index.js';

/** M3 — preparo da consulta e refinamento dos resultados: funções puras, sem rede e sem base. */
const NAMES = ['Fred', 'Lucius', 'Leandro', 'Fernando', 'Laviquinho'];
const ON: RetrievalTuning = { stripNames: true, disambiguate: true, expandSymptoms: true, relativeCutoff: 0, sourcePrior: 0 };
const P = (sourceId: string, score: number, excerpt: string, method: 'vector' | 'keyword' = 'vector') => ({ sourceId, score, excerpt, method });

describe('nomes de músicos', () => {
  it.each([
    ['Está dando microfonia no microfone do Fred', 'Está dando microfonia no microfone'],
    ['Tá microfonando quando o Fred canta', 'Tá microfonando quando canta'],
    ['A voz do Fernando está abafada', 'A voz está abafada'],
    ['Coro cobrindo a voz do Fred', 'Coro cobrindo a voz'],
    ['O Fred não aparece quando o coro entra', 'não aparece quando o coro entra'],
    ['Microfonia no retorno do Lucius.', 'Microfonia no retorno'],
  ])('"%s" → "%s" (some o nome e a palavra que o apresentava)', (input, expected) => {
    expect(stripNames(input, NAMES)).toBe(expected);
  });
  it('não mexe em texto sem nome, ignora acento e caixa e não corta palavras comuns', () => {
    expect(stripNames('O surdo está sem grave', NAMES)).toBe('O surdo está sem grave');
    expect(stripNames('a voz do FRED está abafada', NAMES)).toBe('a voz está abafada');
    expect(stripNames('fernandinho tocou', NAMES)).toBe('fernandinho tocou'); // só a palavra inteira
    expect(stripNames('texto qualquer', [])).toBe('texto qualquer');
    expect(stripNames('de Fred', ['de'])).toBe('de Fred'); // palavra curta (<3) nunca vira "nome"
  });
});

describe('homógrafo "coro" × efeito Chorus', () => {
  it('"coro" sem pista de efeito é grupo de vozes: ganha termos do sentido certo e exclui o Chorus FX', () => {
    const d = disambiguate('coro cobrindo a voz do fred')!;
    expect(d.add).toContain('vozes de apoio');
    expect(d.avoid.some((re) => re.test('7.3: Chorus FX EDIT > CHORUS Chorus cria um som completo'))).toBe(true);
    expect(d.avoid.some((re) => re.test('Mascaramento pelas vozes de apoio quando o coro canta'))).toBe(false);
  });
  it.each(['como usar o efeito chorus na mesa', 'coro fx da ui16', 'para que serve o chorus', 'delay e coro no retorno'])('"%s" pergunta pelo efeito: nada é excluído', (q) => {
    expect(disambiguate(q)).toBeUndefined();
  });
  it('sem "coro" nada muda', () => { expect(disambiguate('a voz esta abafada')).toBeUndefined(); });
});

describe('prepareQuery', () => {
  it('com tudo desligado devolve EXATAMENTE o formato antigo (sintoma instrumento texto)', () => {
    const q = prepareQuery('A voz está abafada no retorno', { symptom: 'abafado', instrument: 'vozes', names: NAMES }, NEUTRAL_TUNING);
    expect(q.text).toBe('abafado vozes A voz está abafada no retorno');
    expect(q.avoid).toEqual([]);
  });
  it('com o glossário: relato primeiro, depois termos em português do sintoma e do instrumento (sem os identificadores crus)', () => {
    const q = prepareQuery('Está dando microfonia', { symptom: 'microfonia', instrument: 'vozes' }, { ...NEUTRAL_TUNING, expandSymptoms: true });
    expect(q.text.startsWith('Está dando microfonia')).toBe(true);
    expect(q.text).toContain('realimentação feedback');
    expect(q.text).toContain('voz vocal');
    expect(q.text.startsWith('microfonia vozes')).toBe(false);
  });
  it('sem sintoma nem instrumento (busca livre) o glossário não entra', () => {
    expect(prepareQuery('Está dando microfonia', {}, { ...NEUTRAL_TUNING, expandSymptoms: true }).text).toBe('Está dando microfonia');
  });
  it('nomes saem só quando o ajuste está ligado; "coro" acrescenta o sentido de vozes e registra o que evitar', () => {
    const on = prepareQuery('Coro cobrindo a voz do Fred', { symptom: 'desequilibrio', instrument: 'vozes', names: NAMES }, ON);
    expect(on.text).not.toMatch(/Fred/);
    expect(on.text).toContain('vozes de apoio');
    expect(on.avoid.length).toBeGreaterThan(0);
    expect(on.notes).toEqual(expect.arrayContaining(['nomes removidos', 'coro=vozes']));
    const off = prepareQuery('Coro cobrindo a voz do Fred', { symptom: 'desequilibrio', instrument: 'vozes', names: NAMES }, { ...ON, stripNames: false });
    expect(off.text).toContain('Fred');
  });
  it('respeita o tamanho máximo e todos os sintomas do motor têm termos em português', () => {
    expect(prepareQuery('x'.repeat(500), { symptom: 'abafado' }, ON).text.length).toBeLessThanOrEqual(300);
    for (const s of symptomSchema.options) expect(SYMPTOM_GLOSSARY[s], s).toBeTruthy();
    expect(Object.keys(INSTRUMENT_GLOSSARY).sort()).toEqual(['cavaco', 'pandeiro', 'surdo', 'tanta', 'violao', 'vozes']);
  });
});

describe('refinePassages', () => {
  const found = [P('soundcraft-pt-pdf', 0.62, '7.3: Chorus FX EDIT > CHORUS'), P(TECHNICAL_SOURCE, 0.55, 'Mascaramento pelo coro'), P('shure-live', 0.54, 'Tabela de posicionamento'), P(TECHNICAL_SOURCE, 0.41, 'Rodapé de fontes')];
  it('exclui o sentido errado e repõe com os candidatos seguintes', () => {
    const out = refinePassages(found, { avoid: [/\bchorus\b/i], tuning: NEUTRAL_TUNING, limit: 3 });
    expect(out.map((p) => p.excerpt)).not.toContain('7.3: Chorus FX EDIT > CHORUS');
    expect(out).toHaveLength(3);
  });
  it('corte relativo só olha trechos vetoriais e ignora palavras', () => {
    const mixed = [...found, P('x', 0.04, 'por palavras', 'keyword')];
    const out = refinePassages(mixed, { avoid: [], tuning: { ...NEUTRAL_TUNING, relativeCutoff: 0.85 }, limit: 10 });
    expect(out.map((p) => p.score)).toEqual([0.62, 0.55, 0.54, 0.04]); // 0,41 < 0,62 × 0,85 sai; o de palavras fica
  });
  it('prior só reordena trechos vetoriais das sínteses e não altera o score exibido', () => {
    const out = refinePassages(found, { avoid: [], tuning: { ...NEUTRAL_TUNING, sourcePrior: 0.1 }, limit: 4 });
    expect(out[0]!.sourceId).toBe(TECHNICAL_SOURCE);
    expect(out[0]!.score).toBe(0.55);
  });
  it('desligado: não filtra, não reordena, só corta no limite', () => {
    expect(refinePassages(found, { avoid: [], tuning: NEUTRAL_TUNING, limit: 2 })).toEqual(found.slice(0, 2));
  });
});

describe('configuração e avaliação', () => {
  it('padrões baseados em medição; valores inválidos e chaves desconhecidas são recusados', () => {
    expect(parseConfig({}).knowledge.retrieval).toEqual({ stripNames: false, disambiguate: true, expandSymptoms: true, relativeCutoff: 0, sourcePrior: 0 });
    expect(parseConfig({ knowledge: { retrieval: { relativeCutoff: 0.85 } } }).knowledge.retrieval.relativeCutoff).toBe(0.85);
    expect(() => parseConfig({ knowledge: { retrieval: { relativeCutoff: 1 } } })).toThrow();
    expect(() => parseConfig({ knowledge: { retrieval: { sourcePrior: 0.9 } } })).toThrow();
    expect(() => parseConfig({ knowledge: { retrieval: { qualquer: true } } })).toThrow();
  });
  it('o conjunto v2 carrega (25 casos, com sintoma, instrumento e intrusos) e o v1 segue com 24', () => {
    const v2 = loadRelevance(join(PROJECT_ROOT, 'knowledge', 'eval', 'relevance-ptbr-v2.json'));
    expect(v2).toHaveLength(25);
    expect(v2.filter((c) => c.avoid?.length)).toHaveLength(23);
    expect(v2.every((c) => c.topic && c.anyOf.length)).toBe(true);
    expect(loadRelevance(join(PROJECT_ROOT, 'knowledge', 'eval', 'relevance-ptbr.json'))).toHaveLength(24);
    expect(readFileSync(join(PROJECT_ROOT, 'knowledge', 'eval', 'relevance-ptbr.json'), 'utf8')).toContain('"schemaVersion": 1');
  });
  it('evalLiveCases mede acerto, precisão, intrusos, trechos por pergunta e perguntas sem resposta', async () => {
    const cases: RelevanceCase[] = [
      { id: 'a', topic: 't', query: 'q1', anyOf: ['microfonia'], avoid: ['french horn'] },
      { id: 'b', topic: 't', query: 'q2', anyOf: ['surdo'], avoid: ['chorus'] },
      { id: 'c', topic: 't', query: 'q3', anyOf: ['voz'] },
    ];
    const answers: Record<string, Array<{ sourceId: string; excerpt: string }>> = {
      q1: [{ sourceId: 's', excerpt: 'French horn: microphone aiming' }, { sourceId: 's', excerpt: 'Microfonia e apito' }],
      q2: [{ sourceId: 's', excerpt: 'Surdo sem grave' }],
      q3: [],
    };
    const r = await evalLiveCases(async (c) => answers[c.query]!, cases, 4);
    expect(r).toMatchObject({ hitK: 0.667, hit1: 0.333, intrusion: 0.333, avgResults: 1, emptyRate: 0.333 });
    expect(r.misses).toEqual(['c']);
    expect(r.precisionK).toBeCloseTo((0.5 + 1 + 0) / 3, 2);
  });
});
