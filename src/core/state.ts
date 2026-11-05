import type { ParamRegistry } from './params.js';
import { asParamKey, type Actor, type ParamKey, type ParamValue, type RevisionTracker } from './revisions.js';
import type { LinkState, MixerAdapter } from '../mixer/types.js';

/**
 * Três situações que NUNCA se confundem:
 * - known: valor conhecido (nível pode ser -Infinity = fader todo para baixo);
 * - unknown: a mesa está acessível, mas este valor ainda não chegou;
 * - unavailable: não há ligação legível com a mesa (sem conexão, sincronizando, parada).
 */
export type StateValue = { status: 'known'; value: ParamValue } | { status: 'unknown' } | { status: 'unavailable' };

/** Valor em JSON: -∞ vira "-inf" (JSON não tem Infinity); desconhecido vira null. */
export type EncodedValue = number | boolean | '-inf' | null;

export function encodeValue(v: ParamValue): Exclude<EncodedValue, null> {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    if (v === -Infinity) return '-inf';
    throw new Error(`valor não representável: ${v}`);
  }
  return v;
}

/** Inverso de encodeValue. Devolve undefined para null ou valor inválido. */
export function decodeValue(e: unknown): ParamValue | undefined {
  if (e === '-inf') return -Infinity;
  if (typeof e === 'boolean') return e;
  if (typeof e === 'number' && Number.isFinite(e)) return e;
  return undefined;
}

export interface ParamState {
  value: StateValue;
  /** Revisão da última mudança conhecida (0 = nenhuma desde o início do processo). */
  revision: number;
  actor?: Actor;
}

export interface MixerStateSnapshot {
  schemaVersion: 1;
  mode: 'mock' | 'lab' | 'real';
  link: LinkState;
  /** false = leitura indisponível; todos os parâmetros aparecem como `unavailable`. */
  available: boolean;
  /** Revisão global no momento do snapshot. Eventos com revision <= esta já estão incluídos. */
  revision: number;
  params: Record<string, ParamState>;
}

export interface ParamChange {
  key: ParamKey;
  value: StateValue;
  revision: number;
  actor?: Actor;
}

export type StateEvent =
  | { type: 'params'; fromRevision: number; revision: number; changes: ParamChange[] }
  | { type: 'link'; revision: number; link: LinkState; available: boolean };

export const isReadable = (link: LinkState) => link === 'READY' || link === 'DEGRADED_READ_ONLY';

/**
 * Estado observável do MixAI: valores (lidos do adaptador), revisões (do RevisionTracker da E0)
 * e eventos. Um cliente pega um snapshot e aplica os eventos seguintes; se perceber um buraco
 * (fromRevision diferente da sua revisão), pede outro snapshot.
 */
export class StateHub {
  private listeners = new Set<(ev: StateEvent) => void>();
  private dirty = new Set<ParamKey>();
  private emitted: number;

  constructor(
    private mixer: MixerAdapter,
    private tracker: RevisionTracker,
    private registry: ParamRegistry,
  ) {
    this.emitted = tracker.current();
    tracker.onBump((key) => this.dirty.add(key));
    mixer.onLinkChange((link) => {
      this.flush();
      this.emit({ type: 'link', revision: this.tracker.current(), link, available: isReadable(link) });
    });
  }

  readValue(key: ParamKey): StateValue {
    if (!isReadable(this.mixer.link())) return { status: 'unavailable' };
    const r = this.mixer.read(key);
    return r.known ? { status: 'known', value: r.value } : { status: 'unknown' };
  }

  snapshot(keys: ParamKey[] = this.registry.keys()): MixerStateSnapshot {
    this.flush();
    const link = this.mixer.link();
    const params: Record<string, ParamState> = {};
    for (const key of keys) {
      params[key] = { value: this.readValue(key), revision: this.tracker.revisionOf(key), actor: this.tracker.actorOf(key) };
    }
    return {
      schemaVersion: 1,
      mode: this.mixer.mode,
      link,
      available: isReadable(link),
      revision: this.tracker.current(),
      params,
    };
  }

  subscribe(listener: (ev: StateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emite um evento com todos os parâmetros que mudaram de revisão desde o último. */
  flush(): void {
    if (!this.dirty.size) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    const changes = keys.map((key) => ({
      key,
      value: this.readValue(key),
      revision: this.tracker.revisionOf(key),
      actor: this.tracker.actorOf(key),
    }));
    const ev: StateEvent = { type: 'params', fromRevision: this.emitted, revision: this.tracker.current(), changes };
    this.emitted = ev.revision;
    this.emit(ev);
  }

  private emit(ev: StateEvent) {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* um assinante com erro não derruba os outros nem o controle da mesa */
      }
    }
  }
}

