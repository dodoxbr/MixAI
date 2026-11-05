/**
 * Protocolo do servidor MixAI (E2), lado do navegador.
 * Espelha o formato de transmissão da E1 (src/core/state.ts) e o cliente de referência
 * (src/client/state-sync.ts). A tela não conhece a mesa: só este protocolo.
 */

export type Mode = 'mock' | 'lab' | 'real';
export type Role = 'operator' | 'musician' | 'agent';

/** Três situações que nunca se confundem (ver E1). */
export type StateValue = { status: 'known'; value: number | boolean } | { status: 'unknown' } | { status: 'unavailable' };

export interface ParamState {
  value: StateValue;
  revision: number;
  actor?: string;
}

export interface Snapshot {
  schemaVersion: 1;
  mode: Mode;
  link: string;
  available: boolean;
  revision: number;
  params: Record<string, ParamState>;
}

export type StateEvent =
  | { type: 'params'; fromRevision: number; revision: number; changes: Array<{ key: string; value: StateValue; revision: number; actor?: string }> }
  | { type: 'link'; revision: number; link: string; available: boolean };

export interface Hello {
  protocol: number;
  version: string;
  serverId: string;
  mode: Mode;
  model: string;
  link: string;
  musicianAux: number;
  role?: Role;
  meters: { available: boolean; simulated: boolean };
  assistant?: { available: boolean; ai: boolean };
}

export interface Result {
  ok: boolean;
  code: string;
  message: string;
  needsConfirmation?: boolean;
  pendingId?: string;
  data?: Record<string, unknown>;
}

export interface PendingCard {
  pendingId: string;
  status: 'open';
  summary: string;
  title: string;
  command: Record<string, unknown> & { type: string };
  requestedBy: { role: Role; label: string };
  createdAt: string;
  expiresAt: string;
}

export type PendingStatus = 'approved' | 'rejected' | 'expired' | 'invalidated' | 'failed';

export interface MeterFrame {
  type: 'meters';
  simulated: boolean;
  source: string;
  t: number;
  levels: Record<string, number | '-inf'>;
}

export interface Named {
  number: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Decodificação (nunca adivinha: valor inválido lança erro e o cliente pede snapshot)
// ---------------------------------------------------------------------------

export function decodeValue(w: unknown): StateValue {
  const o = w as { status?: unknown; value?: unknown } | null;
  if (o && o.status === 'unknown') return { status: 'unknown' };
  if (o && o.status === 'unavailable') return { status: 'unavailable' };
  if (o && o.status === 'known') {
    if (o.value === '-inf') return { status: 'known', value: -Infinity };
    if (typeof o.value === 'boolean') return { status: 'known', value: o.value };
    if (typeof o.value === 'number' && Number.isFinite(o.value)) return { status: 'known', value: o.value };
  }
  throw new Error(`valor inválido na transmissão: ${JSON.stringify(w)}`);
}

export function snapshotFromWire(w: unknown): Snapshot {
  const s = w as Omit<Snapshot, 'params'> & { params: Record<string, { value: unknown; revision: number; actor?: string }> };
  const params: Record<string, ParamState> = {};
  for (const [k, p] of Object.entries(s.params)) params[k] = { value: decodeValue(p.value), revision: p.revision, actor: p.actor };
  return { schemaVersion: 1, mode: s.mode, link: s.link, available: s.available, revision: s.revision, params };
}

export function eventFromWire(w: unknown): StateEvent {
  const e = w as { type?: unknown };
  if (e.type === 'link') return w as StateEvent;
  if (e.type !== 'params') throw new Error('tipo de evento inválido');
  const p = w as { fromRevision: number; revision: number; changes: Array<{ key: string; value: unknown; revision: number; actor?: string }> };
  return {
    type: 'params',
    fromRevision: p.fromRevision,
    revision: p.revision,
    changes: p.changes.map((c) => ({ key: c.key, value: decodeValue(c.value), revision: c.revision, actor: c.actor })),
  };
}

/** Aplica um evento a uma cópia local. gap = faltou evento (ou a leitura voltou): pedir snapshot. */
export function applyEvent(mirror: Snapshot, ev: StateEvent): 'applied' | 'stale' | 'gap' {
  if (ev.type === 'link') {
    const was = mirror.available;
    mirror.link = ev.link;
    mirror.available = ev.available;
    if (!ev.available) {
      for (const p of Object.values(mirror.params)) p.value = { status: 'unavailable' };
      return 'applied';
    }
    return was ? 'applied' : 'gap';
  }
  if (ev.revision <= mirror.revision) return 'stale';
  if (ev.fromRevision !== mirror.revision) return 'gap';
  for (const c of ev.changes) {
    if (!(c.key in mirror.params)) continue;
    mirror.params[c.key] = { value: c.value, revision: c.revision, actor: c.actor };
  }
  mirror.revision = ev.revision;
  return 'applied';
}

export type SyncOutcome = 'ready' | 'applied' | 'stale' | 'resync' | 'ignored';

/**
 * Sincronização: só aplica eventos sobre um snapshot do MESMO serverId; servidor reiniciado =
 * descarta tudo; buraco na sequência = pede snapshot.
 */
export class StateSync {
  serverId: string | undefined;
  state: Snapshot | undefined;
  resyncRequests = 0;

