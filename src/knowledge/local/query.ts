import { normalize } from './text.js';
import type { Passage } from './store.js';

/**
 * Preparo da consulta documental e refinamento dos resultados. Funções puras, sem rede, sem mesa e sem estado:
 * só mudam COMO a pergunta chega à busca e COMO os trechos devolvidos são ordenados/filtrados. O corpus e os embeddings não são tocados.
 *
 * Problemas medidos que isto resolve (relatório de validação, item M3):
 *  - o nome de um músico ("Fred") puxava a busca para trechos sem relação (a ficha de ganho da Yamaha ficava em 1º lugar);
 *  - "coro" (grupo vocal) casava com "Chorus FX" (efeito) do manual da Ui12/16;
 *  - "microfonia" genérica trazia tabelas de posicionamento da Shure acima do artigo de microfonia;
 *  - o limiar de similaridade fixo deixava passar trechos de ruído (score ≈ 0,40 contra ≈ 0,55 dos relevantes).
 */
export interface RetrievalTuning {
  /** Remove nomes de músicos da consulta (a identidade da pessoa não ajuda a achar o assunto). */
  stripNames: boolean;
  /** Resolve homógrafos conhecidos ("coro" de vozes × efeito Chorus) e retira o sentido errado dos resultados. */
  disambiguate: boolean;
  /** Acrescenta termos em português do sintoma e do instrumento (vocabulário fechado do motor) à consulta. */
  expandSymptoms: boolean;
  /** 0 = desligado. Em (0, 1): descarta trechos vetoriais com score < (melhor score × este valor); independe da escala do modelo. */
  relativeCutoff: number;
  /** 0 = desligado. Soma ao score de ORDENAÇÃO (não ao exibido) dos trechos vetoriais das sínteses técnicas em português. */
  sourcePrior: number;
}
export const NEUTRAL_TUNING: RetrievalTuning = { stripNames: false, disambiguate: false, expandSymptoms: false, relativeCutoff: 0, sourcePrior: 0 };
export const TECHNICAL_SOURCE = 'mixai-technical-v1';

export interface PreparedQuery { text: string; avoid: RegExp[]; notes: string[] }

/** Palavras que apresentam o nome e ficariam soltas sem ele: "do Fred", "quando o Fred canta", "com a Laviquinho". */
const PREPOSITIONS = new Set(['do', 'da', 'de', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'pelo', 'pela', 'ao', 'para', 'com', 'o', 'a', 'os', 'as']);
const bare = (w: string) => normalize(w).replace(/[^a-z0-9]/g, '');

/** Tira os nomes (e a preposição que os apresentava: "do Fred") da consulta. Não mexe no restante do texto. */
export function stripNames(text: string, names: readonly string[]): string {
  const bad = new Set(names.flatMap((n) => normalize(n).split(/\s+/)).map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length >= 3));
  if (!bad.size) return text;
  const out: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (bad.has(bare(word))) { while (out.length && PREPOSITIONS.has(bare(out[out.length - 1]!))) out.pop(); continue; }
    out.push(word);
  }
  return out.join(' ');
}

/** Termos em português para o vocabulário FECHADO de sintomas e instrumentos do motor determinístico. */
export const SYMPTOM_GLOSSARY: Readonly<Record<string, string>> = {
  abafado: 'voz abafada clareza inteligibilidade efeito de proximidade',
  embolado: 'embolado falta de definição mascaramento graves',
  estridente: 'estridente excesso de agudos brilho',
  magro: 'falta de grave corpo peso graves',
  desequilibrio: 'mascaramento equilíbrio nível mix vozes de apoio',
  microfonia: 'microfonia realimentação feedback apito ganho antes da microfonia',
  sibilancia: 'sibilância consoantes de-esser',
  clip: 'distorção clipping ganho de entrada headroom',
  ruido: 'ruído chiado zumbido cabo ganho de entrada',
  monitoracao: 'retorno monitoração AUX1 mix compartilhada',
  ganho: 'ganho de entrada headroom clipping',
  processamento: 'EQ filtro passa-alto HPF compressor gate',
};
export const INSTRUMENT_GLOSSARY: Readonly<Record<string, string>> = {
  surdo: 'surdo bumbo grave', vozes: 'voz vocal', tanta: 'tantã', pandeiro: 'pandeiro platinelas', cavaco: 'cavaco', violao: 'violão',
};

