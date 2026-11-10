import { Injectable, effect, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';

export type KProviderId = 'ollama' | 'gemini' | 'deepseek' | 'anthropic';
export const PROVIDER_NAMES: Record<KProviderId, string> = { ollama: 'Ollama (local, neste computador)', gemini: 'Gemini (serviço externo do Google)', deepseek: 'DeepSeek (serviço externo)', anthropic: 'Anthropic Claude (serviço externo)' };
export const PROVIDER_SHORT: Record<KProviderId, string> = { ollama: 'Ollama (local)', gemini: 'Gemini (externo)', deepseek: 'DeepSeek (externo)', anthropic: 'Anthropic Claude (externo)' };
export const PROVIDER_DEST: Record<KProviderId, string> = { ollama: 'este computador', gemini: 'o Google', deepseek: 'a DeepSeek', anthropic: 'a Anthropic' };
export interface KProviders {
  chat: { selected: KProviderId; options: Array<{ id: KProviderId; external: boolean; configured: boolean; model?: string; models?: string[] }> };
  embed: { id: KProviderId; external: boolean };
  narrative: boolean;
  externalFallback?: 'ollama' | 'none';
  /** O envio ao provedor selecionado foi confirmado NESTA sessão? (preferência gravada ou chave presente não bastam) */
  sessionConsent?: boolean;
}
export interface KStatus {
  store: { kind: 'file' | 'postgres'; ok: boolean; detail: string; fallbackFrom?: string };
  ollama: { reachable: boolean; embedModel: boolean; chatModel: boolean; detail: string; narrative: boolean };
  sources: number; documents: number; chunks: number; embeddedChunks: number;
  mode: 'vector' | 'keyword' | 'deterministic'; note: string;
  narrativeStats?: { used: number; usedBy?: Record<string, number>; dropped: Record<string, number> };
  providers?: KProviders;
}
export interface KSource { id: string; title: string; url: string; downloaded: boolean; documents: number; local: boolean }
export interface KDocument { id: string; sourceId: string; fileName: string; chunks: number; embedded: number; ingestedAt: string }
export interface KMicModel { model: string; pattern: string }
export interface KAssignment { musician: string; modelId: string | null; role: string; evidence: string }
export interface KMics { verifiedModel: string | null; bandMicModel: string; safety: string; models: Record<string, KMicModel>; assignments: Record<string, KAssignment> }
export interface KPassage { title: string; url: string; locator: string; excerpt: string; caution?: string }
export interface KIngestItem { file: string; status: string; chunks?: number; embedded?: number; reason?: string }

const ERRORS: Record<string, string> = {
  BUSY: 'Outra seleção está em andamento ou foi invalidada. Confirme novamente.',
  INVALID: 'Pedido inválido ou já em andamento.', NOT_FOUND: 'Item não encontrado.', FORBIDDEN: 'Somente o operador administra a base.',
  UNAUTHORIZED: 'Sessão encerrada. Entre novamente.', UNAVAILABLE: 'Base indisponível no momento. O diagnóstico segue pelo motor determinístico.',
};

/** Administração da base local. Só LÊ e grava na própria base: não envia comandos à mesa. */
@Injectable({ providedIn: 'root' })
export class KnowledgeAdminService {
  private readonly live = inject(LiveService);
  private readonly session = inject(SessionService);
  readonly available = signal(false);
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly status = signal<KStatus | null>(null);
  readonly sources = signal<KSource[]>([]);
  readonly documents = signal<KDocument[]>([]);
  readonly mics = signal<KMics | null>(null);
  readonly results = signal<{ mode: string; reason?: string; passages: KPassage[] } | null>(null);
  readonly ingest = signal<KIngestItem[]>([]);
  private generation = 0;

  constructor() {
    effect(() => {
      const token = this.session.token();
      const online = this.live.connection() === 'online';
      const operator = this.live.hello()?.role === 'operator';
      this.generation++;
      this.available.set(false); this.status.set(null); this.sources.set([]); this.documents.set([]); this.mics.set(null);
      this.results.set(null); this.ingest.set([]); this.error.set(''); this.notice.set(''); this.busy.set(false);
      if (token && online && operator) void this.refresh();
    });
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: object): Promise<any> {
    const token = this.session.token(); const generation = this.generation;
    if (!token) throw new Error('UNAUTHORIZED');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const res = await fetch(path, {
        method, signal: ctl.signal, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (token !== this.session.token() || generation !== this.generation) throw new Error('STALE');
      if (res.status === 404 && path === '/api/knowledge/status') throw new Error('OFF');
      if (!res.ok) throw new Error(typeof data?.code === 'string' ? data.code : 'UNAVAILABLE');
      return data;
    } finally { clearTimeout(timer); }
  }

  private fail(e: unknown) {
    const code = (e as Error).message;
    if (code === 'STALE' || code === 'OFF') return;
    this.error.set(ERRORS[code] ?? 'Sem resposta da base. Nada foi enviado à mesa.');
  }

  async refresh(): Promise<void> {
    try {
      const status = (await this.call('GET', '/api/knowledge/status')) as KStatus;
      // Servidor de outra versão ou resposta fora do formato: a seção simplesmente não aparece.
      if (status?.store?.kind !== 'file' && status?.store?.kind !== 'postgres') { this.available.set(false); return; }
      const [sources, documents, mics] = await Promise.all([
        this.call('GET', '/api/knowledge/sources'), this.call('GET', '/api/knowledge/documents'), this.call('GET', '/api/knowledge/microphones'),
      ]);
      this.status.set(status); this.sources.set(sources.sources ?? []); this.documents.set(documents.documents ?? []); this.mics.set(mics); this.available.set(true);
    } catch (e) {
      if ((e as Error).message === 'OFF') { this.available.set(false); return; }
      this.fail(e);
    }
  }

  private async act(work: () => Promise<void>, done?: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try { await work(); if (done) this.notice.set(done); await this.refresh(); } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }

  importSeed() { return this.act(async () => { await this.call('POST', '/api/knowledge/import-seed'); }, 'Pacote base importado.'); }
  runIngest() { return this.act(async () => { this.ingest.set((await this.call('POST', '/api/knowledge/ingest')).items ?? []); }, 'Pasta processada.'); }
  removeDocument(id: string) { return this.act(async () => { await this.call('DELETE', `/api/knowledge/documents/${encodeURIComponent(id)}`); }, 'Documento removido da base.'); }
  setMicrophone(channel: number, modelId: string | null) {
    return this.act(async () => { await this.call('POST', '/api/knowledge/microphones', { channel, modelId }); }, modelId ? `CH${channel}: microfone confirmado.` : `CH${channel}: confirmação removida.`);
  }
  /** Escolha do provedor do resumo. O serviço externo só entra com a confirmação do operador. */
  setProvider(chat: KProviderId, confirmExternal: boolean, model?: string) {
    return this.act(async () => { await this.call('POST', '/api/knowledge/providers', { chat, ...(confirmExternal ? { confirmExternal: true } : {}), ...(model ? { model } : {}) }); },
      chat === 'ollama' ? 'Resumo agora pelo Ollama (local).' : chat === 'gemini' ? 'Resumo agora pelo Gemini (serviço externo). O consentimento vale só nesta sessão.' : `Resumo agora por ${PROVIDER_NAMES[chat]}${model ? ` · ${model}` : ''}. O consentimento vale só nesta sessão.`);
  }
  revokeConsent() { return this.act(async () => { await this.call('DELETE', '/api/knowledge/providers/consent'); }, 'Consentimento externo revogado nesta sessão. Respostas pendentes serão descartadas.'); }
  search(query: string) {
    return this.act(async () => { this.results.set(await this.call('POST', '/api/knowledge/search', { query })); });
  }
}
