import { SoundcheckService } from '../soundcheck/service.js';
import { GuidedInput, type GuidedPreview } from './guided.js';
import { createHash, randomUUID } from 'node:crypto';
import type { SceneStore } from '../core/scene-store.js';
import type { DeviceProfile } from '../core/scene.js';
import { decodeValue } from '../core/state.js';
import type { WireSnapshot } from '../core/state.js';
import type { ParamKey, ParamValue } from '../core/revisions.js';
import type { Principal } from '../server/auth.js';
import type { ReferencePorts } from './contracts.js';
import { ReferenceStore } from './store.js';
import { CaptureInput, DecisionInput, RequestInput, RevisionInput, ReplyInput, RequestSchema, ReferenceError, type Document, type HelpRequest, type Reference } from './schema.js';
const terminal = new Set(['rejected', 'failed', 'cancelled', 'expired', 'applied', 'closed']);
export class ReferenceService {
  readonly soundcheck: SoundcheckService;
  private previews = new Map<string, { preview: GuidedPreview; owner: Principal; binding: ReturnType<ReferenceService['identity']> }>();
  async preview(p: Principal, raw: unknown): Promise<GuidedPreview> {
    this.guard(p); const input = this.parse(GuidedInput, raw); const identity = this.identity(p);
    if (!this.read.channels().some(c => c.number === input.sourceChannel)) throw new ReferenceError('INVALID');
    if (p.role === 'musician' && identity.verified && !identity.boundChannels?.includes(input.sourceChannel)) throw new ReferenceError('FORBIDDEN');
    if (!this.ports.recommendations) throw new ReferenceError('DEPENDENCY_UNAVAILABLE');
    for (const [id, entry] of this.previews) if (Date.parse(entry.preview.expiresAt) <= this.clock() || !this.read.active(entry.owner)) this.previews.delete(id);
    if (this.previews.size >= 100) throw new ReferenceError('CAPACITY');
    const document = this.document();
    if (input.referenceId && !document.references.some(r => r.id === input.referenceId && r.scope === input.destination && r.channels.some(c => c.number === input.sourceChannel))) throw new ReferenceError('INVALID');
    const snapshot = this.snapshot();
    const result = await this.ports.recommendations.recommend({ report: input.report, channel: input.sourceChannel, destination: input.destination, stateRevision: snapshot.revision, guidanceContext: { sessionId: p.id, symptom: input.symptom, checksPerformed: input.checksPerformed, evidenceLevel: 'human_report_unverified' } });
    const advice = RequestSchema.shape.recommendation.unwrap().safeParse(result);
    if (!advice.success || advice.data.source !== 'diagnosis') throw new ReferenceError('INVALID');
    this.guard(p);
    if (JSON.stringify(identity) !== JSON.stringify(this.identity(p))) throw new ReferenceError('STALE_STATE');
    const keys = input.destination === 'PA' ? [`ch.${input.sourceChannel}.main.level`, `ch.${input.sourceChannel}.main.mute`] : [`ch.${input.sourceChannel}.aux.1.level`, `ch.${input.sourceChannel}.aux.1.mute`];
    const values: Reference['observations'] = {};
    for (const key of keys) { const entry = snapshot.params[key]; values[key] = { ...(!snapshot.available ? { status: 'unavailable' as const } : !this.read.supports(key) ? { status: 'unsupported' as const } : entry?.value ?? { status: 'unknown' }), revision: entry?.revision ?? 0 }; }
    const preview: GuidedPreview = { id: randomUUID(), report: input.report, expiresAt: new Date(this.clock() + 600000).toISOString(), context: {
      schemaVersion: 1, sessionId: p.id, sourceChannel: input.sourceChannel, destination: input.destination, symptom: input.symptom,
      checksPerformed: input.checksPerformed, evidenceLevel: 'human_report_unverified', diagnosis: { text: advice.data.text, status: advice.data.status, references: advice.data.references },
      observed: { serverId: this.read.serverId, stateRevision: snapshot.revision, available: snapshot.available, values },
      ...(input.referenceId ? { referenceId: input.referenceId } : {}), rollback: 'informative_only_no_automatic_restore',
    } };
    if (this.previews.size >= 100) throw new ReferenceError('CAPACITY');
    this.previews.set(preview.id, { preview, owner: p, binding: identity }); return preview;
  }