const EFFECT_WORDS = /\b(efeito|efeitos|fx|chorus|flanger|phaser|delay|reverb|reverberacao|eco|plugin)\b/;
/**
 * Homógrafos conhecidos. "coro" é o grupo de vozes; "Chorus" é um efeito da mesa. Sem pista de efeito na pergunta, "coro" é voz:
 * a consulta ganha termos do sentido certo e os trechos do sentido errado saem do resultado.
 */
export function disambiguate(normalizedQuery: string): { add: string; avoid: RegExp[]; note: string } | undefined {
  if (/\b(coro|coral)\b/.test(normalizedQuery) && !EFFECT_WORDS.test(normalizedQuery)) {
    return { add: 'vozes de apoio backing vocals mascaramento', avoid: [/\bchorus\b/i, /\bfx edit\b/i], note: 'coro=vozes' };
  }
  return undefined;
}

export interface PrepareInput { symptom?: string; instrument?: string; names?: readonly string[] }

/** Monta a consulta que vai ao vetor e às palavras. Com tudo desligado devolve o formato antigo: "sintoma instrumento texto". */
export function prepareQuery(text: string, input: PrepareInput, tuning: RetrievalTuning, max = 300): PreparedQuery {
  const notes: string[] = [];
  let body = text.trim();
  if (tuning.stripNames && input.names?.length) {
    const stripped = stripNames(body, input.names);
    if (stripped !== body) { notes.push('nomes removidos'); body = stripped; }
  }
  const avoid: RegExp[] = [];
  const parts: string[] = [];
  if (tuning.expandSymptoms && (input.symptom || input.instrument)) {
    parts.push(body, SYMPTOM_GLOSSARY[input.symptom ?? ''] ?? input.symptom ?? '', INSTRUMENT_GLOSSARY[input.instrument ?? ''] ?? input.instrument ?? '');
    notes.push('termos do sintoma');
  } else parts.push(input.symptom ?? '', input.instrument ?? '', body);
  if (tuning.disambiguate) {
    const d = disambiguate(normalize(`${body}`));
    if (d) { parts.push(d.add); avoid.push(...d.avoid); notes.push(d.note); }
  }
  return { text: parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, max), avoid, notes };
}

/** Pós-processamento dos trechos devolvidos pela base: sentido errado fora, ruído fora, sínteses técnicas na frente (se pedido). */
export function refinePassages<T extends Pick<Passage, 'sourceId' | 'score' | 'method' | 'excerpt'>>(found: readonly T[], opts: { avoid: readonly RegExp[]; tuning: RetrievalTuning; limit: number }): T[] {
  let list = found.filter((p) => !opts.avoid.some((re) => re.test(p.excerpt)));
  if (opts.tuning.relativeCutoff > 0) {
    const top = Math.max(0, ...list.filter((p) => p.method === 'vector').map((p) => p.score));
    if (top > 0) list = list.filter((p) => p.method !== 'vector' || p.score >= top * opts.tuning.relativeCutoff);
  }
  if (opts.tuning.sourcePrior > 0) {
    const rank = (p: T) => p.score + (p.method === 'vector' && p.sourceId === TECHNICAL_SOURCE ? opts.tuning.sourcePrior : 0);
    list = list.map((p, i) => ({ p, i })).sort((a, b) => rank(b.p) - rank(a.p) || a.i - b.i).map((x) => x.p);
  }
  return list.slice(0, opts.limit);
}