export type ApplyOutcome = 'applied' | 'stale' | 'gap';

/**
 * Aplica um evento a uma cópia local (o que um cliente faria).
 * - stale: o evento já está incluído (ignorar);
 * - gap: faltou algum evento, ou a leitura voltou depois de indisponível → pedir novo snapshot.
 */
export function applyStateEvent(mirror: MixerStateSnapshot, ev: StateEvent): ApplyOutcome {
  if (ev.type === 'link') {
    const wasAvailable = mirror.available;
    mirror.link = ev.link;
    mirror.available = ev.available;
    if (!ev.available) {
      for (const p of Object.values(mirror.params)) p.value = { status: 'unavailable' };
      return 'applied';
    }
    return wasAvailable ? 'applied' : 'gap';
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

// ---------------------------------------------------------------------------
// Formato de transmissão (JSON) para snapshots E eventos.
// JSON.stringify(-Infinity) vira null, o que confundiria -∞ com "desconhecido".
// Por isso nada sai do servidor sem passar por aqui: -∞ vira "-inf", e cada valor leva
// o seu status explícito ("known" | "unknown" | "unavailable").
// ---------------------------------------------------------------------------

export type WireStateValue =
  | { status: 'known'; value: number | boolean | '-inf' }
  | { status: 'unknown' }
  | { status: 'unavailable' };

export interface WireParamState {
  value: WireStateValue;
  revision: number;
  actor?: Actor;
}

export interface WireSnapshot extends Omit<MixerStateSnapshot, 'params'> {
  params: Record<string, WireParamState>;
}

export type WireEvent =
  | { type: 'params'; fromRevision: number; revision: number; changes: Array<{ key: string; value: WireStateValue; revision: number; actor?: Actor }> }
  | { type: 'link'; revision: number; link: LinkState; available: boolean };

export function encodeStateValue(v: StateValue): WireStateValue {
  return v.status === 'known' ? { status: 'known', value: encodeValue(v.value) } : { status: v.status };
}

/** Lança erro se o valor recebido não for válido (nunca devolve um valor "adivinhado"). */
export function decodeStateValue(w: unknown): StateValue {
  const o = w as { status?: unknown; value?: unknown } | null;
  if (o && o.status === 'unknown') return { status: 'unknown' };
  if (o && o.status === 'unavailable') return { status: 'unavailable' };
  if (o && o.status === 'known') {
    const value = decodeValue(o.value);
    if (value === undefined) throw new Error(`valor conhecido inválido na transmissão: ${JSON.stringify(o.value)}`);
    return { status: 'known', value };
  }
  throw new Error(`status inválido na transmissão: ${JSON.stringify(w)}`);
}

export function snapshotToWire(s: MixerStateSnapshot): WireSnapshot {
  return {
    ...s,
    params: Object.fromEntries(Object.entries(s.params).map(([k, p]) => [k, { ...p, value: encodeStateValue(p.value) }])),
  };
}

export function snapshotFromWire(w: WireSnapshot): MixerStateSnapshot {
  return {
    ...w,
    params: Object.fromEntries(Object.entries(w.params).map(([k, p]) => [k, { ...p, value: decodeStateValue(p.value) }])),
  };
}

export function eventToWire(ev: StateEvent): WireEvent {
  if (ev.type === 'link') return { ...ev };
  return { ...ev, changes: ev.changes.map((c) => ({ ...c, value: encodeStateValue(c.value) })) };
}

export function eventFromWire(w: WireEvent): StateEvent {
  if (w.type === 'link') return { ...w };
  if (w.type !== 'params') throw new Error(`tipo de evento inválido: ${JSON.stringify((w as { type?: unknown }).type)}`);
  return {
    ...w,
    changes: w.changes.map((c) => {
      const key = asParamKey(c.key);
      if (!key) throw new Error(`chave inválida na transmissão: ${c.key}`);
      return { ...c, key, value: decodeStateValue(c.value) };
    }),
  };
}

/** Texto JSON pronto para enviar (snapshot ou evento). */
export const serializeSnapshot = (s: MixerStateSnapshot) => JSON.stringify(snapshotToWire(s));
export const serializeEvent = (ev: StateEvent) => JSON.stringify(eventToWire(ev));
export const parseSnapshot = (text: string) => snapshotFromWire(JSON.parse(text) as WireSnapshot);
export const parseEvent = (text: string) => eventFromWire(JSON.parse(text) as WireEvent);
