import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateSync } from '../src/client/state-sync.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseConfig, type LoadedConfig, type SafetyConfig } from '../src/core/config.js';
import { MixController } from '../src/core/controller.js';
import { ActionLog } from '../src/core/log.js';
import { LabMixer } from '../src/mixer/lab.js';
import { MockMixer } from '../src/mixer/mock.js';
import { hashPin } from '../src/server/pin.js';
import { startServer } from '../src/server/start.js';
import { fixtureChannels } from './helpers.js';

export const OPERATOR_PIN = '4321';
export const MUSICIAN_PIN = '1357';
let hashes: { operatorPinHash: string; musicianPinHash: string } | undefined;
const pinHashes = () => (hashes ??= { operatorPinHash: hashPin(OPERATOR_PIN), musicianPinHash: hashPin(MUSICIAN_PIN) });

export interface TestServerOptions {
  mode?: 'lab' | 'mock';
  safety?: Partial<SafetyConfig>;
  dir?: string;
  port?: number;
  logDir?: string | null;
  /** IA (E4): configuração, chave de teste e fetch simulado (nunca a API real). */
  ai?: Record<string, unknown>;
  aiKey?: string;
  aiFetch?: typeof fetch;
  /** Nomes dos canais (padrão: a fixture dos testes). */
  channels?: ReturnType<typeof fixtureChannels>;
  /** Campos da seção server do config (ex.: musicianAccess). */
  server?: Record<string, unknown>;
}

/** Relógio real com deslocamento: dá para "pular" o tempo sem travar a rede. */
export function shiftableClock() {
  let offset = 0;
  return { now: () => Date.now() + offset, advance: (ms: number) => (offset += ms) };
}

export async function startTestServer(opts: TestServerOptions = {}) {
  const mode = opts.mode ?? 'lab';
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'mixai-srv-'));
  const loaded: LoadedConfig = {
    config: parseConfig({
      mixer: { mode },
      lab: { saveDebounceMs: 0 },
      logs: { dir: null },
      safety: { maxActionsPerSecond: 100, ...opts.safety },
      ai: opts.ai ?? {},
      server: opts.server ?? {},
    }),
    channels: opts.channels ?? fixtureChannels(),
    configDir: dir,
    logDir: opts.logDir ?? null,
    labFile: join(dir, 'lab-state.json'),
    dataDir: dir,
    secrets: { ...pinHashes(), anthropicApiKey: opts.aiKey },
  };
  const clock = shiftableClock();
  const log = new ActionLog(opts.logDir ?? null);
  const caps = { model: 'ui16' as const, inputs: 12, aux: 6 };
  const mixer = mode === 'lab' ? new LabMixer({ file: loaded.labFile, saveDebounceMs: 0 }) : new MockMixer(caps);
  const controller = new MixController(mixer, loaded.config.safety, new ChannelMap(loaded.channels, caps), log, clock.now);
  const aiFetch: typeof fetch =
    opts.aiFetch ??
    (async () => {
      throw new Error('teste tentou chamar a API real da Anthropic');
    });
  const server = await startServer(loaded, { port: opts.port ?? 0, clock: clock.now, app: { loaded, mixer, controller, log }, aiFetch });
  const base = server.urls[0]!;

  const http = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const login = async (pin: string) => {
    const r = await http('/api/login', { body: { pin } });
    if (r.status !== 200) throw new Error(`login falhou: ${JSON.stringify(r.json)}`);
    return r.json.token as string;
  };
  let seq = 0;
  const command = (token: string, command: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    http('/api/command', { token, body: { requestId: `t-${++seq}`, command, ...extra } });

  return { server, base, dir, loaded, clock, mixer, controller, http, login, command };
}

type Msg = Record<string, any>;

/** Cliente WebSocket de teste (WebSocket nativo do Node 22) com caixa de entrada. */
export async function wsClient(base: string, token: string | undefined, opts: { sync?: boolean } = {}) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const inbox: Msg[] = [];
  const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  let drop: ((m: Msg) => boolean) | undefined;
  const sync = new StateSync(() => ws.send(JSON.stringify({ type: 'resync' })));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as Msg;
    if (drop?.(m)) {
      drop = undefined; // perde UMA mensagem (simula evento perdido)
      return;
    }
    if (opts.sync !== false) sync.handle(m);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws não abriu')), { once: true });
  });
  if (token !== undefined) ws.send(JSON.stringify({ type: 'auth', token }));
  const next = (pred: (m: Msg) => boolean, timeoutMs = 3000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]!);
    return new Promise<Msg>((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const k = waiters.indexOf(w);
        if (k >= 0) {
          waiters.splice(k, 1);
          reject(new Error(`timeout esperando mensagem; recebidas: ${JSON.stringify(inbox.map((m) => m.type))}`));
        }
      }, timeoutMs);
    });
  };
  const send = (m: Msg) => ws.send(JSON.stringify(m));
  let req = 0;
  const request = async (m: Msg) => {
    const requestId = m.requestId ?? `ws-${++req}-${Math.random().toString(36).slice(2, 8)}`;
    send({ ...m, requestId });
    return next((x) => x.type === 'result' && x.requestId === requestId);
  };
  return {
    ws,
    inbox,
    sync,
    next,
    send,
    request,
    closed,
    dropNext: (pred: (m: Msg) => boolean) => (drop = pred),
    close: () => ws.close(),
  };
}

export const isEvent = (m: Msg) => m.type === 'event';
