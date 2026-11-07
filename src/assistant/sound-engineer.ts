import { z } from 'zod';
import { words, type ChannelMap } from '../core/channels.js';
import {
  diagnose, diagnosticInputSchema, instrumentSchema, sources, symptomSchema, technicalModules, modulesFor,
  type Diagnosis, type Instrument, type Reference, type Symptom,
} from '../knowledge/sound-engineer/index.js';
import { findChannels } from './nl-parser.js';

/** Consulta explícita, jamais aceita comando, Intent, confirmação ou aprovação. */
export const consultationSchema = diagnosticInputSchema.omit({ sourceLabel: true }).extend({
  symptom: symptomSchema.optional(),
  channel: z.number().int().positive().optional(),
  evidence: diagnosticInputSchema.shape.evidence.max(20).default([]),
}).superRefine((input, ctx) => {
  if (JSON.stringify(input).length > 16_000) ctx.addIssue({ code: 'custom', message: 'Consulta longa demais.' });
});
export type ConsultationInput = z.infer<typeof consultationSchema>;
export interface ConsultationChoice { label: string; input: ConsultationInput }
export interface ConsultationReply {
  kind: 'diagnosis';
  source: 'local';
  text: string;
  diagnosis?: Diagnosis;
  references: Array<{ title: string; url: string; locator: string; version: string; consultedOn: string }>;
  diagnosticOptions: ConsultationChoice[];
  clarification?: { field: 'symptom' | 'channel' | 'instrument' | 'destination'; question: string };
}

const vocabulary: Record<Symptom, string[]> = {
  embolado: ['embolado', 'embolada', 'embolados', 'emboladas', 'embolando'],
  estridente: ['estridente', 'estridentes', 'agressivo', 'agressiva'],
  abafado: ['abafado', 'abafada', 'abafados', 'abafadas'],
  magro: ['magro', 'magra', 'sem corpo'],
  desequilibrio: ['desequilibrio', 'desequilibrado', 'desequilibrada', 'sumindo', 'sumiu', 'encobrindo', 'encoberta', 'encoberto', 'dominando', 'baixo', 'baixa', 'alto', 'alta', 'sobressaindo'],
  microfonia: ['microfonia', 'microfonando', 'apito', 'apitando', 'feedback'],
  sibilancia: ['sibilancia', 'sibilante', 'sibilantes', 'consoantes agressivas'],
  clip: ['clip', 'clipping', 'clipando', 'saturando', 'saturacao', 'distorcendo', 'distorcido', 'distorcida', 'estourando'],
  ruido: ['ruido', 'chiado', 'zumbido', 'ronco'],
  monitoracao: ['nao me ouco', 'nao me escuto', 'nao estou me ouvindo', 'sem retorno', 'retorno sumiu'],
  ganho: ['ganho', 'gain', 'preamp', 'headroom'],
  processamento: ['phantom', '48v', 'afs2', 'hpf', 'equalizador', 'compressor', 'gate', 'eq'],
};
const instrumentTerms: Record<Instrument, string[]> = {
  cavaco: ['cavaco', 'cavaquinho', 'cava'], violao: ['violao', 'viola', '7 cordas'],
  surdo: ['surdo', 'surdao'], tanta: ['tanta', 'tantan', 'tan tan'],
  pandeiro: ['pandeiro', 'pandeirista'], vozes: ['voz', 'vozes', 'vocal', 'vocais'],
};
const has = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);
const normalized = (text: string) => words(text).join(' ');

