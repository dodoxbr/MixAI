/** WebSocket falso para os testes da interface (sem servidor). */
export class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m['type'] === type);
  }
}

export const SERVER_ID = 'srv-1';

export function hello(role: 'operator' | 'musician' = 'operator', serverId = SERVER_ID) {
  return {
    type: 'hello',
    protocol: 1,
    version: '0.5.0',
    serverId,
    mode: 'lab',
    model: 'ui16',
    link: 'READY',
    musicianAux: 1,
    role,
    meters: { available: true, simulated: true },
  };
}

/** Snapshot no formato de transmissão (E1). */
export function snapshot(revision = 0, serverId = SERVER_ID, overrides: Record<string, unknown> = {}) {
  const params: Record<string, unknown> = {};
  for (let ch = 1; ch <= 3; ch++) {
    params[`ch.${ch}.main.level`] = { value: { status: 'known', value: -10 }, revision: 0 };
    params[`ch.${ch}.main.mute`] = { value: { status: 'known', value: false }, revision: 0 };
    params[`ch.${ch}.aux.1.level`] = { value: { status: 'known', value: -20 }, revision: 0 };
    params[`ch.${ch}.aux.1.mute`] = { value: { status: 'known', value: false }, revision: 0 };
  }
  params['master.level'] = { value: { status: 'known', value: -6 }, revision: 0 };
  Object.assign(params, overrides);
  return { type: 'snapshot', serverId, snapshot: { schemaVersion: 1, mode: 'lab', link: 'READY', available: true, revision, params } };
}

export function levelEvent(from: number, key: string, value: number | '-inf', serverId = SERVER_ID) {
  return {
    type: 'event',
    serverId,
    event: { type: 'params', fromRevision: from, revision: from + 1, changes: [{ key, value: { status: 'known', value }, revision: from + 1, actor: 'mixai' }] },
  };
}

export const NAMES = {
  ok: true,
  code: 'OK',
  message: '',
  data: {
    channels: [
      { number: 1, name: 'Cavaco' },
      { number: 2, name: 'Violão' },
      { number: 3, name: 'Voz Fred' },
    ],
    aux: [{ number: 1, name: 'Fones' }],
  },
};

/** Responde automaticamente ao list_names quando ele for pedido. */
export function answerNames(s: FakeSocket): void {
  // Legacy UI fixtures represent an explicit operator-assigned test musician.
  const identity = s.sent.find(m => (m['command'] as any)?.type === 'musician_identity');
  if (identity) s.receive({ type: 'result', requestId: identity['requestId'], result: { ok: true, code: 'OK', data: { sessionId: 'fixture-session', binding: { schemaVersion: 1, sessionId: 'fixture-session', musicianId: 'fixture', name: 'Músico de teste', channels: [1,2,3], mute: true, revision: 1 } } } });
  const req = [...s.sent].reverse().find(m => (m['command'] as any)?.type === 'list_names');
  if (req && (req['command'] as { type: string }).type === 'list_names') {
    s.receive({ type: 'result', requestId: req['requestId'], result: NAMES });
  }
}
