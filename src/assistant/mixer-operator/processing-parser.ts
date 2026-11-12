import { words } from '../../core/channels.js';
import type { ClarifyOption, Intent, ParseOutcome } from '../intent.js';
import type { ParseContext } from '../nl-parser.js';
import { channelCandidates, resolveDestination } from './parser.js';

/**
 * Comandos de EQ/HPF/bypass em português. Reconhece só o que a fachada 7.1.0 da Ui16 sabe fazer (docs/ui16/REAL-PROCESSING.md):
 * frequência, ganho e Q das bandas 1-4, frequência do HPF e bypass do EQ. Não executa nada: gera uma intenção tipada,
 * que o servidor transforma em PRÉVIA (nunca em escrita). EQ/HPF são do canal de entrada, nunca de um destino PA/AUX.
 */
const TOPIC = /\b(eq|equalizador|equalizacao|hpf|passa alta|high pass|bypass)\b/;
const BAND_WORD = /\bbanda\s*\d\b/;
const VERB = /^(?:por favor )?(?:aumenta|aumentar|aumente|sobe|subir|suba|eleva|levanta|diminui|diminuir|diminua|abaixa|abaixe|baixa|reduz|reduza|desce|desca|muda|mude|mudar|troca|troque|altera|altere|ajusta|ajuste|ajustar|coloca|colocar|define|deixa|bota|poe|liga|ligar|desliga|desligar|ativa|ative|ativar|desativa|desative|desativar|tira|tirar|remove|habilita|desabilita|corta)\b/;

/** O pedido é um comando de EQ/HPF? (usado para dar prioridade a comandos explícitos sobre a conversa técnica.) */
export function isProcessingCommand(raw: string): boolean {
  const text = words(raw).join(' ');
  return VERB.test(text) && (TOPIC.test(text) || BAND_WORD.test(text));
}

const num = (s: string) => Number(s.replace(',', '.'));
const clarify = (question: string, options: ClarifyOption[] = []): ParseOutcome => ({ kind: 'clarify', question, options });

