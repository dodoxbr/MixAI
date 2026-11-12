/** Presentation-only contract for C (#55). Never contains executable actions or approvals. */
export interface ConversationPresentationV1 {
  schemaVersion: 1;
  title?: string;
  sessionId: string | null;
  knownContext?: { channel?: number; sourceLabel?: string; destination?: string };
  pendingQuestion?: string | { text: string };
  choices?: Array<{ label: string; input: Record<string, unknown> }>;
  nextCheck?: string | { id: string; instruction: string; execution: 'not_executable'; requiresHumanReview: true };
  evidence?: unknown;
  confidence?: unknown;
  safety?: unknown;
  references?: unknown;
  question?: string;
  channel?: string;
  destination?: string;
  blocks?: Array<{ kind: 'report' | 'hypothesis' | 'recommendation' | 'measurement'; text: string }>;
}
export interface DiagnosticView {
  title: string;
  checkReports?: Array<{ checkId: string; title: string; label: string }>;
  checks?: Array<{ id: string; instruction: string; current: boolean; report?: string }>;
  question?: string;
  channel: string;
  destination: string;
  report?: string;
  hypothesis?: string;
  recommendation?: string;
  measurement: string;
  fullText: string;
  structuredDetails: string;
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const firstText = (v: unknown, field: string) => Array.isArray(v) ? text(record(v[0])[field]) : undefined;
/** Keep original data in details; summaries are excerpts, never new diagnostic conclusions. */
export function diagnosticView(reply: { text?: string; diagnosticContext?: { question: string; subject: string } | null; diagnosis?: unknown; clarification?: unknown; conversation?: unknown; diagnosticSession?: unknown }): DiagnosticView {
  const raw = reply.text ?? '';
  const diagnosis = record(reply.diagnosis);
  const consultation = record(diagnosis['consultation']);
  const evidence = record(consultation['evidence']);
  const diagnostic = record(consultation['diagnostic']);
  const future = record(reply.diagnosticSession ?? reply.conversation);
  const supported = future['schemaVersion'] === 1 && (future['sessionId'] === null || typeof future['sessionId'] === 'string');
  const known = supported ? record(future['knownContext']) : {};
  const pending = future['pendingQuestion'];
  const blocks = supported && Array.isArray(future['blocks']) ? future['blocks'] : [];
  const block = (kind: string) => text(record(blocks.find(b => record(b)['kind'] === kind))['text']);
  const source = raw.match(/^Fonte: (.*?)\. Destino: (.*?)\./m);
  const channelNumber = diagnostic['channel'];
  const sourceLabel = supported ? text(known['sourceLabel']) : undefined;
  const guidedChannel = sourceLabel && typeof known['channel'] === 'number' ? `${sourceLabel} (canal ${known['channel']})` : sourceLabel;
  const channel = (supported ? guidedChannel ?? (typeof known['channel'] === 'number' ? `CH${known['channel']}` : text(future['channel'])) : undefined) ?? source?.[1] ?? (typeof channelNumber === 'number' ? `CH${channelNumber}` : 'Canal a confirmar');
  const destinationValue = (supported ? text(known['destination']) ?? text(future['destination']) : undefined) ?? source?.[2] ?? 'Destino a confirmar';
  const destination = ['pa', 'fones'].includes(destinationValue.toLowerCase()) ? destinationValue.toUpperCase() : destinationValue;
  const next = supported ? record(future['nextCheck']) : {};
  const recommendations = Array.isArray(consultation['recommendations']) ? consultation['recommendations'] : Array.isArray(diagnosis['recommendations']) ? diagnosis['recommendations'] : [];
  const results = supported && Array.isArray(known['results']) ? known['results'] : [];
  const labels: Record<string,string> = {better:'melhorou',same:'igual',worse:'piorou',not_checked:'não verificado',issue_found:'problema relatado',no_issue:'sem problema relatado'};
  // Conversational API intentionally delivers one check at a time. Do not mix it with a second inferred plan.
  const checkTitles: Record<string,string> = {capture:'Captação',balance:'Equilíbrio na banda',processing:'Processamento',routing:'Roteamento',containment:'Contenção de microfonia'};
  const candidates = text(next['instruction']) ? [next] : recommendations.map(record);
  const ids = new Set<string>();
  const checks = candidates.flatMap((r,i) => {
    const instruction = text(r['instruction']), id = text(r['id']) ?? 'theory-' + i;
    if (!instruction || ids.has(id) || r['execution'] !== 'not_executable') return [];
    ids.add(id); const result = record(results.find(r => record(r)['checkId'] === id))['result'];
    return [{ id, instruction, current: next['id'] === id, report: typeof result === 'string' ? labels[result] : undefined }];
  }).slice(0,12);
  return {
    checks,
    checkReports: results.flatMap(r => { const v=record(r), id=text(v['checkId']), label=labels[String(v['result'])]; return id && label ? [{checkId:id,title:checkTitles[id] ?? 'Verificação informada',label}] : []; }),
    title: (supported ? text(future['title']) : undefined) ?? (reply.diagnosticContext ? 'Vamos verificar seu relato' : 'Orientação técnica para revisar'),
    question: reply.diagnosticContext?.question ?? text(record(reply.clarification)['question']) ?? (supported ? text(pending) ?? text(record(pending)['text']) ?? text(record(pending)['prompt']) ?? text(future['question']) : undefined),
    channel, destination,
    report: block('report') ?? firstText(evidence['reports'], 'detail'),
    hypothesis: block('hypothesis') ?? firstText(diagnosis['hypotheses'], 'explanation'),
    recommendation: (supported ? text(future['nextCheck']) ?? text(next['instruction']) : undefined) ?? block('recommendation') ?? firstText(diagnosis['recommendations'], 'instruction'),
    // An arbitrary future block must never turn model text into verified acoustic measurement.
    measurement: 'Áudio não capturado. Não ouvi nem medi o som. Medidores LAB são simulados.',
    fullText: raw,
    structuredDetails: JSON.stringify({ diagnosis: reply.diagnosis, conversation: reply.conversation, diagnosticSession: reply.diagnosticSession }, null, 2),
  };
}
export function safeReference(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null; } catch { return null; }
}
export const excerpt = (value: string, length = 220) => value.length > length ? `${value.slice(0, length).trimEnd()}…` : value;

/** Additive C choices can use the existing readonly transport, never an arbitrary action. */
export function presentationChoices(value: unknown): Array<{ label: string; input: Record<string, unknown> }> {
  const conversation = record(value);
  if (conversation['schemaVersion'] !== 1 || typeof conversation['sessionId'] !== 'string' || !Array.isArray(conversation['choices'])) return [];
  return conversation['choices'].flatMap(candidate => {
    const choice = record(candidate), label = text(choice['label']), input = choice['input'];
    return label && input && typeof input === 'object' && !Array.isArray(input) ? [{ label, input: input as Record<string, unknown> }] : [];
  });
}
