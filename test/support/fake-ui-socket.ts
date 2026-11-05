import { DBToFaderValue } from 'soundcraft-ui-connection';

/**
 * WebSocket falso que imita a interface web da Ui16, para testes sem rede.
 * Cada `new` registra um socket em `sockets`, permitindo abrir, cair, morrer em silêncio
 * (janela da queda) e entregar mensagens como se viessem da mesa.
 */
export interface FakeUiOptions {
  /** Abre sozinho depois de `openDelayMs` (padrão true). */
  autoOpen?: boolean;
  openDelayMs?: number;
  /** Mensagens (sem o prefixo 3:::) que a "mesa" manda logo depois de abrir. */
  initialState?: () => string[];
}

export interface FakeSocket {
  readonly index: number;
  readonly url: string;
  readyState: number;
  sent: string[];
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  /** Abre manualmente (quando autoOpen=false). */
  open(): void;
  /** A "mesa" manda mensagens SETD (sem 3:::). */
  deliver(...messages: string[]): void;
  /** Queda percebida: dispara onclose. */
  drop(): void;
  /** Queda ainda não percebida: o socket morre, mas onclose não dispara. */
  kill(): void;
  close(): void;
  send(message: string): void;
  /** Comandos que mudam a mesa (SETD, SETS, LOAD..., SAVE...); ignora keepalive e pedidos de listas. */
  commands(): string[];
}

export function createFakeUi(options: FakeUiOptions = {}) {
  const sockets: FakeSocket[] = [];
  const autoOpen = options.autoOpen ?? true;
  const delay = options.openDelayMs ?? 2;

  class Socket implements FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly index: number;
    readyState = 0;
    binaryType = 'blob';
    sent: string[] = [];
    onopen: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;

    constructor(readonly url: string) {
      this.index = sockets.length;
      sockets.push(this);
      if (autoOpen) setTimeout(() => this.open(), delay);
    }
    open() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
      const initial = options.initialState?.() ?? [];
      if (initial.length) setTimeout(() => this.deliver(...initial), 1);
    }
    deliver(...messages: string[]) {
      for (const m of messages) this.onmessage?.({ data: `3:::${m}` });
    }
    drop() {
      if (this.readyState === 3 && !this.onclose) return;
      this.readyState = 3;
      this.onclose?.({ wasClean: false, code: 1006 });
    }
    kill() {
      this.readyState = 3;
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ wasClean: true, code: 1000 });
    }
    send(message: string) {
      if (this.readyState !== 1) throw new Error('send em socket fechado');
      this.sent.push(message);
    }
    commands() {
      return this.sent
        .map((m) => m.replace(/^3:::/, ''))
        .filter((m) => /^(SETD|SETS|LOAD|SAVE)/.test(m));
    }
  }

  return {
    Ctor: Socket as unknown,
    sockets,
    last: () => sockets[sockets.length - 1],
    /** Sockets que ainda não foram fechados/derrubados. */
    alive: () => sockets.filter((s) => s.readyState !== 3),
  };
}

/** Estado completo de canais (nível/mute no master e nos AUX) + master, no protocolo da Ui. */
export function stateMessages(spec: {
  channels: number[];
  aux: number[];
  levelDB?: (ch: number, aux?: number) => number;
  masterDB?: number;
  muted?: (ch: number, aux?: number) => boolean;
}): string[] {
  const lvl = spec.levelDB ?? ((_c: number, a?: number) => (a ? -20 : -10));
  const muted = spec.muted ?? (() => false);
  const out: string[] = [];
  for (const ch of spec.channels) {
    out.push(`SETD^i.${ch - 1}.mix^${DBToFaderValue(lvl(ch))}`);
    out.push(`SETD^i.${ch - 1}.mute^${muted(ch) ? 1 : 0}`);
    for (const a of spec.aux) {
      out.push(`SETD^i.${ch - 1}.aux.${a - 1}.value^${DBToFaderValue(lvl(ch, a))}`);
      out.push(`SETD^i.${ch - 1}.aux.${a - 1}.mute^${muted(ch, a) ? 1 : 0}`);
    }
  }
  out.push(`SETD^m.mix^${DBToFaderValue(spec.masterDB ?? -6)}`);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera uma condição (polling curto), falhando depois de `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000, label = 'condição'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`tempo esgotado esperando ${label}`);
    await sleep(5);
  }
}