export function parseProcessingRequest(raw: string, ctx: ParseContext): ParseOutcome | undefined {
  if (ctx.role !== 'operator' || !isProcessingCommand(raw)) return undefined;
  const text = words(raw).join(' ');

  // Destino explícito (PA/AUX/fones): EQ e HPF não são ajustes por destino. Nunca escolhe por conta própria.
  const destination = resolveDestination(raw, ctx.names);
  if (destination.dest || destination.problem || /\b(pa|aux\s*\d+|fones?|retornos?|monitor)\b/.test(text)) {
    const stripped = raw.replace(/\s*(?:e\s+)?\b(?:no|nos|na|nas|pro|para o|para)\s+(?:pa|aux\s*\d+|fones?|retornos?|monitor)\b/gi, '').trim();
    return clarify('EQ e HPF são processamento do canal de entrada: não existe ajuste separado por PA ou AUX. Quer aplicar no canal inteiro?',
      stripped && stripped !== raw.trim() ? [{ label: 'Ajustar o canal', text: stripped }] : []);
  }

  const candidates = channelCandidates(raw, ctx.names);
  const numbered = [...text.matchAll(/\b(?:canal|ch)\s*(\d+)\b/g)];
  for (const m of numbered) if (!ctx.names.inputs.configured().includes(Number(m[1]))) return { kind: 'answer', text: `Canal ${m[1]} não cadastrado; não vou escolher outro canal.` };
  if (candidates.length > 1) return clarify('Encontrei mais de um canal na frase. EQ/HPF são ajustados um canal por vez. Qual canal?');
  if (!candidates.length) return clarify('Qual canal você quer ajustar?', ctx.names.inputs.list().map(ch => ({ label: ch.name, text: `${raw.replace(/[.!?]+\s*$/, '')} canal ${ch.number}` })));
  const channel = candidates[0]!;
  const done = (intent: Omit<Extract<Intent, { type: 'processing' }>, 'type' | 'channel'>): ParseOutcome => ({ kind: 'intents', intents: [{ type: 'processing', channel, ...intent }] });

  const down = /\b(?:diminui|diminuir|diminua|abaixa|abaixe|baixa|reduz|reduza|desce|desca|tira|tirar)\b/.test(text);
  const up = /\b(?:aumenta|aumentar|aumente|sobe|subir|suba|eleva|levanta)\b/.test(text);
  const off = /\b(?:desliga|desligar|desativa|desative|desativar|tira|tirar|remove|desabilita)\b/.test(text);
  const on = !off && /\b(?:liga|ligar|ativa|ative|ativar|habilita|coloca|bota|poe)\b/.test(text);

  // ---------- HPF ----------
  if (/\b(hpf|passa alta|high pass)\b/.test(text)) {
    const hz = /(\d+(?:[.,]\d+)?)\s*(khz|k|hz|hertz)?\b/.exec(text.replace(/\b(?:canal|ch)\s*\d+\b/g, ''));
    const hasHz = hz && (hz[2] || /\b(?:para|em|pra)\s+\d/.test(text));
    if (off && !hasHz) return done({ field: 'hpf', value: 20 }); // sem setter de bypass: 20 Hz explícito desliga o HPF
    if (!hasHz) return clarify(on ? 'O HPF não tem chave de ligar separada. Informe a frequência de corte (20 a 300 Hz).' : 'Qual frequência de corte do HPF (20 a 300 Hz)?');
    const value = Math.round(num(hz![1]!) * (/^k/.test(hz![2] ?? '') ? 1000 : 1));
    return done({ field: 'hpf', value });
  }

  // ---------- Bypass do EQ ----------
  const band = /\bbanda\s*(\d)\b/.exec(text);
  const field = /\b(frequencia|freq|hz)\b/.test(text) ? 'freq' : /\b(ganho|gain)\b/.test(text) ? 'gain' : /\b(q|fator q)\b/.test(text) ? 'q' : undefined;
  if (!band && !field && /\b(bypass|eq|equalizador|equalizacao)\b/.test(text)) {
    if (/\bbypass\b/.test(text)) {
      if (off) return done({ field: 'bypass', value: false });
      if (on || /\b(?:ativa|liga)\b/.test(text)) return done({ field: 'bypass', value: true });
      return clarify('Quer ativar o bypass do EQ (EQ fora do caminho) ou desativar?', [{ label: 'Ativar bypass', text: `ativa o bypass do EQ do canal ${channel}` }, { label: 'Desativar bypass', text: `desativa o bypass do EQ do canal ${channel}` }]);
    }
    // "desliga o EQ" = EQ fora do caminho (bypass ligado); "liga o EQ" = bypass desligado.
    if (off) return done({ field: 'bypass', value: true });
    if (on) return done({ field: 'bypass', value: false });
    return clarify('O que fazer com o EQ do canal? Posso preparar o bypass, ou informe banda, parâmetro e valor.');
  }

  // ---------- Bandas ----------
  if (!band) return clarify('Qual banda do EQ (1 a 4)?');
  const b = Number(band[1]);
  if (b < 1 || b > 4) return { kind: 'answer', text: `A Ui16 tem bandas de EQ de 1 a 4; a banda ${b} não existe. Nada foi preparado.` };
  if (!field) return clarify(`Qual parâmetro da banda ${b}: frequência, ganho ou Q?`);
  const bandN = b as 1 | 2 | 3 | 4;
  const stripped = text.replace(/\b(?:canal|ch)\s*\d+\b/g, '').replace(/\bbanda\s*\d\b/g, '');
  if (field === 'gain') {
    const abs = /\b(?:para|em|pra)\s+([+-]?\d+(?:[.,]\d+)?)\s*(?:db)?\b/.exec(stripped);
    if (abs) return done({ field, band: bandN, value: num(abs[1]!) });
    const rel = /([+-]?\d+(?:[.,]\d+)?)\s*(?:db|decibeis?)\b/.exec(stripped);
    if (rel && (up || down)) return done({ field, band: bandN, deltaDB: (down ? -1 : 1) * Math.abs(num(rel[1]!)) });
    return clarify(`Quanto de ganho na banda ${b}? Diga, por exemplo, "para 1,5 dB" ou "aumenta 1 dB" (passo máximo de 1 dB).`);
  }
  if (field === 'freq') {
    const hz = /([+-]?\d+(?:[.,]\d+)?)\s*(khz|k|hz|hertz)?\b/.exec(stripped);
    if (!hz || (!hz[2] && !/\b(?:para|em|pra)\s+\d/.test(stripped))) return clarify(`Qual frequência da banda ${b}, em Hz (20 a 20000)?`);
    return done({ field, band: bandN, value: Math.round(num(hz[1]!) * (/^k/.test(hz[2] ?? '') ? 1000 : 1)) });
  }
  const q = /\b(?:para|em|pra)\s+(\d+(?:[.,]\d+)?)\b/.exec(stripped);
  if (!q) return clarify(`Qual Q da banda ${b} (0,1 a 10)? Diga, por exemplo, "para 1,5".`);
  return done({ field: 'q', band: bandN, value: num(q[1]!) });
}
