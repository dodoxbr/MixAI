import { words, type ChannelMap } from '../core/channels.js';
import {
  consult, diagnosticSessionSchema, planDiagnosticConversation, summarizeDiagnosticTurn,
  type ConsultationInput, type ConsultationReply, type DiagnosticProgress, type DiagnosticSession,
} from './sound-engineer.js';

const norm = (s: string) => words(s).join(' ');
/** Extract only explicit context, never acoustic measurements or an action approval. */
export function reportedProgress(raw: string, destination?: 'pa' | 'fones'): Partial<DiagnosticProgress> {
  const text = norm(raw);
  if (raw.includes('?') || /\b(se|talvez|hipoteticamente|aprovar|aplicar|executar)\b/.test(text)) return {};
  const result: Partial<DiagnosticProgress> = {};
  const audibilityDeficit = /\bnao (me ouco|me escuto|estou me ouvindo)\b/.test(text);
  const pa = /\b(pa|publico|plateia)\b/.test(text), fones = /\b(fones?|retorno|aux ?1)\b/.test(text);
  if (/\b(ambos|nos dois|nos dois destinos)\b/.test(text) || (pa && fones && (!/\bnao\b/.test(text) || audibilityDeficit)) ||
    /\btambem\b/.test(text) && (destination === 'fones' && pa || destination === 'pa' && fones)) result.scope = 'both';
  else if (/\b(so|somente|apenas)\b/.test(text) && (destination === 'pa' && pa || destination === 'fones' && fones)) result.scope = 'selected_only';
  if (/\b(so|somente|apenas) (com (a banda|o coro|o conjunto|todos)|na mix|no conjunto)\b/.test(text)) result.isolation = 'ensemble';
  else if (/\b(tambem |mesmo )?(sozinh[ao]|isolad[ao])\b/.test(text) && (!/\bnao\b/.test(text) || audibilityDeficit)) result.isolation = 'alone';
  if (/\b(microfone|mic)\b/.test(text) && !/\b(captador|di|nao)\b/.test(text)) result.capture = 'microphone';
  if (/\b(captador|di)\b/.test(text) && !/\b(microfone|mic|nao)\b/.test(text)) result.capture = 'pickup_di';
  return result;
}

/** Reuses the same consultation/knowledge; only selects the next inspection. */
export function guidedConsultation(input: ConsultationInput, names: ChannelMap, aux: number, progress: DiagnosticProgress): ConsultationReply {
  const base = consult(input, names, aux);
  const state = base.diagnosticSession;
  state.knownContext = { ...state.knownContext, scope: progress.scope ?? null, isolation: progress.isolation ?? null,
    capture: progress.capture ?? null, results: structuredClone(progress.results) };
  if (base.clarification || !base.diagnosis || !input.destination) return base;
  const plan = planDiagnosticConversation(base.diagnosis, state.knownContext.instrument ?? undefined, input.destination, progress);
  state.status = plan.complete ? 'complete' : 'investigating';
  state.pendingQuestion = plan.question; state.choices = plan.choices; state.nextCheck = plan.nextCheck;
  if (progress.results.some(r => r.result === 'worse')) state.safety.warnings.push('Piora relatada: interrompa e peça avaliação do operador antes de continuar.');
  base.clarification = plan.question ? { field: plan.question.field, question: plan.question.prompt } : undefined;
  const canonicalInput = { ...input, instrument: state.knownContext.instrument ?? input.instrument };
  base.diagnosticOptions = plan.choices.map(choice => ({ label: choice.label, input: structuredClone(canonicalInput) }));
  base.text = summarizeDiagnosticTurn(input, names, base.diagnosis, state);
  base.diagnosticSession = diagnosticSessionSchema.parse(state);
  return base;
}

/** Labels/codes belong to the current question, not to an executable intent. */
export function progressChoice(raw: string, session: DiagnosticSession, reportedSymptom?: string): string | undefined {
  const text = norm(raw).replace(/^(?:(?:e|eh|o|a|no|nos) )+/, '');
  const exact = session.choices.filter(c => norm(c.label) === norm(raw) || norm(c.id) === norm(raw));
  if (exact.length === 1) return exact[0]!.value;
  if (raw.includes('?') || /\b(se|talvez|hipoteticamente|aplicar|aprovar|confirmo|nao e)\b/.test(text)) return undefined;
  const field = session.pendingQuestion?.field;
  if (field === 'check' && reportedSymptom === session.knownContext.symptom && /^(?:ainda|continua|segue)\b/.test(text)) return 'same';
  const aliases: Record<string, Record<string, string[]>> = {
    scope: { both: ['nos dois', 'ambos', 'tambem no pa', 'tambem nos fones', 'pa e fones', 'pa e retorno'], selected_only: session.knownContext.destination === 'fones' ? ['so no fone', 'somente no retorno', 'apenas no retorno', 'so nos fones'] : ['apenas no pa', 'somente no pa'], unknown: ['nao sei', 'nao comparei'] },
    isolation: { alone: ['sozinho', 'sozinha', 'mesmo sozinho', 'tambem sozinho', 'fonte isolada'], ensemble: ['so com o coro', 'so na mix', 'so com todos', 'so no conjunto'], unknown: ['nao sei', 'nao comparei'] },
    capture: { microphone: ['mic', 'microfone'], pickup_di: ['di', 'captador'], unknown: ['nao sei', 'desconhecido'] },
    check: { better: ['melhor', 'ficou melhor'], same: ['igual', 'continua igual', 'nao melhorou'], worse: ['pior', 'ficou pior'], not_checked: ['nao sei', 'ainda nao', 'nao conferi'], issue_found: ['encontrei', 'achei um problema', 'tem algo errado'], no_issue: ['esta tudo certo', 'nao achei nada', 'nenhum problema'] },
  };
  return field ? Object.entries(aliases[field] ?? {}).find(([, words]) => words.includes(norm(raw)))?.[0] : undefined;
}
