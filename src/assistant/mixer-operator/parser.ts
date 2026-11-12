import { words, type ChannelMap } from '../../core/channels.js';
import type { ParseOutcome } from '../intent.js';
import { parseRequest, isExplicitMixRequest, type ParseContext } from '../nl-parser.js';

export interface ResolvedDestination { dest?: 'pa' | 'fones'; aux?: number; sourceText: string; problem?: string; problemCode?: 'ambiguous' | 'unavailable_aux' | 'unknown_return' }
const normalized = (text: string) => words(text).join(' ').replace(/\b(ch|canal|aux)(\d+)\b/g, '$1 $2');
/** Destination names are resolved separately so "retorno do Lucius" cannot become a second input channel. */
export function resolveDestination(raw: string, names: ChannelMap): ResolvedDestination {
  const text = normalized(raw), pa = /\b(pa|publico|plateia|main)\b/.test(text);
  const numbered = [...text.matchAll(/\baux\s*(\d+)\b/g)];
  if (numbered.length) {
    const ids = [...new Set(numbered.map(m => Number(m[1])))];
    const sourceText = text.replace(/\baux\s*\d+\b/g, '').trim();
    if (ids.length !== 1 || pa) return { sourceText, problemCode: 'ambiguous', problem: 'Escolha um destino de cada vez: PA ou um AUX.' };
    try { return { sourceText, dest: 'fones', aux: names.auxBus(ids[0]).number }; }
    catch { return { sourceText, problemCode: 'unavailable_aux', problem: `AUX ${ids[0]} não está disponível no cadastro/limites atuais. Peça ao operador para conferir o destino.` }; }
  }
  const named = /\b(?:no|nos|na|nas|pro|para)\s+((?:retorno|monitor|fone|fones)\b.*)$/.exec(text);
  if (named) {
    const phrase = named[1].replace(/\s+(?:em|para|pra)?\s*[+-]?\d+(?:[.,]\d+)?\s*db\b.*$/, '').trim();
    const sourceText = text.replace(phrase, '').trim();
    if (pa) return { sourceText, problemCode: 'ambiguous', problem: 'Escolha um destino de cada vez: PA ou um AUX.' };
    // Unqualified FONES/retorno keeps the existing shared-AUX policy, not a musician-specific monitor.
    if (/^(retorno|retornos|fone|fones|monitor)$/.test(phrase)) return { sourceText, dest: 'fones' };
    try { return { sourceText, dest: 'fones', aux: names.auxBus(phrase).number }; }
    catch {
      // "…só no retorno, também sozinho": complemento sem qualificador de nome não é um AUX nomeado; vale o FONES padrão.
      if (/^(retorno|retornos|fone|fones|monitor)\b(?!\s+(?:d[oae]s?|de)\b)/.test(phrase)) return { sourceText, dest: 'fones' };
      return { sourceText, problemCode: 'unknown_return', problem: 'Esse retorno não tem vínculo inequívoco no cadastro. Qual PA/AUX você quer consultar ou ajustar?' }; }
  }
  if (pa) return { sourceText: text.replace(/\b(pa|publico|plateia|main)\b/g, ''), dest: 'pa' };
  if (/\b(fone|fones|retorno|retornos|monitor)\b/.test(text)) return { sourceText: text, dest: 'fones' };
  return { sourceText: text };
}
export function channelCandidates(raw: string, names: ChannelMap): number[] {
  const text = ` ${resolveDestination(raw, names).sourceText} `;
  const spans = names.inputs.terms().filter(term => !/^\d+$/.test(term.phrase)).flatMap(term => {
    const needle = ` ${term.phrase} `, out: Array<{ start: number; end: number; channel: number }> = [];
    for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) out.push({ start: index, end: index + needle.length, channel: term.number });
    return out;
  });
  const candidates = spans.filter(span => !spans.some(other => other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start)).map(span => span.channel);
  for (const match of text.matchAll(/\b(?:canal|ch)\s*(\d+)\b/g)) if (names.inputs.configured().includes(Number(match[1]))) candidates.push(Number(match[1]));
  return [...new Set(candidates)];
}
const queryVerb = /^(?:quanto|qual|como esta|como estao|me mostra|mostra|consulte|consulta|explique|explica|o que significa)\b/;
export function parseMixerRequest(raw: string, ctx: ParseContext): ParseOutcome | undefined {
  const text = normalized(raw), query = queryVerb.test(text);
  if (/^nao\s+(muta|mute|mude|ajuste|altere|suba|aumente|abaixe|desmuta|execute)\b/.test(text)) return { kind: 'answer', text: 'Pedido de não alterar recebido; nada foi preparado ou executado.' };
  if (!query && !isExplicitMixRequest(raw)) return undefined;
  const destination = resolveDestination(raw, ctx.names);
  if (destination.problem) return { kind: 'clarify', question: destination.problem, options: [] };
  const channelNumbers = /\b(?:ch|canal)\s*(\d+)\b/g;
  for (const match of destination.sourceText.matchAll(channelNumbers)) {
    if (!ctx.names.inputs.configured().includes(Number(match[1]))) return { kind: 'answer', text: `Canal ${match[1]} não cadastrado; não vou escolher outro canal.` };
  }
  const candidates = channelCandidates(raw, ctx.names);
  if (candidates.length > 1 && [...destination.sourceText.matchAll(channelNumbers)].length === 1 && !/\be\b/.test(destination.sourceText)) return { kind: 'clarify', question: 'O nome da fonte e o número do canal não correspondem ao mesmo cadastro. Qual é a fonte correta?', options: [] };
  // A duplicated singular alias is ambiguity, not authorization to modify multiple instruments.
  const duplicate = ctx.names.inputs.terms().find(term => {
    const found = ` ${destination.sourceText} `.includes(` ${term.phrase} `);
    return found && ctx.names.inputs.terms().some(other => other.phrase === term.phrase && other.number !== term.number);
  });
  if (duplicate && candidates.length > 1) return { kind: 'clarify', question: 'Esse nome corresponde a mais de um canal. Qual deles?', options: candidates.map(channel => ({ label: ctx.names.inputs.nameOf(channel), text: `${normalized(raw).replace(duplicate.phrase, '')} canal ${channel}` })) };
  if (candidates.length > 1 && !/\b(e|vozes|vocais|todos|todas|canais)\b/.test(destination.sourceText)) return { kind: 'clarify', question: 'Encontrei mais de uma fonte na frase. Qual canal/instrumento você quer ajustar?', options: [] };
  if (query) {
    if (candidates.length !== 1) return { kind: 'clarify', question: 'Qual canal você quer consultar?', options: ctx.names.inputs.list().map(ch => ({ label: ch.name, text: `${raw} canal ${ch.number}` })) };
    if (!destination.dest) return { kind: 'clarify', question: 'A consulta é no PA ou em qual AUX?', options: [{ label: 'PA', text: `${raw} no PA` }, { label: 'Fones', text: `${raw} nos fones` }] };
    return { kind: 'query', channel: candidates[0], dest: destination.dest, ...(destination.aux === undefined ? {} : { aux: destination.aux }),
      parameter: /\bmute|mutado|mutada\b/.test(text) ? 'mute' : /^expl|configuracao|hpf|\beq\b|ganho|roteamento/.test(text) ? 'configuration' : 'level' };
  }
  if (destination.aux !== undefined) {
    const canonical = `${destination.sourceText} nos fones`;
    const result = parseRequest(canonical, ctx);
    if (result.kind === 'intents') return { ...result, intents: result.intents.map(intent => intent.type === 'level' || intent.type === 'mute' ? { ...intent, aux: destination.aux } : intent) };
    if (result.kind === 'clarify') return { ...result, options: result.options.map(option => ({ ...option, text: option.text.replace(/nos fones/g, `no AUX ${destination.aux}`) })) };
    return result;
  }
  return parseRequest(normalized(raw), ctx);
}