function instrumentFor(channel: number, names: ChannelMap): Instrument | undefined {
  const terms = names.inputs.terms().filter(term => term.number === channel);
  const matches = instrumentSchema.options.filter(instrument => terms.some(term => instrumentTerms[instrument].some(t => has(term.phrase, t))));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Vocabulário fechado. Desconhecido/ambíguo fica ausente; nunca se adivinha destino ou canal. */
export function parseConsultation(raw: string, names: ChannelMap): ConsultationInput | undefined {
  const text = normalized(raw);
  const symptoms = symptomSchema.options.filter(s => vocabulary[s].some(term => has(text, term)
    && (!['baixo', 'baixa', 'alto', 'alta'].includes(term) || /\b(esta|estao|ta|tao|ficou|ficaram|soa)\b/.test(text))));
  if (!symptoms.length && !/\b(diagnostico|diagnosticar)\b|consulta tecnica|o que (podemos|posso) fazer|como (melhorar|resolver)/.test(text)) return undefined;
  const channels = findChannels(raw, names);
  const numericChannels = [...text.matchAll(/\b(?:canal|ch) (\d+)\b/g)].map(m => Number(m[1]));
  const invalidChannel = numericChannels.some(n => !names.inputs.configured().includes(n));
  const relatedInstruments = instrumentSchema.options.filter(i => instrumentTerms[i].some(t => has(text, t)));
  const channel = channels.length === 1 && !invalidChannel ? channels[0] : undefined;
  const pa = /\b(pa|publico|plateia)\b/.test(text);
  const fones = /\b(fone|fones|retorno|retornos|monitor)\b|\baux ?1\b/.test(text);
  const unsupportedAux = [...text.matchAll(/\baux ?(\d+)\b/g)].some(m => Number(m[1]) !== 1);
  const destination = pa !== fones && !unsupportedAux ? (pa ? 'pa' : 'fones') : undefined;
  // Só a frase afirmativa referente ao sintoma vira evidência; não guarda perguntas ou turnos alheios.
  const observations = (raw.match(/[^.!?]+[.!?]?/g) ?? []).filter(sentence => {
    const clause = normalized(sentence);
    const explicitMonitoringReport = vocabulary.monitoracao.some(t => has(clause, t));
    const negativeAudibility = ['nao me ouco', 'nao me escuto', 'nao estou me ouvindo'].some(t => has(clause, t));
    return !sentence.trim().endsWith('?') && !/^(?:por que|porque|como|quando|onde|qual|quais|o que|sera que)\b/.test(clause) && (/\b(esta|estao|ta|tao|ficou|ficaram|soa|soando|sumiu|tenho|microfonando|clipando|distorcendo)\b/.test(clause) || explicitMonitoringReport)
      && !/\b(se|hipoteticamente|sera|talvez)\b|o que (e|significa)/.test(clause)
      && (!/\bnao\b/.test(clause) || negativeAudibility)
      && !/nao e (verdade|o caso)/.test(clause);
  });
  return {
    symptom: symptoms.includes('microfonia') ? 'microfonia' : symptoms.length === 1 ? symptoms[0] : undefined,
    relatedInstruments,
    channel, instrument: channel ? instrumentFor(channel, names) : undefined, destination,
    evidence: symptoms.flatMap(symptom => {
      const observed = observations.filter(sentence => (symptom === 'monitoracao' || !/\bnao\b/.test(normalized(sentence))) && vocabulary[symptom].some(term => has(normalized(sentence), term)));
      return observed.length ? [{ id: `chat-${symptom}`, kind: 'operator_report' as const, symptom, detail: observed.join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim() }] : [];
    }),
  };
}

/** Só conhece o diretório de nomes, nunca o mixer, estado, histórico, fila ou propostas. */
export function consult(input: ConsultationInput, names: ChannelMap, fonesAux: number): ConsultationReply {
  if (input.channel !== undefined && !names.inputs.configured().includes(input.channel)) throw new Error('Canal não cadastrado na banda.');
  if (input.destination === 'fones' && fonesAux !== 1) throw new Error('A base descreve FONES no AUX 1; confirme o mapeamento antes de consultar outro AUX.');
  const inferred = input.channel ? instrumentFor(input.channel, names) : undefined;
  if (inferred && input.instrument && inferred !== input.instrument) throw new Error('O instrumento informado não corresponde ao canal cadastrado.');
  const context = { ...input, instrument: input.instrument ?? inferred };
  const choices: ConsultationChoice[] = [];
  const missing: string[] = [];
  let field: NonNullable<ConsultationReply['clarification']>['field'] | undefined;
  if (!context.symptom) {
    field = 'symptom';
    missing.push('Qual sintoma você deseja investigar?');
    for (const symptom of symptomSchema.options) choices.push({ label: symptom, input: { ...context, symptom } });
  } else if (!context.channel) {
    field = 'channel';
    missing.push('Qual canal/fonte da banda apresenta a queixa? Escolha um de cada vez.');
    for (const channel of names.inputs.list()) choices.push({ label: channel.name, input: { ...context, channel: channel.number, instrument: undefined } });
  } else if (!context.instrument) {
    field = 'instrument';
    missing.push('Qual instrumento está ligado a esse canal? O cadastro não identifica um guia com segurança.');
    for (const instrument of instrumentSchema.options) choices.push({ label: instrument, input: { ...context, instrument } });
  } else if (!context.destination) {
    field = 'destination';
    missing.push('No PA (som do público) ou nos FONES (AUX 1 compartilhado por todos)?');
    for (const destination of ['pa', 'fones'] as const) choices.push({ label: destination === 'pa' ? 'PA' : 'Fones', input: { ...context, destination } });
  }
  // Não apresentar ensaio teórico se a fonte ainda estiver ambígua, mesmo com instrumento genérico.
  const diagnosis = context.symptom ? diagnose({
    symptom: context.symptom, instrument: context.channel ? context.instrument : undefined,
    destination: context.destination, evidence: context.evidence, channel: context.channel,
    sourceLabel: context.channel ? names.inputs.nameOf(context.channel) : undefined, relatedInstruments: context.relatedInstruments,
  }) : undefined;
  const lines = [
    'Consulta técnica — somente leitura, offline.',
    'Não ouvi o som. Esta orientação usa conhecimento técnico e relatos do operador; não é medição real.',
    `Fonte: ${context.channel ? `${names.inputs.nameOf(context.channel)} (canal ${context.channel})` : 'a confirmar'}. Destino: ${context.destination === 'pa' ? 'PA' : context.destination === 'fones' ? 'FONES — AUX 1 compartilhado: todos ouvem a mesma mix' : 'a confirmar'}.`,
    ...missing,
  ];
  const refs: Reference[] = [];
  if (diagnosis) {
    const confidence = diagnosis.confidence.level === 'low' ? 'baixa' : 'insuficiente';
    lines.push('Relato (não é medição):', ...diagnosis.consultation.evidence.musicianReports.map(e => `• ${e.detail}`));
    const readings = diagnosis.consultation.evidence.controlReadings;
    lines.push('Estado observado pelo próprio diagnóstico: indisponível; esta consulta não lê o mixer.');
    for (const { evidence } of readings) if (evidence.kind === 'control_state') lines.push(`Estado declarado, não verificado nesta consulta: ${evidence.parameter}=${evidence.value}; revisão ${evidence.revision}; momento ${evidence.observedAt ?? 'não informado'}.`);
    lines.push('Medição indisponível: áudio, RTA/espectro, SPL, VU real e redução de ganho. Medidor LAB é simulado.');
    lines.push(`Confiança ${confidence}: ${diagnosis.confidence.rationale}`, 'Hipóteses alternativas (não confirmadas):');
    for (const h of diagnosis.hypotheses) {
      lines.push(`• ${h.explanation} Base: ${h.supportingEvidenceIds.length ? 'relato do operador' : 'sem relato compatível'}.`);
      refs.push(...h.references);
    }
    lines.push('Perguntas para investigar:', ...diagnosis.consultation.nextQuestions.map(q => `• ${q}`));
    for (const r of diagnosis.recommendations) {
      lines.push(`${r.kind === 'inspection' ? 'Inspeção' : 'Ensaio teórico para revisão humana'}: ${r.instruction}`, `Por quê: ${r.hypothesisIds.map(id => diagnosis.hypotheses.find(h => h.id === id)?.explanation).join(' ')}`, `Antes: ${r.preconditions.join(' ')}`, `Observar: ${r.expectedObservation}`, `Parar/rever: ${r.stopOrRevert}`);
      refs.push(...r.references);
    }
    const guide = diagnosis.instrumentGuide;
    if (guide) {
      lines.push(`Guia de samba/pagode (não validado em ensaio): ${guide.role}`, ...guide.captureChecks.map(t => `• ${t}`), ...guide.conditionalAdvice.map(t => `• ${t}`), `Cuidado: ${guide.avoid}`);
      refs.push(...guide.references);
    }
    lines.push('Papel musical e interações condicionais:', ...diagnosis.bandGuidance.map(t => `• ${t}`));
    for (const id of modulesFor(diagnosis.symptom)) {
      const module = technicalModules[id];
      lines.push(`Módulo ${id} v${module.version} — ${module.validationStatus}: ${module.guidance} Limite: ${module.limitation}`);
      refs.push(...module.references);
    }
    lines.push('Ação autorizada: nenhuma. Proposta: nenhuma. Recomendação exige revisão humana.', `Reversão: ${diagnosis.consultation.rollback.instruction}`);
    lines.push('Limitações:', ...diagnosis.limitations.map(l => `• ${l}`));
  }
  lines.push('Nenhum ajuste foi criado ou aplicado. Esta consulta não gera proposta, botão Aplicar ou aprovação. Responda ao esclarecimento pendente no chat ou use as opções de consulta.');
  return {
    kind: 'diagnosis', source: 'local', text: lines.join('\n'), diagnosis,
    references: [...new Map(refs.map(ref => [`${ref.source}:${ref.locator}`, { title: sources[ref.source].title, url: sources[ref.source].url, locator: ref.locator, version: sources[ref.source].version, consultedOn: sources[ref.source].consultedOn }])).values()],
    diagnosticOptions: choices,
    clarification: field ? { field, question: missing[0]! } : undefined,
  };
}


/** Uma resposta curta só pode selecionar o campo que o servidor está perguntando. */
export function matchConsultationChoice(raw: string, reply: ConsultationReply, names: ChannelMap): ConsultationChoice | undefined {
  const text = normalized(raw).replace(/^(?:(?:no|nos|na|nas|e|eh|o|a|esta|ta) )+/, '');
  const exact = reply.diagnosticOptions.filter(choice => normalized(choice.label) === text);
  if (exact.length === 1) return exact[0];
  if (reply.clarification?.field === 'channel') {
    const channel = names.inputs.list().find(ch => String(ch.number) === text || `canal ${ch.number}` === text);
    const terms = names.inputs.terms().filter(term => term.phrase === text);
    const numbers = new Set(channel ? [channel.number] : terms.map(term => term.number));
    if (numbers.size === 1) return reply.diagnosticOptions.find(choice => choice.input.channel === [...numbers][0]);
  }
  if (reply.clarification?.field === 'destination') {
    if (['fone', 'fones', 'retorno', 'aux 1'].includes(text)) return reply.diagnosticOptions.find(choice => choice.input.destination === 'fones');
  }
  return undefined;
}

export function isShortConsultationAnswer(raw: string, names: ChannelMap): boolean {
  const text = normalized(raw);
  return /^(?:(?:no|nos) )?(?:pa|fone|fones|retorno|aux 1)$/.test(text)
    || /^(?:sim|sim por favor|nao|ok|isso|isso mesmo|pode ser|confirmo|confirmar|aplicar|aprovar|[+-]?\d+(?:[.,]\d+)?(?: db)?|canal \d+)$/.test(text)
    || names.inputs.terms().some(term => term.phrase === text);
}
