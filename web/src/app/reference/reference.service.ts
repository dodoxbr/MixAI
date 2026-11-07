import { Injectable, effect, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { newId } from '../core/protocol';
export interface History { version: number; at: string; action: string; role: string; note?: string }
export interface Reference { id: string; eventId: string; eventName: string; eventDate: string; version: number; scope: 'PA' | 'AUX1'; operatorApprovedAt: string; validationStatus: string }
export interface GuidedPreview { id: string; report: string; context: { sourceChannel: number; destination: string; symptom: string; checksPerformed: string[]; evidenceLevel: string; diagnosis: { text: string; status?: string }; observed: { available: boolean; stateRevision: number }; referenceId?: string } }
export interface Help { guidedContext?: GuidedPreview['context']; id: string; version: number; type: string; report: string; channel?: number; destination: string; createdAt: string; expiresAt: string; state: string; response?: string; recommendation?: { source: string; text: string; references?: string[]; status?: string }; requestedBy: { sourceSessionId: string; verified: boolean; displayName?: string }; historyCount: number }
export interface Workspace { revision: number; serverId: string; references: Reference[]; requests: Help[]; channels: { number: number; name: string }[]; integrations: { identity: boolean; recommendations: boolean }; identity: { verified: boolean; displayName?: string } }
export interface Compare { referenceId: string; reference: { channels: { number: number; name: string }[]; history: History[] }; rows: { key: string; reference: { status: string; value?: number | boolean | '-inf' } }[] }
function validWorkspace(data: any): data is Workspace {
  return !!data && typeof data.serverId === 'string' && Number.isInteger(data.revision)
    && Array.isArray(data.references) && data.references.every((r: any) => r && typeof r.id === 'string' && typeof r.eventId === 'string' && typeof r.eventName === 'string' && Number.isInteger(r.version))
    && Array.isArray(data.requests) && data.requests.every((r: any) => r && typeof r.id === 'string' && typeof r.report === 'string' && typeof r.state === 'string' && Number.isInteger(r.version) && typeof r.requestedBy?.sourceSessionId === 'string')
    && Array.isArray(data.channels) && data.channels.every((c: any) => Number.isInteger(c.number) && typeof c.name === 'string')
    && typeof data.integrations?.identity === 'boolean' && typeof data.integrations?.recommendations === 'boolean' && typeof data.identity?.verified === 'boolean';
}
const errors: Record<string, string> = { INVALID: 'Dados inválidos. Confira campos e limites.', CONFLICT: 'Outra sessão alterou esta versão. Atualize e revise antes de tentar.', STALE_STATE: 'A mix mudou, o vínculo mudou ou o estado está indisponível. Reavalie os valores atuais antes de aprovar.', SERVER_CHANGED: 'Servidor reiniciado. Atualize e revise o pedido.', FORBIDDEN: 'Perfil sem autorização para esta operação.', NOT_FOUND: 'Registro indisponível para esta sessão.', STORE_UNAVAILABLE: 'Armazenamento indisponível/corrompido. Nada foi restaurado automaticamente.', DEPENDENCY_UNAVAILABLE: 'Diagnóstico #48 ainda não conectado. Avalie manualmente.', CAPACITY: 'Limite do armazenamento/histórico atingido.', UNAUTHORIZED: 'Sessão encerrada. Entre novamente.' };
@Injectable({ providedIn: 'root' })
export class ReferenceUiService {
  private live = inject(LiveService); private session = inject(SessionService);
  readonly preview = signal<GuidedPreview | null>(null);
  readonly open = signal(false); readonly data = signal<Workspace | null>(null); readonly compared = signal<Compare | null>(null);
  readonly error = signal(''); readonly busy = signal(false); readonly history = signal<Record<string, History[]>>({});
  readonly selected = signal('');
  private pending = new Set<AbortController>(); private loading = false; private generation = 0;
  constructor() {
    effect(onCleanup => {
      const key = this.session.token(); const hello = this.live.hello(); const connection = this.live.connection();
      this.generation++; this.pending.forEach(p => p.abort()); this.pending.clear(); this.loading = false;
      this.preview.set(null); this.data.set(null); this.compared.set(null); this.history.set({}); this.selected.set(''); this.error.set(''); this.busy.set(false);
      if (!key || hello?.mode !== 'lab' || !['operator', 'musician'].includes(hello?.role ?? '') || connection !== 'online') return;
      void this.refresh(); const timer = setInterval(() => { if (!this.busy()) void this.refresh(); }, 3000);
      onCleanup(() => { clearInterval(timer); this.pending.forEach(p => p.abort()); });
    });
  }
  private async request(path: string, body?: object) {
    const key = this.session.token(); const generation = this.generation;
    if (!key || this.live.connection() !== 'online' || this.live.hello()?.mode !== 'lab') throw new Error('UNAUTHORIZED');
    const controller = new AbortController(); this.pending.add(controller); const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, { method: body ? 'POST' : 'GET', signal: controller.signal, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error', headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json();
      if (key !== this.session.token() || generation !== this.generation || controller.signal.aborted) throw new Error('UNAUTHORIZED');
      if (!response.ok) throw new Error(typeof data.code === 'string' ? data.code : response.status === 401 ? 'UNAUTHORIZED' : 'INVALID');
      return data;
    } finally { clearTimeout(timer); this.pending.delete(controller); }
  }
  async refresh(): Promise<void> {
    if (this.loading) return; this.loading = true; const generation = this.generation;
    try { const data = await this.request('/api/reference-workspace'); if (!validWorkspace(data)) throw new Error('INVALID'); if (data.serverId !== this.live.hello()?.serverId) throw new Error('SERVER_CHANGED'); if (generation === this.generation && (!this.data() || data.revision >= this.data()!.revision)) this.data.set(data); }
    catch (e) { if (generation === this.generation) this.error.set(errors[(e as Error).message] ?? 'Sem resposta. Não houve reenvio automático.'); }
    finally { if (generation === this.generation) this.loading = false; }
  }
  async compare(id: string): Promise<void> {
    this.selected.set(id); this.compared.set(null);
    if (!id) return;
    try { const result = await this.request(`/api/mix-references/${encodeURIComponent(id)}/compare`); if (!Array.isArray(result?.rows) || !Array.isArray(result?.reference?.history) || !Array.isArray(result?.reference?.channels)) throw new Error('INVALID'); if (id === this.selected()) this.compared.set(result); }
    catch (e) { this.error.set(errors[(e as Error).message] ?? 'Comparação indisponível.'); }
  }
  private async mutation(path: string, body: object) {
    if (this.busy()) return undefined; this.busy.set(true); this.error.set(''); const generation = this.generation;
    try { const result = await this.request(path, { ...body, serverId: this.live.hello()?.serverId }); this.loading = false; await this.refresh(); return generation === this.generation ? result : undefined; }
    catch (e) { if (generation === this.generation) this.error.set(errors[(e as Error).message] ?? 'Resposta não recebida. Atualize antes de repetir; nada será reenviado automaticamente.'); return undefined; }
    finally { if (generation === this.generation) this.busy.set(false); }
  }
  async capture(input: { eventId: string; eventName: string; eventDate: string; scope: string; expectedVersion: number; operatorApproved: boolean }) {
    const result = await this.mutation('/api/mix-references', { ...input, expectedStateRevision: this.live.state()?.revision });
    if (result) await this.compare(result.id);
    return result;
  }
  async prepareGuided(input: { report: string; sourceChannel: number; destination: string; symptom: string; checksPerformed: string[]; targetConfirmed: boolean }) {
    this.preview.set(null); const result = await this.mutation('/api/mix-requests/preview', input);
    if (result?.id && result?.context?.diagnosis && result?.context?.observed) this.preview.set(result);
  }
  async sendGuided() {
    const preview = this.preview(); if (!preview) return;
    const result = await this.mutation('/api/mix-requests', { guidedId: preview.id, reviewed: true, requestId: preview.id, type: 'diagnostico',
      channel: preview.context.sourceChannel, destination: preview.context.destination, report: preview.report });
    if (result) this.preview.set(null); return result;
  }
  async send(input: { type: string; report: string; channel?: number; destination: string }) {
    return this.mutation('/api/mix-requests', { ...input, requestId: newId('pedido') });
  }
  async decide(request: Help, state: string, response: string) {
    return this.mutation(`/api/mix-requests/${request.id}/decide`, { expectedVersion: request.version, expectedStateRevision: this.live.state()?.revision, state, response });
  }
  async assess(request: Help) { return this.mutation(`/api/mix-requests/${request.id}/assess`, { expectedVersion: request.version, expectedStateRevision: this.live.state()?.revision }); }
  async cancel(request: Help) { return this.mutation(`/api/mix-requests/${request.id}/cancel`, { expectedVersion: request.version }); }
  async reply(request: Help, text: string) { return this.mutation(`/api/mix-requests/${request.id}/reply`, { expectedVersion: request.version, text }); }
  async details(request: Help) {
    try { const result = await this.request(`/api/mix-requests/${request.id}`); this.history.update(h => ({ ...h, [request.id]: result.history })); }
    catch (e) { this.error.set(errors[(e as Error).message] ?? 'Histórico indisponível.'); }
  }
}
