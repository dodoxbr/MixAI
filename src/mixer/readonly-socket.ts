/** Defesa extra do observador F0C; não muda o transporte dos outros entrypoints. */
import { parseKey, type ParamKey } from '../core/revisions.js';

export type ObserverSocketCtor = new (url: string, protocols?: string | string[]) => {
  readonly readyState?: number;
  send(data: unknown): void;
  close(): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
};

/** Biblioteca 7.1.0: keepalive e consultas automáticas de listas, nunca SET/LOAD/SAVE. */
export function isObserverReadFrame(data: unknown): data is string {
  if (typeof data !== 'string' || data.length > 256) return false;
  if (['3:::ALIVE', '3:::SHOWLIST', '3:::MEDIA_GET_PLISTS'].includes(data)) return true;
  return /^3:::(?:SNAPSHOTLIST|CUELIST|MEDIA_GET_PLIST_TRACKS)\^[^\p{C}\p{Zl}\p{Zp}^]{1,100}$/u.test(data);
}

/** Um bloqueio sela TODA a sessão, inclusive construtores futuros de reconexão. */
export function observerSocketGate(Base: ObserverSocketCtor, onBlocked: () => void, incoming?: { keys: ParamKey[]; onInvalid: (key: ParamKey) => void; beforeReceive?: (data: unknown) => boolean }, route?: { check: () => boolean; onMismatch: () => void }) {
  let sealed = false;
  // Só valida envelopes/campos numéricos selecionados; a biblioteca continua decodificando dB.
  const paths = new Map<string, { key: ParamKey; mute: boolean }>();
  for (const key of incoming?.keys ?? []) {
    const p = parseKey(key);
    if (p.kind === 'master') paths.set('m.mix', { key, mute: false });
    else if (p.kind === 'eq') paths.set(`i.${p.channel - 1}.eq.b${p.band}.${p.param}`, { key, mute: false });
    else if (p.kind === 'hpf' && p.param === 'freq') paths.set(`i.${p.channel - 1}.eq.hpf.freq`, { key, mute: false });
    else if (p.kind === 'eqBypass') paths.set(`i.${p.channel - 1}.eq.bypass`, { key, mute: true });
    else if (p.kind === 'channel') paths.set(`i.${p.channel - 1}.${p.aux ? `aux.${p.aux - 1}.${p.param === 'level' ? 'value' : 'mute'}` : p.param === 'level' ? 'mix' : 'mute'}`, { key, mute: p.param === 'mute' });
  }
  const sockets = new Set<InstanceType<ObserverSocketCtor>>();
  const closeSockets = () => {
    for (const socket of [...sockets]) {
      try { socket.close(); } catch { /* tenta novamente ao selar, sem expor erro */ }
    }
  };
  const Guarded = function (this: unknown, url: string, protocols?: string | string[]) {
    if (sealed) throw new Error('F0C_TRANSPORT_SEALED');
    if (route) {
      let valid = false;
      try { valid = route.check() === true; } catch { /* sem dados da rede */ }
      if (!valid) {
        sealed = true;
        try { route.onMismatch(); } finally { closeSockets(); }
        throw new Error('F0D_ROUTE_MISMATCH');
      }
    }
    const socket = new Base(url, protocols);
    sockets.add(socket);
    const close = socket.close.bind(socket);
    socket.close = () => { close(); sockets.delete(socket); };
    if (incoming) {
      // Conserva os accessors nativos do WebSocket (e suporta o socket falso).
      let proto: object | null = socket;
      let descriptor: PropertyDescriptor | undefined;
      while (proto && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(proto, 'onmessage'); proto = Object.getPrototypeOf(proto); }
      let current: ((event: { data: unknown }) => void) | null = null;
      Object.defineProperty(socket, 'onmessage', {
        configurable: true,
        get: () => descriptor?.get ? descriptor.get.call(socket) : current,
        set: (handler: ((event: { data: unknown }) => void) | null) => {
          const wrapped = handler ? (event: { data: unknown }) => {
            if (sealed || !sockets.has(socket) || socket.readyState !== undefined && socket.readyState !== 1) return;
            if (incoming.beforeReceive && !incoming.beforeReceive(event.data)) { sealed = true; closeSockets(); return; }
            if (typeof event.data === 'string' && event.data.startsWith('3:::')) {
              for (const line of event.data.slice(4).split('\n')) {
                const parts = line.split('^'), selected = paths.get(parts[1] ?? '');
                if (!selected || !['SETD', 'SETS'].includes(parts[0]!)) continue;
                const raw = parts[2] ?? '', n = Number(raw);
                if (parts[0] !== 'SETD' || parts.length !== 3 || raw.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) ||
                  !Number.isFinite(n) || (selected.mute ? n !== 0 && n !== 1 : n < 0 || n > 1)) {
                  sealed = true;
                  try { incoming.onInvalid(selected.key); } finally { closeSockets(); }
                  return;
                }
              }
            }
            handler.call(socket, event);
          } : null;
          current = wrapped;
          if (descriptor?.set) descriptor.set.call(socket, wrapped);
        },
      });
    }
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (sealed) return;
      if (isObserverReadFrame(data)) { send(data); return; }
      sealed = true; // fecha antes de qualquer callback/reentrância
      try { onBlocked(); } finally { socket.close(); }
    };
    return socket;
  } as unknown as ObserverSocketCtor;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    Object.defineProperty(Guarded, key, { value: (Base as unknown as Record<string, unknown>)[key] });
  }
  return { Ctor: Guarded, closeSockets, seal: () => { sealed = true; closeSockets(); } };
}
