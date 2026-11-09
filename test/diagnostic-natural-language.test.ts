import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';
import { DiagnosticContexts } from '../src/assistant/diagnostic-context.js';
import { isExplicitMixRequest } from '../src/assistant/nl-parser.js';
import { parseConsultation } from '../src/assistant/sound-engineer.js';

/**
 * A2 — linguagem natural. Frases reais da banda são entendidas pelo MOTOR DETERMINÍSTICO existente (vocabulário fechado);
 * relato vago pede esclarecimento; nada vira comando de volume nem diagnóstico específico sem base.
 */
const names = new ChannelMap(parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), { inputs: 12, aux: 6 });
const parseOf = (text: string) => parseConsultation(text, names);
const flow = () => new DiagnosticContexts(names, 1);

describe('frases reais da banda', () => {
  it.each([
    ['O Fred não aparece quando o coro entra.', 'desequilibrio', 3, 'vozes'],
    ['Coro cobrindo a voz do Fred.', 'desequilibrio', 3, 'vozes'],
    ['A voz do Fred está sumindo quando o coro canta.', 'desequilibrio', 3, 'vozes'],
    ['Falta grave no surdo.', 'magro', 8, 'surdo'],
    ['O surdo está sem grave.', 'magro', 8, 'surdo'],
    ['Tá microfonando quando o Fred canta.', 'microfonia', 3, 'vozes'],
  ])('"%s" → relato de %s (canal %i, %s), com o relato guardado como evidência humana', (phrase, symptom, channel, instrument) => {
    const p = parseOf(phrase)!;
    expect(p, phrase).toBeDefined();
    expect(p.symptom).toBe(symptom);
    expect(p.channel).toBe(channel);
    expect(p.instrument).toBe(instrument);
    expect(p.evidence.length, 'relato vira evidência (sem medição)').toBeGreaterThan(0);
    expect(p.evidence[0]).toMatchObject({ kind: 'operator_report', symptom });
  });

  it('"Minha voz está abafada no retorno" → voz abafada nos fones (destino lido do relato)', () => {
    expect(parseOf('Minha voz está abafada no retorno.')).toMatchObject({ symptom: 'abafado', instrument: 'vozes', destination: 'fones' });
  });

  it('"O surdo tá seco" continua ambíguo: pergunta o que "seco" quer dizer, sem receitar nada', () => {
    const p = parseOf('O surdo tá seco.')!;
    expect(p.symptom).toBeUndefined();
    expect(p).toMatchObject({ ambiguity: 'dry', channel: 8 });
    const r = flow().handle('s1', 'O surdo tá seco.')!;
    expect(r.diagnosticContext?.field).toBeDefined();
    expect(r.text).toMatch(/seco/i);
  });

  it('"Fred não aparece quando o coro entra" é problema de EQUILÍBRIO VOCAL e a primeira pergunta é uma só', () => {
    const r = flow().handle('s1', 'O Fred não aparece quando o coro entra.')!;
    expect(r.diagnosticContext).not.toBeNull();
    expect(r.diagnosticContext!.subject).toContain('desequilibrio');
    expect(r.diagnosticContext!.field).toBe('destination');
    expect(r.text.match(/\?/g)).toHaveLength(1); // uma pergunta objetiva por vez
  });
});

describe('relato vago: pede esclarecimento, não diagnostica', () => {
  it('"O som do violão está horrível" não tem sintoma, não tem evidência e oferece só descrições do som', () => {
    const p = parseOf('O som do violão está horrível.')!;
    expect(p).toBeDefined();
    expect(p.symptom).toBeUndefined();
    expect(p.evidence).toEqual([]);
    expect(p.instrument).toBe('violao');
    expect(p.symptomCandidates!.length).toBeLessThanOrEqual(6);
    expect(p.symptomCandidates).toEqual(expect.arrayContaining(['abafado', 'estridente', 'magro', 'embolado']));
    expect(p.symptomCandidates).not.toContain('microfonia'); // nada que sugira um problema específico por conta própria
  });

  it('a conversa pergunta o sintoma e só depois segue; nenhuma recomendação sai antes disso', () => {
    const c = flow();
    const first = c.handle('s1', 'O som do violão está horrível.')!;
    expect(first.diagnosticContext?.field).toBe('symptom');
    expect(first.text.match(/\?/g)).toHaveLength(1);
    expect('diagnosticOptions' in first && first.diagnosticOptions.map((o) => o.label).length).toBeLessThanOrEqual(6);
    if ('diagnosis' in first) expect(JSON.stringify(first.diagnosis ?? {})).not.toMatch(/theoretical_guidance/);
    expect(first.diagnosticSession!.knownContext.symptom).toBeNull();
    const next = c.handle('s1', 'estridente', { id: first.diagnosticContext!.id, revision: first.diagnosticContext!.revision })!;
    expect(next.diagnosticSession!.knownContext.symptom).toBe('estridente');
    expect(next.diagnosticContext?.field).not.toBe('symptom'); // avançou para a próxima pergunta
  });

  it.each([
    'tá tudo estranho',
    'o pedido está estranho',
    'o violão não é ruim',
    'o violão está ruim?',
    'se o violão estivesse horrível o que eu faria',
    'o retorno está esquisito',
  ])('"%s" NÃO vira relato vago (sem fonte, negado, pergunta ou hipótese)', (phrase) => {
    expect(parseOf(phrase), phrase).toBeUndefined();
  });
});

describe('relato de problema nunca vira comando', () => {
  it.each([
    'O Fred não aparece quando o coro entra.', 'Coro cobrindo a voz do Fred.', 'Falta grave no surdo.', 'O surdo tá seco.',
    'O som do violão está horrível.', 'Minha voz está abafada no retorno.', 'Tá microfonando quando o Fred canta.',
  ])('"%s" não é pedido explícito de mixagem', (phrase) => {
    expect(isExplicitMixRequest(phrase)).toBe(false);
  });

  it('comandos diretos continuam sendo comandos e não viram diagnóstico', () => {
    expect(isExplicitMixRequest('sobe o surdo no PA')).toBe(true);
    expect(parseOf('sobe o surdo no PA')).toBeUndefined();
    expect(parseOf('diminui 3 dB da voz Fernando nos fones')).toBeUndefined();
  });

  it('as respostas da conversa nunca carregam proposta, comando ou aprovação', () => {
    const c = flow();
    for (const phrase of ['Falta grave no surdo.', 'O som do violão está horrível.', 'Coro cobrindo a voz do Fred.']) {
      const r = c.handle(phrase.slice(0, 8), phrase)!;
      expect(r.kind).not.toBe('proposals');
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/"proposals"|"approval"|set_level|set_mute|set_master/);
    }
  });
});