  constructor(private requestResync: () => void) {}

  handle(msg: { type?: unknown; serverId?: unknown; snapshot?: unknown; event?: unknown }): SyncOutcome {
    const serverId = typeof msg.serverId === 'string' ? msg.serverId : undefined;
    if (serverId && this.serverId && serverId !== this.serverId) this.state = undefined;
    if (serverId) this.serverId = serverId;
    if (msg.type === 'snapshot') {
      this.state = snapshotFromWire(msg.snapshot);
      return 'ready';
    }
    if (msg.type !== 'event') return 'ignored';
    if (!this.state) return this.resync();
    let out: 'applied' | 'stale' | 'gap';
    try {
      out = applyEvent(this.state, eventFromWire(msg.event));
    } catch {
      return this.resync();
    }
    return out === 'gap' ? this.resync() : out;
  }

  private resync(): SyncOutcome {
    this.resyncRequests++;
    this.requestResync();
    return 'resync';
  }
}

// ---------------------------------------------------------------------------
// Chaves de parâmetros
// ---------------------------------------------------------------------------

export const keys = {
  level: (ch: number, aux?: number) => (aux ? `ch.${ch}.aux.${aux}.level` : `ch.${ch}.main.level`),
  mute: (ch: number, aux?: number) => (aux ? `ch.${ch}.aux.${aux}.mute` : `ch.${ch}.main.mute`),
  master: 'master.level',
};

/** Identificador aleatório que funciona também fora de HTTPS (celular na rede local). */
export function newId(prefix = ''): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return prefix + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Assistente (E4)
// ---------------------------------------------------------------------------

export interface ProposalCard {
  id: string;
  source: 'local' | 'ai' | 'feedback';
  title: string;
  channel: string;
  destination: 'PA' | 'FONES' | 'MASTER' | 'DESFAZER';
  current: string;
  change: string;
  result: string;
  reason?: string;
  needsApproval: boolean;
  expiresAt: string;
}

export interface AssistantReply {
  kind: 'proposals' | 'clarify' | 'answer' | 'error';
  source: 'local' | 'ai' | 'feedback';
  text?: string;
  proposals?: ProposalCard[];
  question?: string;
  options?: Array<{ label: string; text: string }>;
  code?: string;
  ai?: { model: string; inputTokens: number; outputTokens: number; costUSD: number; ms: number };
}

export interface ApplyReply {
  status: 'applied' | 'awaiting_approval' | 'recalculated' | 'expired' | 'not_found' | 'nothing' | 'failed';
  message: string;
  proposal?: ProposalCard;
  askFeedback?: boolean;
}
