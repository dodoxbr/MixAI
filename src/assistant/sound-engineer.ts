import { z } from 'zod';
import { words, type ChannelMap } from '../core/channels.js';
import {
  queryInstructorGuidance, type InstructorGuidance, diagnose, diagnosticInputSchema, instrumentSchema, sources, symptomSchema, technicalModules, modulesFor,
  diagnosticSessionSchema, type DiagnosticSession, type DiagnosticProgress, type DiagnosticCheck, type DiagnosticQuestionField,
  type Diagnosis, type Instrument, type Reference, type Symptom,
} from '../knowledge/sound-engineer/index.js';
import { findChannels } from './nl-parser.js';

/** Consulta explícita, jamais aceita comando, Intent, confirmação ou aprovação. */
export const consultationSchema = diagnosticInputSchema.omit({ sourceLabel: true }).extend({
  symptom: symptomSchema.optional(),
  symptomCandidates: z.array(symptomSchema).max(12).optional(),
  ambiguity: z.literal('dry').optional(),
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
  clarification?: { field: DiagnosticQuestionField; question: string };
  diagnosticSession: DiagnosticSession;
  technicalDetails: { modules: Array<(typeof technicalModules)[keyof typeof technicalModules]>; instructor?: InstructorGuidance };
}

const vocabulary: Record<Symptom, string[]> = {
  embolado: ['embolado', 'embolada', 'embolados', 'emboladas', 'embolando'],
  estridente: ['estridente', 'estridentes', 'agressivo', 'agressiva'],
  abafado: ['abafado', 'abafada', 'abafados', 'abafadas', 'sem brilho'],
  magro: ['magro', 'magra', 'sem corpo', 'sem grave', 'sem graves', 'fino', 'fina'],
  desequilibrio: ['desequilibrio', 'desequilibrado', 'desequilibrada', 'sumindo', 'sumiu', 'encobrindo', 'encoberta', 'encoberto', 'dominando', 'baixo', 'baixa', 'alto', 'alta', 'sobressaindo'],
  microfonia: ['microfonia', 'microfonando', 'apito', 'apitando', 'feedback'],
  sibilancia: ['sibilancia', 'sibilante', 'sibilantes', 'consoantes agressivas'],
  clip: ['clip', 'clipping', 'clipando', 'saturando', 'saturacao', 'distorcendo', 'distorcido', 'distorcida', 'estourando'],
  ruido: ['ruido', 'chiado', 'zumbido', 'ronco'],
  monitoracao: ['nao me ouco', 'nao me escuto', 'nao estou me ouvindo', 'sem retorno', 'retorno sumiu'],
  ganho: ['ganho', 'gain', 'preamp', 'headroom'],
  processamento: ['phantom', '48v', 'afs2', 'hpf', 'equalizador', 'compressor', 'gate', 'eq', 'nasal', 'anasalada', 'anasalado'],
};
const instrumentTerms: Record<Instrument, string[]> = {
  cavaco: ['cavaco', 'cavaquinho', 'cava'], violao: ['violao', 'viola', '7 cordas'],
  surdo: ['surdo', 'surdao'], tanta: ['tanta', 'tantan', 'tan tan'],
  pandeiro: ['pandeiro', 'pandeirista'], vozes: ['voz', 'vozes', 'vocal', 'vocais'],
};
const has = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);
const normalized = (text: string) => words(text).join(' ');

