import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Suggestion } from '../contracts.js';
import {
  D_LEVEL_STEP, PARAMETER_RULES, adjustmentSchema, modelSelectionSchema, recommendationInputSchema, recommendationSchema, verificationRequestSchema,
  type Adjustment, type CurrentValue, type KnowledgeRef, type MissingInfo, type ModelSelection, type Parameter, type Recommendation, type RecommendationInput, type VerificationRequest,
} from './contracts.js';

/**
 * Motor de recomendação OFFLINE e determinístico. Não chama modelo, rede, mesa nem núcleo D. Monta um CARDÁPIO de candidatos
 * (ajustes com valores vindos de conhecimento versionado) e de pedidos de verificação; um modelo, se houver, só escolhe um item
 * do cardápio ou se abstém. Sem evidência suficiente o cardápio contém apenas verificações.
 */
export const RULES_VERSION = 'rec-rules-0.1.0';
const RULES_CONSULTED = '2026-11-09';
const FLAGS = { schemaVersion: 1, scope: 'lab_simulation', authorization: 'not_granted', execution: 'not_executable', realWrites: false, requiresHumanReview: true, measurements: 'unavailable' } as const;

const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v;
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(sorted(v))).digest('hex');

// ───────── conhecimento: entra por uma PORTA (o adaptador é o único que toca a base determinística)
export interface EqGuideView { name: string; contraindication: string; hpfFreq: number; cut: { band: number; freq: number; gain: number }; ref: KnowledgeRef }
export interface RecommendationKnowledge {
  eqGuide(instrument: 'vozes' | 'cavaco' | 'surdo'): EqGuideView;
  procedureRef(symptom: RecommendationInput['symptom']): KnowledgeRef;
  instrumentRef(instrument: RecommendationInput['instrument']): KnowledgeRef;
}
const rulesRef = (id: string, locator: string): KnowledgeRef => ({ id, sourceId: 'mixai-editorial', locator, version: RULES_VERSION, consultedOn: RULES_CONSULTED, validationStatus: 'editorial_unvalidated' });

// ───────── pedidos de verificação (vocabulário fechado)
const ASK: Record<MissingInfo, { request: string; why: string }> = {
  current_value: { request: 'Leia na interface oficial da mesa o valor atual do parâmetro e informe-o. Não altere nada.', why: 'Sem o valor atual não há como propor uma mudança nem uma reversão.' },
  listening_comparison: { request: 'Compare a mesma fonte no PA e no AUX1 e diga se o problema acontece só em um destino ou nos dois.', why: 'EQ de canal vale para os dois destinos; o destino afetado muda a ferramenta correta.' },
  isolation_check: { request: 'Compare a fonte sozinha e junto com a banda e diga em qual situação o problema aparece.', why: 'Mascaramento pelo conjunto e problema de captação pedem ajustes diferentes.' },
  capture_check: { request: 'Confira posição, eixo e distância do microfone e o cabo/DI, em nível confortável, e confirme que estão adequados.', why: 'Os procedimentos pedem revisar a captação antes de qualquer EQ.' },
  hpf_state: { request: 'Leia na interface oficial se o filtro passa-alto (HPF) do canal está ligado e em qual frequência, e informe.', why: 'Um HPF alto pode remover o grave relatado; o MixAI não lê o HPF da mesa.' },
  band_frequency: { request: 'Leia (ou ajuste, por conta própria) a frequência da banda de EQ indicada e informe o valor lido.', why: 'O ganho de uma banda só significa o que a justificativa diz na frequência prevista.' },
  level_reading: { request: 'Confirme o nível atual do canal neste destino; o servidor ainda não tem uma leitura atual do estado LAB.', why: 'O passo de nível é relativo ao valor atual e precisa caber no fader.' },
  role_confirmation: { request: 'Confirme se este canal é a voz principal ou uma voz de apoio.', why: 'O papel da voz define se a recomendação é elevar a principal ou tratar o coro.' },
};
const STOP = ['Interromper se surgir apito, distorção ou desconforto auditivo.', 'Interromper se a inteligibilidade piorar ou o operador discordar da leitura.'];

