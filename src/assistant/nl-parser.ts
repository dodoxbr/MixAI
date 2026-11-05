import { words, type ChannelMap } from '../core/channels.js';
import type { Role } from '../server/auth.js';
import type { ClarifyOption, Destination, Intent, ParseOutcome } from './intent.js';

export interface StepSizes {
  smallStepDB: number;
  mediumStepDB: number;
  largeStepDB: number;
}

export interface ParseContext {
  names: ChannelMap;
  role: Role;
  steps: StepSizes;
}

/**
 * Parser LOCAL de pedidos em português (sem internet, sem IA, sem tokens).
 * Regras:
 * - só reconhece canais pelos nomes e apelidos do channels.yaml (nunca inventa);
 * - não presume PA nem FONES: sem destino claro, pergunta (para o músico, o único destino
 *   possível é FONES, e o cartão mostra isso);
 * - nome que serve para mais de um canal ("voz") → pergunta qual;
 * - o que não entender devolve `unknown` (aí pode ir para o Claude, se estiver ligado).
 */

const UP = ['aumenta', 'aumentar', 'aumente', 'sobe', 'subir', 'suba', 'levanta', 'levantar', 'eleva', 'coloca mais', 'poe mais', 'mais alto'];
const DOWN = ['diminui', 'diminuir', 'diminua', 'abaixa', 'abaixar', 'abaixe', 'baixa', 'baixar', 'desce', 'descer', 'desca', 'reduz', 'reduzir', 'reduza', 'mais baixo', 'tira um pouco', 'tira'];
const MUTE = ['muta', 'mutar', 'mute', 'silencia', 'silenciar', 'cala', 'calar', 'corta', 'cortar', 'fecha', 'fechar'];
const UNMUTE = ['desmuta', 'desmutar', 'desmute', 'abre', 'abrir', 'libera', 'liberar', 'tira o mute', 'tirar o mute', 'volta o som', 'solta'];
const SET = ['coloca', 'colocar', 'deixa', 'deixar', 'poe', 'ajusta', 'ajustar', 'define', 'bota', 'botar'];
const UNDO = ['desfaz', 'desfazer', 'desfaca', 'volta o ultimo', 'volta como estava', 'voltar como estava', 'cancela o ultimo', 'volta o ajuste'];

const SMALL = ['um pouco', 'um pouquinho', 'pouquinho', 'um tico', 'um tiquinho', 'levemente', 'de leve', 'devagar'];
const LARGE = ['bastante', 'muito', 'um monte', 'bem mais', 'bem menos'];
const MEDIUM = ['mais', 'menos'];

const PA = ['pa', 'no pa', 'publico', 'som do publico', 'caixa', 'caixas', 'som da casa', 'principal', 'main', 'plateia'];
const MASTER = ['master', 'volume geral', 'som geral', 'geral'];
const VOICE = ['voz', 'vozes', 'vocal', 'vocais', 'cantor', 'cantores'];

const has = (text: string, phrase: string) => new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);
const hasAny = (text: string, list: string[]) => list.some((p) => has(text, p));