  constructor(private store: ReferenceStore, private read: {
    mode: string; serverId: string; snapshot(): WireSnapshot; channels(): { number: number; name: string }[];
    device: DeviceProfile; scenes: SceneStore; supports(key: string): boolean; active(p: Principal): boolean;
  }, private ports: ReferencePorts = {}, private clock = Date.now) { this.soundcheck = new SoundcheckService(store, read, clock); }
  private now() { return new Date(this.clock()).toISOString(); }
  private guard(p: Principal, operator = false) {
    if (this.read.mode !== 'lab') throw new ReferenceError('MODE_MISMATCH');
    if (!this.read.active(p)) throw new ReferenceError('UNAUTHORIZED');
    if (p.role === 'agent' || (operator && p.role !== 'operator')) throw new ReferenceError('FORBIDDEN');
  }
  private parse<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, raw: unknown): T {
    const result = schema.safeParse(raw); if (!result.success) throw new ReferenceError('INVALID');
    const input = result.data as T & { serverId: string };
    if (input.serverId !== this.read.serverId) throw new ReferenceError('SERVER_CHANGED');
    return input;
  }
  private snapshot(expected?: number) {
    const snapshot = this.read.snapshot();
    if (snapshot.mode !== 'lab') throw new ReferenceError('MODE_MISMATCH');
    if (expected !== undefined && (!snapshot.available || snapshot.revision !== expected)) throw new ReferenceError('STALE_STATE');
    return snapshot;
  }
  private document(): Document {
    const document = this.store.read(); let changed = false;
    for (const request of document.requests) if (!terminal.has(request.state) && Date.parse(request.expiresAt) <= this.clock()) {
      this.history(request, 'expired', undefined, 'Prazo encerrado. Nenhum ajuste executado.'); request.state = 'expired'; changed = true;
    }
    if (changed) this.store.commit(document, document.revision);
    return changed ? this.store.read() : document;
  }
  private history(request: HelpRequest, action: string, p?: Principal, note?: string) {
    if (request.history.length >= 50 || (request.history.length >= 49 && !terminal.has(action))) throw new ReferenceError('CAPACITY');
    request.version++;
    request.history.push({ version: request.version, action, at: this.now(), role: p?.role === 'operator' ? 'operator' : p ? 'musician' : 'system', ...(p ? { sourceSessionId: p.id } : {}), ...(note ? { note } : {}) });
  }
  private identity(p: Principal) {
    const linked = this.ports.identity?.resolve(p);
    // No shared-PIN identity inference; only a trusted adapter can assert a binding.
    return linked?.verified && linked.musicianId ? { sourceSessionId: p.id, verified: true, musicianId: linked.musicianId, displayName: linked.displayName, boundChannels: linked.channels, bindingRevision: linked.bindingRevision } : { sourceSessionId: p.id, verified: false };
  }
  private currentBinding(request: HelpRequest) {
    if (!request.requestedBy.verified) return;
    const current = this.identity({ id: request.requestedBy.sourceSessionId, role: 'musician', label: 'músico' });
    if (!current.verified || current.musicianId !== request.requestedBy.musicianId
      || current.bindingRevision !== request.requestedBy.bindingRevision
      || JSON.stringify(current.boundChannels) !== JSON.stringify(request.requestedBy.boundChannels)
      || (request.type === 'meu_canal' && !current.boundChannels?.includes(request.channel!))) throw new ReferenceError('STALE_STATE');
  }
  private owns(p: Principal, request: HelpRequest): boolean {
    if (p.role === 'operator') return true;
    const linked = this.identity(p);
    if (request.guidedContext && request.requestedBy.sourceSessionId !== p.id) return false;
    return request.requestedBy.verified
      ? !!(linked.verified && linked.musicianId === request.requestedBy.musicianId)
      : request.requestedBy.sourceSessionId === p.id;
  }
  private request(document: Document, p: Principal, id: string, version: number) {
    const request = document.requests.find(r => r.id === id);
    if (!request || !this.owns(p, request)) throw new ReferenceError('NOT_FOUND');
    if (request.version !== version) throw new ReferenceError('CONFLICT');
    if (terminal.has(request.state)) throw new ReferenceError('CONFLICT');
    return request;
  }
  view(p: Principal) {
    this.guard(p); const document = this.document();
    const requests = document.requests.filter(r => this.owns(p, r)).map(({ fingerprint: _, requestId: __, history, ...r }) => ({ ...r, historyCount: history.length }));
    return { requestCapabilities: { guidedPreviewVersion: 1, closure: true }, serverId: this.read.serverId, revision: document.revision,
      references: p.role === 'operator' ? document.references.filter(r => !r.simulation && r.source.mode === this.read.mode).map(({ scene, observations, history, ...r }) => ({ ...r, sceneId: scene.id, observedCount: Object.keys(observations).length, historyCount: history.length })) : [],
      requests, channels: this.read.channels(), integrations: { identity: !!this.ports.identity, recommendations: !!this.ports.recommendations }, identity: this.identity(p), sharedAux: 1 };
  }
  detail(p: Principal, id: string) {
    this.guard(p); const found = this.document().requests.find(r => r.id === id && this.owns(p, r));
    if (!found) throw new ReferenceError('NOT_FOUND');
    const { fingerprint: _, requestId: __, ...request } = found;
    return p.role === 'operator' ? request : { ...request, history: request.history.map(({ sourceSessionId, ...h }) => h.role === 'musician' ? { ...h, sourceSessionId } : h) };
  }

  capture(p: Principal, raw: unknown) {
    this.guard(p, true); const input = this.parse(CaptureInput, raw);
    const snapshot = this.snapshot(input.expectedStateRevision); const document = this.document();
    const previous = document.references.filter(r => r.eventId === input.eventId && r.scope === input.scope).at(-1);
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new ReferenceError('CONFLICT');
    if (document.references.length >= 100 || (previous?.history.length ?? 0) >= 50) throw new ReferenceError('CAPACITY');
    const channels = this.read.channels();
    const keys = channels.flatMap(ch => input.scope === 'PA' ? [`ch.${ch.number}.main.level`, `ch.${ch.number}.main.mute`] : [`ch.${ch.number}.aux.1.level`, `ch.${ch.number}.aux.1.mute`]);
    if (input.scope === 'PA') keys.push('master.level');
    const observations: Reference['observations'] = {}; const values = new Map<ParamKey, ParamValue>();
    for (const key of keys) {
      const current = snapshot.params[key];
      const value = current?.value;
      observations[key] = this.read.supports(key) ? { ...(value ?? { status: 'unknown' as const }), revision: current?.revision ?? 0, ...(current?.actor ? { actor: current.actor } : {}) } : { status: 'unsupported', revision: 0 };
      if (value?.status === 'known' && this.read.supports(key)) { const decoded = decodeValue(value.value); if (decoded !== undefined) values.set(key as ParamKey, decoded); }
    }
    const version = (previous?.version ?? 0) + 1; const id = randomUUID(); const now = this.now();
    // Reuse E5 scene creation/validation/compatibility, but freeze a copy: no load/recall path here.
    const scene = this.read.scenes.create({ name: `Ref ${input.eventId.slice(0, 8)} ${input.scope} v${version} ${id.slice(0, 6)}`, description: input.eventName, values, source: { mode: 'lab', app: 'MixAI referência' } });
    if (!scene.ok) throw new ReferenceError(scene.code === 'CONFLICT' ? 'CAPACITY' : 'STORE_UNAVAILABLE');
    const reference: Reference = { id, eventId: input.eventId, eventName: input.eventName, eventDate: input.eventDate, version, scope: input.scope, createdAt: now, channels, scene: scene.value, deviceProfile: this.read.device,
      source: { mode: 'lab', app: 'MixAI', serverId: this.read.serverId, stateRevision: snapshot.revision }, validationStatus: 'UNVERIFIED', operatorApprovedAt: now, approvedBy: { sourceSessionId: p.id, role: 'operator' }, observations,
      history: [...(previous?.history ?? []), { version, action: 'reference_approved', at: now, role: 'operator', sourceSessionId: p.id }],
    };
    document.references.push(reference); this.store.commit(document, document.revision); return reference;
  }
  compare(p: Principal, id: string) {
    this.guard(p, true); const reference = this.document().references.find(r => r.id === id && !r.simulation && r.source.mode === this.read.mode);
    if (!reference) throw new ReferenceError('NOT_FOUND');
    if (JSON.stringify(reference.deviceProfile) !== JSON.stringify(this.read.device)) throw new ReferenceError('INVALID');
    const current = this.snapshot();
    const rows = Object.entries(reference.observations).map(([key, saved]) => {
      const observed = current.params[key];
      const now = !this.read.supports(key) ? { status: 'unsupported' as const } : observed?.value ?? { status: 'unknown' as const };
      const a = saved.status === 'known' ? saved.value : undefined; const b = now.status === 'known' ? now.value : undefined;
      const changed = a !== undefined && b !== undefined && a !== b;
      const delta = typeof a === 'number' && typeof b === 'number' ? b - a : null;
      return { key, reference: saved, current: now, delta, changed, relevant: changed && (typeof a === 'boolean' || delta === null || Math.abs(delta) >= 3), actor: observed?.actor ?? 'unknown', stale: !current.available };
    });
    return { reference: { id: reference.id, channels: reference.channels, history: reference.history, validationStatus: reference.validationStatus, source: reference.source }, referenceId: id, scope: reference.scope, serverId: this.read.serverId, stateRevision: current.revision, available: current.available, rows };
  }
  create(p: Principal, raw: unknown) {
    this.guard(p); const input = this.parse(RequestInput, raw); const document = this.document(); const identity = this.identity(p);
    if (input.channel !== undefined && !this.read.channels().some(c => c.number === input.channel)) throw new ReferenceError('INVALID');
    if (input.type === 'meu_canal' && this.ports.identity && (!identity.verified || input.channel === undefined || !identity.boundChannels?.includes(input.channel))) throw new ReferenceError('FORBIDDEN');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const duplicate = document.requests.find(r => r.requestedBy.sourceSessionId === p.id && r.requestId === input.requestId);
    if (duplicate) { if (!this.owns(p, duplicate)) throw new ReferenceError('NOT_FOUND'); if (duplicate.fingerprint !== fingerprint) throw new ReferenceError('CONFLICT'); return duplicate; }
    let guidedContext: GuidedPreview['context'] | undefined;
    if (input.guidedId) {
      if (document.requests.some(r => r.guidedId === input.guidedId)) throw new ReferenceError('CONFLICT');
      const entry = this.previews.get(input.guidedId);
      if (!entry || entry.owner.id !== p.id || Date.parse(entry.preview.expiresAt) <= this.clock()) throw new ReferenceError('NOT_FOUND');
      const preview = entry.preview;
      if (!input.reviewed || input.channel !== preview.context.sourceChannel || input.destination !== preview.context.destination || input.report !== preview.report || input.type !== 'diagnostico') throw new ReferenceError('INVALID');
      if (JSON.stringify(identity) !== JSON.stringify(entry.binding)) throw new ReferenceError('STALE_STATE');
      if (preview.context.observed.stateRevision !== this.snapshot().revision) throw new ReferenceError('STALE_STATE');
      guidedContext = preview.context;
    } else if (input.reviewed) throw new ReferenceError('INVALID');
    if (document.requests.length >= 500) throw new ReferenceError('CAPACITY');
    const needs = input.type === 'meu_canal' && (!identity.verified || !identity.boundChannels?.length || input.channel === undefined);
    const state = needs || (guidedContext && !identity.verified && p.role === 'musician') ? 'needs_information' : 'received'; const now = this.now();
    const request: HelpRequest = { id: randomUUID(), requestId: input.requestId, fingerprint, type: input.type, report: input.report, channel: input.channel, destination: input.destination, requestedBy: identity,
      ...(guidedContext ? { guidedContext, guidedId: input.guidedId } : {}), createdAt: now, expiresAt: new Date(this.clock() + 600000).toISOString(), version: 1, state, basis: { serverId: this.read.serverId, stateRevision: this.snapshot().revision },
      ...(needs ? { response: 'Identidade e canal não verificados; informe a fonte. Relato não concede permissão de ajuste.' } : {}),
      history: [{ version: 1, action: state, at: now, role: p.role === 'operator' ? 'operator' : 'musician', sourceSessionId: p.id }],
    };
    document.requests.push(request); this.store.commit(document, document.revision); return request;
  }
  decide(p: Principal, id: string, raw: unknown) {
    this.guard(p, true); const input = this.parse(DecisionInput, raw); const document = this.document(); const request = this.request(document, p, id, input.expectedVersion);
    const transitions: Record<string, string[]> = { received: ['needs_information', 'suggested', 'approved', 'rejected', 'failed', 'closed'], needs_information: ['received', 'suggested', 'approved', 'rejected', 'failed', 'closed'], suggested: ['suggested', 'needs_information', 'approved', 'rejected', 'failed', 'closed'], approved: ['needs_information', 'rejected', 'failed', 'closed'] };
    if (!transitions[request.state]?.includes(input.state)) throw new ReferenceError('CONFLICT');
    if (request.state === input.state && input.state !== 'suggested') throw new ReferenceError('CONFLICT');
    if (input.state === 'suggested' || input.state === 'approved') {
      this.currentBinding(request);
      const snapshot = this.snapshot(input.expectedStateRevision);
      if (input.state === 'approved' && request.state === 'suggested' && (request.basis.serverId !== this.read.serverId || request.basis.stateRevision !== snapshot.revision)) throw new ReferenceError('STALE_STATE');
      request.basis = { serverId: this.read.serverId, stateRevision: snapshot.revision };
      if (input.state !== 'approved' || !request.recommendation) request.recommendation = { source: 'operator', text: input.response };
    }
    request.response = input.response; request.state = input.state; this.history(request, input.state, p, input.response);
    this.store.commit(document, document.revision); return request;
  }
  cancel(p: Principal, id: string, raw: unknown) {
    this.guard(p); const input = this.parse(RevisionInput, raw); const document = this.document(); const request = this.request(document, p, id, input.expectedVersion);
    this.history(request, 'cancelled', p); request.state = 'cancelled'; this.store.commit(document, document.revision); return request;
  }
  reply(p: Principal, id: string, raw: unknown) {
    this.guard(p); const input = this.parse(ReplyInput, raw); const document = this.document(); const request = this.request(document, p, id, input.expectedVersion);
    if (request.state === 'approved') throw new ReferenceError('CONFLICT');
    this.history(request, 'received', p, input.text); request.state = 'received'; this.store.commit(document, document.revision); return request;
  }
  async assess(p: Principal, id: string, raw: unknown) {
    this.guard(p, true); const input = this.parse(DecisionInput.omit({ state: true, response: true }), raw);
    if (!this.ports.recommendations) throw new ReferenceError('DEPENDENCY_UNAVAILABLE');
    const document = this.document(); const request = this.request(document, p, id, input.expectedVersion); const snapshot = this.snapshot(input.expectedStateRevision);
    this.currentBinding(request);
    const advice = await this.ports.recommendations.recommend({ report: request.report, channel: request.channel, destination: request.destination, stateRevision: snapshot.revision });
    const parsed = RequestSchema.shape.recommendation.unwrap().safeParse(advice);
    if (!parsed.success || parsed.data.source !== 'diagnosis') throw new ReferenceError('INVALID');
    this.guard(p, true); this.snapshot(snapshot.revision);
    const latest = this.document(); const current = this.request(latest, p, id, input.expectedVersion);
    this.currentBinding(current);
    current.recommendation = parsed.data; current.response = 'Consulta técnica anexada; orientação somente leitura, sem ajuste automático.'; current.state = 'suggested'; current.basis = { serverId: this.read.serverId, stateRevision: snapshot.revision };
    this.history(current, 'suggested', p, 'Consulta técnica anexada; sem execução.'); this.store.commit(latest, latest.revision); return current;
  }
}