const hearing = (symptom: string) => `Relato de ${symptom} não verificado por medição; nada foi ouvido ou medido pelo MixAI.`;

// ───────── cardápio
export interface Menu { candidates: Adjustment[]; verifications: VerificationRequest[]; refusal?: Recommendation }

function refusal(reason: Extract<Recommendation, { kind: 'refusal' }>['reason'], message: string, unsupported?: Extract<Recommendation, { kind: 'refusal' }>['unsupported']): Recommendation {
  return recommendationSchema.parse({ ...FLAGS, kind: 'refusal', reason, message, ...(unsupported ? { unsupported } : {}) });
}
const UNSUPPORTED_TEXT: Record<NonNullable<RecommendationInput['requested']>, string> = {
  input_gain: 'Ganho de entrada não é representado: não há leitura real do pré-amplificador nem de headroom, e o ganho é crítico para segurança. Peça ao operador conferir os indicadores na interface oficial.',
  compressor: 'Compressão não é representada: o MixAI não conhece limiar, taxa nem redução de ganho. Pode haver recomendação de inspeção, nunca de valores.',
  gate: 'Gate não é representado: valores errados cortam notas e finais de palavras. Somente inspeção pelo operador.',
  phantom: 'Phantom nunca é alterado ou sugerido: risco para equipamento e para o ouvido.',
  de_esser: 'De-esser não é representado; a sibilância fica como orientação ao operador na interface oficial.',
  afs: 'AFS/ring-out não é sugerido nem provocado com público; microfonia segue o procedimento de segurança.',
};

function verification(input: RecommendationInput, reason: MissingInfo, knowledge: KnowledgeRef[], why?: string): VerificationRequest {
  const fp = sha({ s: input.serverId, r: input.stateRevision, c: input.channel, d: input.destination, reason, k: knowledge.map(k => k.id) });
  return verificationRequestSchema.parse({
    ...FLAGS, kind: 'verification_request', id: `ver-${fp.slice(0, 20)}`, channel: input.channel, destination: input.destination, reason,
    request: ASK[reason].request, why: why ?? ASK[reason].why, knowledge, stopConditions: STOP,
    uncertainty: { level: 'very_high', reasons: ['Faltam evidências para propor uma mudança.', hearing(input.symptom)], missing: [reason] },
  });
}

function adjustment(input: RecommendationInput, a: {
  parameter: Parameter; current: CurrentValue; value: number; mode: 'delta' | 'absolute'; knowledge: KnowledgeRef[]; valueKnowledgeId: string;
  rationale: string; risks: string[]; preconditions: string[]; verification: string; rollback: string; requires?: Adjustment['requires']; level: boolean;
}): Adjustment {
  const rule = PARAMETER_RULES[a.parameter.kind];
  const evidence: Adjustment['evidence'] = [
    input.report.kind === 'operator_report' ? { kind: 'operator_report', id: input.report.id, symptom: input.report.symptom } : { kind: 'musician_report', id: input.report.id, symptom: input.report.symptom, verified: false },
    ...(a.level && input.observedLevel ? [{ kind: 'lab_observation' as const, parameter: a.parameter.kind as 'level_main' | 'level_aux1', revision: input.observedLevel.revision, audio: false as const }] : []),
    ...a.knowledge.map(k => ({ kind: 'knowledge' as const, knowledgeId: k.id })),
  ];
  const proposed = { provenance: 'ai_suggested', mode: a.mode, value: a.value, unit: rule.unit, basis: 'editorial_trial', knowledgeId: a.valueKnowledgeId, validation: 'unvalidated' };
  const fp = sha({ serverId: input.serverId, stateRevision: input.stateRevision, channel: input.channel, destination: input.destination, parameter: a.parameter, current: a.current,
    proposed: { mode: a.mode, value: a.value }, requires: a.requires ?? [], knowledge: a.knowledge.map(k => `${k.id}@${k.version}`) });
  return adjustmentSchema.parse({
    ...FLAGS, kind: 'adjustment', id: `rec-${fp.slice(0, 20)}`, channel: input.channel, destination: input.destination, parameter: a.parameter,
    current: a.current, proposed, requires: a.requires ?? [], rationale: a.rationale, evidence, knowledge: a.knowledge,
    risks: a.risks, preconditions: a.preconditions, verification: a.verification, stopConditions: STOP,
    rollback: { automatic: false, previous: a.current, instruction: a.rollback },
    uncertainty: { level: 'high', reasons: ['O valor é um ponto de partida editorial não validado, não uma medição.', hearing(input.symptom)], missing: [] },
    binding: { serverId: input.serverId, stateRevision: input.stateRevision, contextFingerprint: fp },
  });
}