export function instrumentFor(channel: number, names: ChannelMap): Instrument | undefined {
  const terms = names.inputs.terms().filter(term => term.number === channel);
  const matches = instrumentSchema.options.filter(instrument => terms.some(term => instrumentTerms[instrument].some(t => has(term.phrase, t))));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Vocabulário fechado. Desconhecido/ambíguo fica ausente; nunca se adivinha destino ou canal. */
export function parseConsultation(raw: string, names: ChannelMap): ConsultationInput | undefined {
  raw = sanitizeDiagnosticText(raw);
  const text = normalized(raw);
  const symptoms = symptomSchema.options.filter(s => vocabulary[s].some(term => has(text, term)
    && (!['baixo', 'baixa', 'alto', 'alta'].includes(term) || /\b(esta|estao|ta|tao|ficou|ficaram|soa)\b/.test(text))));
  // 'Seco' is ambiguous: do not silently turn it into a reverb/EQ prescription.
  const dry = /\b(seco|seca)\b/.test(text);
  if (dry) { for (const s of ['magro', 'processamento'] as const) if (!symptoms.includes(s)) symptoms.push(s); }
  if (!symptoms.length && !/\b(diagnostico|diagnosticar)\b|consulta tecnica|o que (podemos|posso) fazer|como (melhorar|resolver)/.test(text)) return undefined;
  const channels = findChannels(raw.replace(/\bch(\d+)\b/gi, 'ch $1'), names);
  const numericChannels = [...text.matchAll(/\b(?:canal|ch) ?(\d+)\b/g)].map(m => Number(m[1]));
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
    return !sentence.trim().endsWith('?') && !/^(?:por que|porque|como|quando|onde|qual|quais|o que|sera que)\b/.test(clause) && (/\b(esta|estao|ta|tao|ficou|ficaram|soa|soando|sumiu|tenho|microfonando|clipando|distorcendo)\b/.test(clause) || explicitMonitoringReport || /\b(sem grave|sem graves|sem corpo|sem brilho)\b/.test(clause))
      && !/\b(se|hipoteticamente|sera|talvez)\b|o que (e|significa)/.test(clause)
      && (!/\bnao\b/.test(clause) || negativeAudibility)
      && !/nao e (verdade|o caso)/.test(clause);
  });
  return {
    symptom: symptoms.includes('microfonia') ? 'microfonia' : symptoms.length === 1 ? symptoms[0] : undefined,
    relatedInstruments, symptomCandidates: symptoms, ...(dry ? { ambiguity: 'dry' as const } : {}),
    channel, instrument: channel ? instrumentFor(channel, names) : relatedInstruments.length === 1 ? relatedInstruments[0] : undefined, destination,
    evidence: symptoms.flatMap(symptom => {
      const observed = observations.filter(sentence => (symptom === 'monitoracao' || !/\bnao\b/.test(normalized(sentence))) && (vocabulary[symptom].some(term => has(normalized(sentence), term)) || dry && ['magro', 'processamento'].includes(symptom) && /\b(seco|seca)\b/.test(normalized(sentence))));
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
    missing.push(context.ambiguity === 'dry' ? 'Quando diz seco, falta corpo/grave ou sustentação/ambiência?' : 'Qual sintoma você deseja investigar?');
    for (const symptom of context.symptomCandidates?.length ? [...new Set(context.symptomCandidates)] : symptomSchema.options) choices.push({ label: context.ambiguity === 'dry' && symptom === 'magro' ? 'Falta corpo ou grave' : context.ambiguity === 'dry' && symptom === 'processamento' ? 'Falta sustentação ou ambiência' : symptom, input: { ...context, symptom } });
  } else if (!context.channel) {
    field = 'channel';
    missing.push(context.instrument === 'vozes' ? 'Qual vocalista está com o problema?' : 'Qual canal/fonte da banda apresenta a queixa?');
    for (const channel of names.inputs.list().filter(ch => names.inputs.configured().includes(ch.number) && (context.instrument ? instrumentFor(ch.number, names) === context.instrument : !context.relatedInstruments?.length || context.relatedInstruments.includes(instrumentFor(ch.number, names)!)))) choices.push({ label: channel.name, input: { ...context, channel: channel.number, instrument: undefined } });
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
  const refs: Reference[] = diagnosis ? [
    ...diagnosis.hypotheses.flatMap(h => h.references), ...diagnosis.recommendations.flatMap(r => r.references),
    ...(diagnosis.instrumentGuide?.references ?? []), ...modulesFor(diagnosis.symptom).flatMap(id => technicalModules[id].references),
  ] : [];
  const inspection = !field ? diagnosis?.recommendations.find(r => r.kind === 'inspection') : undefined;
  const nextCheck: DiagnosticCheck | null = inspection ? { id: inspection.id, instruction: inspection.instruction,
    expectedObservation: inspection.expectedObservation, rollback: inspection.stopOrRevert, execution: 'not_executable', requiresHumanReview: true } : null;
  const diagnosticSession = diagnosticSessionSchema.parse({
    schemaVersion: 1, sessionId: null, revision: null, expiresAt: null, status: field ? 'clarifying' : 'snapshot',
    knownContext: { symptom: context.symptom ?? null, channel: context.channel ?? null, sourceLabel: context.channel ? names.inputs.nameOf(context.channel) : null,
      instrument: context.instrument ?? null, relatedInstruments: context.relatedInstruments ?? [], destination: context.destination ?? null, scope: null, isolation: null, capture: null,
      basis: 'reported_or_configured_not_measured', results: [] },
    pendingQuestion: field ? { id: field, field, prompt: missing[0]! } : null,
    choices: choices.map((c, i) => ({ id: `${field}:${i}`, label: c.label, value: String(field === 'channel' ? c.input.channel : field === 'instrument' ? c.input.instrument : field === 'symptom' ? c.input.symptom : c.input.destination) })),
    nextCheck, evidence: diagnosis?.consultation.evidence ?? { reports: [], controlReadings: [], simulated: [], unavailableMeasurements: ['audio', 'rta', 'spl', 'real_input_meter', 'gain_reduction'] },
    confidence: diagnosis?.consultation.confidence ?? { level: 'insufficient', basis: 'no_matching_report', rationale: 'Contexto ainda incompleto; não houve medição.' },
    safety: { measurements: 'unavailable', observedState: 'not_acquired', automaticActions: false, realWrites: false, identity: 'not_inferred',
      warnings: context.symptom === 'microfonia' ? ['Se houver apito persistente ou desconforto, interrompa a escuta e chame o operador. Não provoque ring-out com público.'] : [] },
    references: diagnosis?.consultation.references ?? [],
  });
  return structuredClone({
    kind: 'diagnosis', source: 'local', diagnosis, diagnosticSession,
    text: summarizeDiagnosticTurn(context, names, diagnosis, diagnosticSession),
    references: [...new Map(refs.map(ref => [`${ref.source}:${ref.locator}`, { title: sources[ref.source].title, url: sources[ref.source].url, locator: ref.locator, version: sources[ref.source].version, consultedOn: sources[ref.source].consultedOn }])).values()],
    diagnosticOptions: choices, clarification: field ? { field, question: missing[0]! } : undefined,
    technicalDetails: { modules: context.symptom ? modulesFor(context.symptom).map(id => technicalModules[id]) : [],
      ...(context.symptom ? { instructor: queryInstructorGuidance({ symptom: context.symptom, channel: context.channel, instrument: context.instrument, destination: context.destination, evidence: context.evidence }) } : {}) },
  });
}


/** Uma resposta curta só pode selecionar o campo que o servidor está perguntando. */
export function matchConsultationChoice(raw: string, reply: ConsultationReply, names: ChannelMap): ConsultationChoice | undefined {
  const text = normalized(raw).replace(/^(?:(?:no|nos|na|nas|e|eh|o|a|esta|ta) )+/, '');
  const exact = reply.diagnosticOptions.filter(choice => normalized(choice.label) === text);
  if (exact.length === 1) return exact[0];
  if (reply.clarification?.field === 'channel') {
    const channel = names.inputs.list().find(ch => String(ch.number) === text || `canal ${ch.number}` === text || `ch${ch.number}` === text || `ch ${ch.number}` === text);
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
  return /^(?:(?:no|nos) )?(?:pa|fone|fones|retorno|aux ?1)$/.test(text)
    || /^(?:sim|sim por favor|nao|ok|isso|isso mesmo|pode ser|confirmo|confirmar|aplicar|aprovar|detalhes|fontes|justificativas|melhorou|piorou|sem mudanca|nao verifiquei|[+-]?\d+(?:[.,]\d+)?(?: db)?|canal \d+)$/.test(text)
    || names.inputs.terms().some(term => term.phrase === text);
}

/** Minimize ephemeral text, without treating it as permission or verified audio evidence. */
export function sanitizeDiagnosticText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\b(?:senha|password|pin|token|ssid)\s*(?::|=|é|e)\s*\S+/gi, '[dado omitido]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[endereço omitido]').trim();
}
/** Short chat text; full knowledge/evidence remain in diagnosis/technicalDetails. */
export function summarizeDiagnosticTurn(input: ConsultationInput, names: ChannelMap, diagnosis: Diagnosis | undefined, session: DiagnosticSession): string {
  const source = input.channel ? `${sanitizeDiagnosticText(names.inputs.nameOf(input.channel)).slice(0, 80)} (canal ${input.channel})` : 'a confirmar';
  const destination = input.destination === 'fones' ? 'FONES — AUX 1 compartilhado' : input.destination === 'pa' ? 'PA' : 'a confirmar';
  const lines = [`Fonte: ${source}. Destino: ${destination}.`];
  const last = session.knownContext.results.at(-1);
  if (session.status === 'complete') lines.push(last?.result === 'better' ? 'Você relatou melhora; mantenha a verificação com o operador. Isso não é medição.'
    : last?.result === 'worse' ? 'Você relatou piora: interrompa a verificação e chame o operador. Não restaure um estado inseguro.'
    : last?.result === 'issue_found' ? 'Você relatou um ponto a revisar. Leve esse achado ao operador; a causa não foi confirmada e nada foi ajustado.'
    : session.confidence.level === 'insufficient' ? 'Esta é uma consulta conceitual; a fundamentação permanece nos dados técnicos.'
    : 'Nenhuma causa foi confirmada. Leve o contexto ao operador para avaliação manual.');
  if (session.safety.warnings.length) lines.push(session.safety.warnings[0]!);
  if (session.nextCheck) {
    if (diagnosis && diagnosis.symptom !== 'microfonia' && diagnosis.confidence.level === 'low') {
      lines.push(session.knownContext.isolation === 'ensemble'
        ? 'Hipótese: o conjunto pode mascarar a articulação; isso ainda precisa de confirmação.'
        : 'Hipótese: captação ou processamento podem contribuir; isso ainda precisa de confirmação.');
    }
    lines.push(`Inspeção: ${session.nextCheck.instruction}`);
  }
  if (session.pendingQuestion) lines.push(session.pendingQuestion.prompt);
  if (diagnosis?.confidence.basis === 'musician_report_only') lines.push('Relato do músico não verificado pelo operador.');
  lines.push('Consulta somente leitura. Não ouvi o som; sem medição de áudio/RTA. Nenhum ajuste foi criado ou aplicado.');
  return lines.join('\n');
}
export { diagnosticSessionSchema, diagnosticProgressSchema, planDiagnosticConversation } from '../knowledge/sound-engineer/index.js';
export type { DiagnosticSession, DiagnosticProgress, DiagnosticCheck, DiagnosticQuestionField, DiagnosticChoice } from '../knowledge/sound-engineer/index.js';

/** Structural adapter for D's recommendation port. No request, identity binding or action. */
export interface DiagnosticRecommendationView {
  source: 'diagnosis'; status: 'needs_context' | 'theoretical_guidance'; text: string; references: string[];
  applicable: false; requiresOperatorReview: true; diagnosticSession: DiagnosticSession;
}
export function recommendationFromDiagnostic(reply: ConsultationReply): DiagnosticRecommendationView {
  return { source: 'diagnosis', status: reply.clarification ? 'needs_context' : reply.diagnosis?.status ?? 'needs_context', text: reply.text,
    references: [...new Set(reply.references.map(r => r.url))].slice(0, 10), applicable: false, requiresOperatorReview: true,
    diagnosticSession: structuredClone(reply.diagnosticSession) };
}
