/** Temporary UI boundary for #72/#73. Presentation data, never mixer commands or authorization. */
export interface AutoContext {
  eventId: string;
  eventName: string;
  eventVersion: number;
}
export interface AutoAnswers {
  goal: string;
  channel: number;
  destination: 'PA' | 'AUX1';
  report: string;
}
export interface AutoInput extends AutoContext, AutoAnswers {
  schemaVersion: 1;
  scope: 'lab_simulation';
  stateRevision: number | null;
}
export interface AutoItem {
  id: string;
  channel: number;
  destination: 'PA' | 'AUX1';
  title: string;
  before: string;
  after: string;
  rationale: string;
  evidence: string;
  risk: 'low' | 'moderate';
  preconditions: string[];
  limitations: string[];
  validation: string;
  rollback: string;
  references: { title: string; url: string }[];
}
export interface AutoPlan {
  schemaVersion: 1;
  scope: 'lab_simulation';
  id: string;
  fixture: boolean;
  items: AutoItem[];
}
export interface AutoResult {
  schemaVersion: 1;
  scope: 'lab_simulation';
  planId: string;
  itemId: string;
  before: string;
  after: string;
  verification: string;
  acousticValidated: false;
}
export interface AutoReference {
  schemaVersion: 1;
  scope: 'lab_simulation';
  eventId: string;
  version: number;
  temporary: true;
  items: { item: AutoItem; result: AutoResult }[];
}
export interface AutoAdapter {
  readonly kind: 'fixture' | 'integrated';
  plan(input: AutoInput): Promise<unknown>;
  simulate(input: { plan: AutoPlan; itemId: string; operatorApproved: true }): Promise<unknown>;
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000) throw Error('contract');
  return v;
}
function list(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 12) throw Error('contract');
  return v.map(text);
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('contract');
  return v as Record<string, unknown>;
}
export function adaptPlan(value: unknown, input: AutoInput): AutoPlan {
  const p = record(value);
  if (
    p['schemaVersion'] !== 1 ||
    p['scope'] !== 'lab_simulation' ||
    typeof p['fixture'] !== 'boolean' ||
    !Array.isArray(p['items']) ||
    !p['items'].length ||
    p['items'].length > 12
  )
    throw Error('contract');
  const ids = new Set<string>();
  const items = p['items'].map((value) => {
    const i = record(value);
    const id = text(i['id']);
    if (
      ids.has(id) ||
      i['channel'] !== input.channel ||
      i['destination'] !== input.destination ||
      !['low', 'moderate'].includes(i['risk'] as string)
    )
      throw Error('contract');
    ids.add(id);
    if (!Array.isArray(i['references']) || !i['references'].length || i['references'].length > 12)
      throw Error('contract');
    const references = i['references'].map((value) => {
      const r = record(value);
      const url = text(r['url']);
      if (new URL(url).protocol !== 'https:') throw Error('contract');
      return { title: text(r['title']), url };
    });
    return {
      id,
      channel: input.channel,
      destination: input.destination,
      title: text(i['title']),
      before: text(i['before']),
      after: text(i['after']),
      rationale: text(i['rationale']),
      evidence: text(i['evidence']),
      risk: i['risk'] as AutoItem['risk'],
      preconditions: list(i['preconditions']),
      limitations: list(i['limitations']),
      validation: text(i['validation']),
      rollback: text(i['rollback']),
      references,
    };
  });
  return {
    schemaVersion: 1,
    scope: 'lab_simulation',
    id: text(p['id']),
    fixture: p['fixture'],
    items,
  };
}
export function adaptResult(value: unknown, plan: AutoPlan, item: AutoItem): AutoResult {
  const r = record(value);
  if (
    r['schemaVersion'] !== 1 ||
    r['scope'] !== 'lab_simulation' ||
    r['planId'] !== plan.id ||
    r['itemId'] !== item.id ||
    r['acousticValidated'] !== false ||
    r['before'] !== item.before ||
    r['after'] !== item.after
  )
    throw Error('contract');
  return {
    schemaVersion: 1,
    scope: 'lab_simulation',
    planId: plan.id,
    itemId: item.id,
    before: item.before,
    after: item.after,
    verification: text(r['verification']),
    acousticValidated: false,
  };
}