const operatorValue = (input: RecommendationInput, p: Parameter): CurrentValue => {
  const found = input.operatorEq?.find(e => e.parameter.kind === p.kind && e.parameter.band === p.band);
  return found ? { provenance: 'operator_reported', value: found.value, unit: PARAMETER_RULES[p.kind].unit, reportId: found.reportId } : { provenance: 'unknown', reason: 'not_reported' };
};

/** Voz principal encoberta pelo coro → passo relativo de nível na voz principal, só com nível observado e comparação feita. */
function leadOverChorus(input: RecommendationInput, menu: Menu, kb: RecommendationKnowledge) {
  const proc = kb.procedureRef('desequilibrio'), guide = kb.instrumentRef('vozes');
  if (input.role === 'unknown') return void menu.verifications.push(verification(input, 'role_confirmation', [proc]));
  if (input.role !== 'lead') return void menu.verifications.push(verification(input, 'role_confirmation', [proc], 'Esta recomendação cobre a voz principal; confirme o papel antes de tratar uma voz de apoio.'));
  if (input.isolation !== 'ensemble') return void menu.verifications.push(verification(input, 'isolation_check', [proc]));
  const seen = input.observedLevel;
  if (!seen || seen.revision !== input.stateRevision || typeof seen.value !== 'number') return void menu.verifications.push(verification(input, 'level_reading', [proc]));
  const kind = input.destination === 'PA' ? 'level_main' as const : 'level_aux1' as const, step = 1;
  if (seen.value + step > (PARAMETER_RULES[kind].max ?? 10)) return void menu.verifications.push(verification(input, 'level_reading', [proc], 'O nível atual deixa pouca folga no fader para um passo de +1 dB.'));
  const rules = rulesRef('rule:lead-over-chorus', 'Passo de nível de 1 dB na voz principal (ponto de partida editorial)');
  menu.candidates.push(adjustment(input, {
    parameter: { kind }, current: { provenance: 'observed', value: seen.value, unit: 'dB', revision: seen.revision, origin: 'lab_state' }, value: step, mode: 'delta',
    knowledge: [proc, guide, rules], valueKnowledgeId: rules.id, level: true,
    rationale: 'Relato de voz principal encoberta pelo coro, que só aparece com a banda: mascaramento é a hipótese. Um passo pequeno na voz principal preserva a dicção sem elevar toda a mix.',
    risks: ['Elevar a voz principal reduz a margem contra microfonia.', 'Pode encobrir o coro em vez de equilibrar.', ...(input.destination === 'AUX1' ? ['AUX1 é compartilhado: a mudança afeta todos os músicos.'] : [])],
    preconditions: ['Operador presente e escuta em nível confortável.', 'Sem apito ou desconforto ativos.', 'Relato confirmado também com a banda tocando.'],
    verification: 'Compare o mesmo trecho antes e depois, ouvindo voz principal e coro; confirme se a voz aparece sem o coro sumir.',
    rollback: 'Retorno somente humano, ao nível registrado como atual, se ainda for seguro; nada é restaurado automaticamente.',
  }));
}