export function parseRequest(raw: string, ctx: ParseContext): ParseOutcome {
  const w = words(raw);
  const text = w.join(' ');
  if (!text) return { kind: 'unknown' };

  // ---------- desfazer ----------
  if (hasAny(text, UNDO)) return { kind: 'intents', intents: [{ type: 'undo' }] };

  // ---------- ação ----------
  const unmute = hasAny(text, UNMUTE);
  const mute = !unmute && hasAny(text, MUTE);
  const set = hasAny(text, SET);
  let dir: 1 | -1 | 0 = hasAny(text, DOWN) ? -1 : hasAny(text, UP) ? 1 : 0;
  // "mais surdo no fone" / "menos violão"
  if (!dir && !mute && !unmute) {
    if (w[0] === 'mais') dir = 1;
    else if (w[0] === 'menos') dir = -1;
  }

  // ---------- canais (antes da quantidade: "7 cordas" é nome, não 7 dB) ----------
  const { channels: found, rest } = findChannelsIn(text, ctx.names);

  // ---------- quantidade ----------
  // "para -5 dB", "em -10" = valor absoluto; "3 dB" = quanto mudar (o sinal vem do verbo).
  const absolute = / (?:em|para|pra) ([+-]?\d+(?:[.,]\d+)?) ?(?:db)? /.exec(rest);
  const relative = / ([+-]?\d+(?:[.,]\d+)?) ?(?:db|decibeis|decibel) /.exec(rest) ?? (dir ? / ([+-]?\d+(?:[.,]\d+)?) /.exec(rest) : null);
  let amount: number | undefined;
  let db: number | undefined;
  if (absolute) db = Number(absolute[1]!.replace(',', '.'));
  else if (relative) amount = Math.abs(Number(relative[1]!.replace(',', '.')));
  if (db !== undefined && !set && !dir && !absolute) db = undefined;
  if (amount === undefined && db === undefined && dir) {
    amount = hasAny(text, LARGE)
      ? ctx.steps.largeStepDB
      : hasAny(text, SMALL)
        ? ctx.steps.smallStepDB
        : MEDIUM.some((m) => w.slice(1).includes(m))
          ? ctx.steps.mediumStepDB
          : ctx.steps.smallStepDB;
  }
  if (amount !== undefined && !dir) amount = undefined; // número sem verbo de subir/descer: não adivinha
  const hasAction = mute || unmute || dir !== 0 || db !== undefined;

  // ---------- master ----------
  if (hasAny(text, MASTER)) {
    if (mute || unmute) return { kind: 'answer', text: 'O master não é mutado pelo assistente. Use a mesa ou peça para abaixar o volume geral.' };
    if (!hasAction) return { kind: 'unknown' };
    return { kind: 'intents', intents: [db !== undefined ? { type: 'master', db } : { type: 'master', deltaDB: dir * amount! }] };
  }

  // ---------- canais: nenhum ou ambíguo ----------
  const voiceWord = hasAny(text, VOICE);
  const voices = ctx.names.inputs.list().filter((c) => /voz|vocal/i.test(c.name));
  if (!found.length) {
    if (!hasAction) return { kind: 'unknown' };
    if (voiceWord && voices.length > 1) {
      return clarify('Qual voz?', voices.map((v) => ({ label: v.name, text: `${clean(raw)} — ${v.name}` })));
    }
    if (voiceWord && voices.length === 1) found.push(voices[0]!.number);
    else {
      return clarify(
        'Não reconheci o canal pelos nomes da banda. Qual destes?',
        ctx.names.inputs.list().map((c) => ({ label: c.name, text: `${clean(raw)} — ${c.name}` })),
      );
    }
  }
  if (!hasAction) return { kind: 'unknown' };

  // ---------- destino ----------
  const fonesWords = ctx.names.aux.terms().map((t) => t.phrase).concat(['fone', 'fones', 'retorno', 'retornos', 'monitor', 'aux']);
  // Procura o destino no texto SEM os nomes de canal (um apelido de retorno pode coincidir com um canal).
  const restText = rest.trim();
  const saysFones = hasAny(restText, fonesWords);
  const saysPa = hasAny(restText, PA);
  let dest: Destination | undefined;
  if (saysFones && saysPa) {
    return clarify('No PA ou nos fones? Escolha um de cada vez.', destinationOptions(raw));
  } else if (saysFones) dest = 'fones';
  else if (saysPa) dest = 'pa';
  else if (ctx.role === 'musician') dest = 'fones'; // o único destino possível para o músico
  else return clarify('No PA (som do público) ou nos FONES (retorno de todos)?', destinationOptions(raw));

  // ---------- intenções ----------
  if (mute || unmute) return { kind: 'intents', intents: [{ type: 'mute', channels: found, dest, muted: mute }] };
  const intents: Intent[] = found.map((channel) =>
    db !== undefined ? { type: 'level', channel, dest: dest!, db } : { type: 'level', channel, dest: dest!, deltaDB: dir * amount! },
  );
  return { kind: 'intents', intents };
}

const clean = (raw: string) => raw.replace(/[.!?]+\s*$/, '').trim();

function clarify(question: string, options: ClarifyOption[]): ParseOutcome {
  return { kind: 'clarify', question, options };
}

function destinationOptions(raw: string): ClarifyOption[] {
  const base = raw
    .replace(/[.!?]+\s*$/, '')
    .replace(/\s*(e\s+)?\b(no|nos|na|nas)\s+(pa|fones?|retornos?)\b/gi, '')
    .trim();
  return [
    { label: 'PA', text: `${base} no PA` },
    { label: 'Fones', text: `${base} nos fones` },
  ];
}

/**
 * Canais citados na frase, pelos nomes e apelidos cadastrados (o mais longo primeiro, para
 * "voz do fernando" não virar duas coisas). Também aceita "canal 7".
 */
export function findChannels(text: string, names: ChannelMap): number[] {
  return findChannelsIn(words(text).join(' '), names).channels;
}

function findChannelsIn(text: string, names: ChannelMap): { channels: number[]; rest: string } {
  const terms = names.inputs.terms().sort((a, b) => b.phrase.length - a.phrase.length);
  let rest = ` ${text} `;
  const out: number[] = [];
  for (const t of terms) {
    const needle = ` ${t.phrase} `;
    if (rest.includes(needle)) {
      rest = rest.split(needle).join(' ');
      if (!out.includes(t.number)) out.push(t.number);
    }
  }
  for (const m of rest.matchAll(/ (?:canal|ch) (\d+) /g)) {
    const n = Number(m[1]);
    if (names.inputs.configured().includes(n) && !out.includes(n)) out.push(n);
  }
  rest = rest.replace(/ (?:canal|ch|aux) \d+ /g, ' ');
  return { channels: out, rest: ` ${rest.trim()} ` };
}