/** Surdo sem grave → a única coisa sustentada pelo guia é um HPF ligado desnecessariamente; sem boost de subgrave. */
function surdoLowEnd(input: RecommendationInput, menu: Menu, kb: RecommendationKnowledge) {
  const guide = kb.eqGuide('surdo'), proc = kb.procedureRef('magro'), gref = guide.ref;
  const hpf = operatorValue(input, { kind: 'hpf_freq' });
  if (hpf.provenance === 'unknown') menu.verifications.push(verification(input, 'hpf_state', [proc, gref]));
  else if (typeof hpf.value === 'number' && hpf.value > guide.hpfFreq) {
    menu.candidates.push(adjustment(input, {
      parameter: { kind: 'hpf_freq' }, current: hpf, value: guide.hpfFreq, mode: 'absolute', knowledge: [proc, gref], valueKnowledgeId: gref.id, level: false,
      rationale: `HPF informado em ${hpf.value} Hz num surdo sem relato de grave; o guia editorial do surdo mantém o HPF desligado (${guide.hpfFreq} Hz). Sem boost de subgrave.`,
      risks: [guide.contraindication, 'Mais subgrave pode sobrecarregar o PA e excitar ressonância da sala.', 'O HPF é do canal inteiro: vale para PA e AUX1.'],
      preconditions: ['Valor do HPF lido pelo operador na interface oficial.', 'Captação e afinação do surdo já conferidas.'],
      verification: 'Compare o mesmo trecho com e sem a mudança, atento a peso, ressonância e vazamento.',
      rollback: `Retorno somente humano ao HPF informado (${hpf.value} Hz), conferindo o estado atual; nada é restaurado automaticamente.`,
    }));
  } else menu.verifications.push(verification(input, 'capture_check', [proc, gref], 'O HPF já não parece o problema; a causa mais provável está na captação, afinação ou no PA, que o MixAI não mede.'));
  if (input.isolation !== 'alone' && input.isolation !== 'ensemble') menu.verifications.push(verification(input, 'isolation_check', [proc]));
}

/** Corte de EQ de um guia editorial (voz abafada, cavaco estridente): vários portões antes de qualquer valor. */
function eqCut(input: RecommendationInput, menu: Menu, kb: RecommendationKnowledge, instrument: 'vozes' | 'cavaco') {
  const guide = kb.eqGuide(instrument), proc = kb.procedureRef(input.symptom), gref = guide.ref;
  const cut = guide.cut, band = cut.band;
  if (input.destination === 'AUX1' && input.comparison === 'target_only') {
    menu.refusal = refusal('no_candidate', 'Problema só no AUX1: o EQ do canal também altera o PA, então este protótipo não propõe EQ de canal nesse caso. Revisar nível/retorno com o operador.');
    return;
  }
  if (!input.comparison || input.comparison === 'unknown') return void menu.verifications.push(verification(input, 'listening_comparison', [proc]));
  if (!input.confirmed?.capture) return void menu.verifications.push(verification(input, 'capture_check', [proc, gref]));
  if (input.isolation !== 'alone' && input.isolation !== 'ensemble') return void menu.verifications.push(verification(input, 'isolation_check', [proc]));
  const freq = operatorValue(input, { kind: 'eq_band_freq', band }), gain = operatorValue(input, { kind: 'eq_band_gain', band });
  if (freq.provenance === 'unknown' || freq.value !== cut.freq) return void menu.verifications.push(verification(input, 'band_frequency', [gref], `O guia usa a banda ${band} em ${cut.freq} Hz; informe a frequência atual dessa banda (ou ajuste-a por conta própria) antes de qualquer ganho.`));
  if (gain.provenance === 'unknown') return void menu.verifications.push(verification(input, 'current_value', [gref], `Informe o ganho atual da banda ${band}.`));
  if (typeof gain.value === 'number' && gain.value <= cut.gain) return void menu.verifications.push(verification(input, 'capture_check', [proc], 'A banda já tem um corte igual ou maior que o do guia; o problema provavelmente não está aí.'));
  menu.candidates.push(adjustment(input, {
    parameter: { kind: 'eq_band_gain', band }, current: gain, value: cut.gain, mode: 'absolute', knowledge: [proc, gref], valueKnowledgeId: gref.id, level: false,
    requires: [{ parameter: { kind: 'eq_band_freq', band }, equals: cut.freq, current: freq }],
    rationale: `Relato de ${input.symptom} em ${guide.name.toLowerCase()} com captação confirmada: o guia editorial sugere um corte amplo de ${Math.abs(cut.gain)} dB em ${cut.freq} Hz como hipótese, nunca como correção medida.`,
    risks: [guide.contraindication, 'O EQ do canal vale para PA e AUX1.', 'Nada indica que a frequência do problema seja a do guia: não houve medição.'],
    preconditions: ['Frequência e ganho atuais da banda lidos pelo operador na interface oficial.', 'Captação conferida.', 'Sem apito ou desconforto ativos.'],
    verification: 'Alterne a passagem com e sem o corte e confirme que o relato melhora sem perder dicção ou corpo.',
    rollback: `Retorno somente humano ao ganho informado (${gain.value} dB) na banda ${band}, conferindo o estado atual; nada é restaurado automaticamente.`,
  }));
}

export function buildMenu(raw: unknown, kb: RecommendationKnowledge): Menu {
  const menu: Menu = { candidates: [], verifications: [] };
  const parsed = recommendationInputSchema.safeParse(raw);
  if (!parsed.success) return { ...menu, refusal: refusal('insufficient_evidence', 'Entrada inválida: somente contexto LAB tipado, sem comandos nem valores.') };
  const input = parsed.data;
  if (input.requested) return { ...menu, refusal: refusal('unsupported_parameter', UNSUPPORTED_TEXT[input.requested], input.requested) };
  if (input.report.symptom !== input.symptom) return { ...menu, refusal: refusal('insufficient_evidence', 'O relato classificado não corresponde ao sintoma em investigação.') };
  if (input.symptom === 'microfonia' || input.feedback === 'active') return { ...menu, refusal: refusal('safety_stop', 'Apito ou risco de microfonia: interromper a escuta e chamar o operador. Nenhum ajuste é recomendado nem testado com apito ativo.') };
  const { symptom, instrument } = input;
  if (symptom === 'desequilibrio' && instrument === 'vozes') leadOverChorus(input, menu, kb);
  else if (symptom === 'magro' && instrument === 'surdo') surdoLowEnd(input, menu, kb);
  else if (symptom === 'abafado' && instrument === 'vozes') eqCut(input, menu, kb, 'vozes');
  else if (symptom === 'estridente' && instrument === 'cavaco') eqCut(input, menu, kb, 'cavaco');
  else menu.refusal = refusal('no_candidate', 'Sem regra editorial para este caso; pedir revisão humana. O MixAI não inventa um ajuste.');
  menu.candidates = menu.candidates.slice(0, 4); menu.verifications = menu.verifications.slice(0, 3);
  return menu;
}

// ───────── escolha: determinística ou por modelo (que só escolhe)
export const MODEL_SYSTEM = 'Você escolhe UM item de um cardápio fornecido pelo servidor ou se abstém. Não ouviu nem mediu áudio. Não há ferramentas. Não gere comandos, números, parâmetros, autorização ou texto livre. Responda somente JSON: {"kind":"select","candidate":"c1"} ou {"kind":"abstain","reason":"insufficient_evidence"} ou {"kind":"abstain","reason":"needs_verification","verification":"v1"} ou {"kind":"abstain","reason":"unsafe"}.';
/** Prompt só com categorias: sem nomes, números de canal, relato livre, valores, URLs ou caminhos. */
export function modelPrompt(raw: unknown, kb: RecommendationKnowledge): string {
  const menu = buildMenu(raw, kb), input = recommendationInputSchema.parse(raw);
  return JSON.stringify({
    role: input.role, instrument: input.instrument, destination: input.destination, symptom: input.symptom, isolation: input.isolation ?? 'unknown', comparison: input.comparison ?? 'unknown',
    candidates: menu.candidates.map((c, i) => ({ id: `c${i + 1}`, parameter: c.parameter.kind, direction: c.proposed.mode === 'delta' ? (c.proposed.value > 0 ? 'raise' : 'lower') : 'set', basis: c.knowledge.map(k => k.id) })),
    verifications: menu.verifications.map((v, i) => ({ id: `v${i + 1}`, missing: v.reason })),
  });
}
export function parseModelText(text: unknown): ModelSelection | undefined {
  if (typeof text !== 'string' || !text || text.length > 2048) return undefined;
  try { const r = modelSelectionSchema.safeParse(JSON.parse(text)); return r.success ? r.data : undefined; } catch { return undefined; }
}

/** Resolve a recomendação final. Sem `selection` vale a ordem do servidor (1º candidato, senão 1ª verificação). */
export function recommend(raw: unknown, kb: RecommendationKnowledge, selection?: unknown): Recommendation {
  const menu = buildMenu(raw, kb);
  if (menu.refusal) return menu.refusal;
  if (selection === undefined) return menu.candidates[0] ?? menu.verifications[0] ?? refusal('no_candidate', 'Nenhum candidato nem verificação aplicável.');
  const parsed = modelSelectionSchema.safeParse(selection);
  if (!parsed.success) return refusal('invalid_model_output', 'Saída do modelo fora do contrato; nenhuma recomendação.');
  const s = parsed.data;
  if (s.kind === 'select') {
    const found = menu.candidates[Number(s.candidate.slice(1)) - 1];
    return found ?? refusal('invalid_model_output', 'Candidato inexistente; nenhuma recomendação.');
  }
  if (s.reason === 'unsafe') return refusal('safety_stop', 'O modelo indicou risco; nenhuma recomendação. Revisar com o operador.');
  const v = s.verification ? menu.verifications[Number(s.verification.slice(1)) - 1] : menu.verifications[0];
  if (s.verification && !v) return refusal('invalid_model_output', 'Verificação inexistente; nenhuma recomendação.');
  return v ?? refusal('insufficient_evidence', 'Evidências insuficientes e nenhuma verificação aplicável; revisar com o operador.');
}

// ───────── ponte para o núcleo D: somente passo de nível, somente com o número do OPERADOR, somente no contexto vinculado
export class DraftError extends Error { constructor(readonly code: 'NOT_AN_ADJUSTMENT' | 'NOT_DRAFTABLE' | 'STALE_CONTEXT' | 'INVALID_STEP') { super(code); } }
export function draftFromAdjustment(rec: unknown, context: { serverId: string; stateRevision: number }, operatorStepDB: number): { suggestion: z.infer<typeof Suggestion>; followedAdvice: boolean } {
  const parsed = adjustmentSchema.safeParse(rec);
  if (!parsed.success) throw new DraftError('NOT_AN_ADJUSTMENT');
  const a = parsed.data;
  if (!PARAMETER_RULES[a.parameter.kind].draftableInD) throw new DraftError('NOT_DRAFTABLE');
  if (a.binding.serverId !== context.serverId || a.binding.stateRevision !== context.stateRevision) throw new DraftError('STALE_CONTEXT');
  if (!Number.isFinite(operatorStepDB) || operatorStepDB === 0 || operatorStepDB < D_LEVEL_STEP.min || operatorStepDB > D_LEVEL_STEP.max) throw new DraftError('INVALID_STEP');
  const suggestion = Suggestion.parse({
    id: a.id, operation: 'level_delta', channel: a.channel, deltaDB: operatorStepDB,
    rationale: 'Passo informado pelo operador após ler a recomendação; a recomendação não é autorização nem aprovação.',
    evidence: [
      { kind: 'human_report', text: `Relato classificado de ${a.evidence.find(e => e.kind === 'operator_report' || e.kind === 'musician_report')!.symptom}; não verificado por medição.` },
      { kind: 'theory', text: `${a.knowledge[0]!.locator} (${a.knowledge[0]!.version}); ponto de partida editorial não validado.` },
    ],
  });
  return { suggestion, followedAdvice: operatorStepDB === a.proposed.value };
}
