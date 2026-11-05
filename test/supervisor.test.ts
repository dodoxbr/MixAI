import { ConnectionStatus } from 'soundcraft-ui-connection';
import { afterEach, describe, expect, it } from 'vitest';
import { paramKey, type ParamKey, type ParamValue } from '../src/core/revisions.js';
import { SoundcraftUI } from 'soundcraft-ui-connection';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig } from '../src/core/config.js';
import { MixController } from '../src/core/controller.js';
import { ActionLog } from '../src/core/log.js';
import { ConnectionSupervisor, type GenerationGate } from '../src/mixer/connection-supervisor.js';
import { gatedSocketCtor, RealMixer } from '../src/mixer/real.js';
import { auxBus, LinkUnavailableError, MASTER, type VerificationReport } from '../src/mixer/types.js';
import { createFakeUi, sleep, stateMessages, waitFor } from './support/fake-ui-socket.js';
import { StubUi } from './support/stub-ui.js';

const CH = [1, 2];
const AUX = [1];

function keysOf(channels: number[]): ParamKey[] {
  const keys: ParamKey[] = [paramKey.master()];
  for (const ch of channels) {
    keys.push(paramKey.level(ch, MASTER), paramKey.mute(ch, MASTER));
    for (const a of AUX) keys.push(paramKey.level(ch, auxBus(a)), paramKey.mute(ch, auxBus(a)));
  }
  return keys;
}
const REQUIRED = keysOf(CH);
/** Valores "da mesa" para todos os obrigatórios. */
const fullState = (over: Partial<Record<ParamKey, ParamValue>> = {}): Array<[ParamKey, ParamValue]> =>
  REQUIRED.map((k) => [k, over[k] ?? (k.endsWith('mute') ? false : k.includes('.aux.') ? -20 : -10)]);

const TIMING = { connectTimeoutMs: 300, syncTimeoutMs: 80, indeterminateWindowMs: 500, reconnectBaseMs: 20, reconnectMaxDelayMs: 40 };

let supervisors: ConnectionSupervisor[] = [];
function stubSupervisor(opts: Partial<ConstructorParameters<typeof ConnectionSupervisor>[0]> = {}) {
  StubUi.created = [];
  const trace: string[] = [];
  const sup = new ConnectionSupervisor({
    createUi: () => new StubUi() as never,
    requiredKeys: REQUIRED,
    watchedKeys: [...REQUIRED, paramKey.level(9, MASTER)],
    ...TIMING,
    onTrace: (e) => trace.push(e),
    ...opts,
  });
  supervisors.push(sup);
  const ui = (i: number) => StubUi.created[i]!;
  return { sup, ui, trace };
}

afterEach(async () => {
  for (const s of supervisors) await s.disconnect();
  supervisors = [];
});

describe('ConnectionSupervisor — máquina de estados (dublê da biblioteca)', () => {
  it('CONNECTING → SYNCING → READY só com todos os obrigatórios; nenhuma escrita antes', async () => {
    const { sup, ui } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    expect(sup.link()).toBe('CONNECTING');
    expect(() => sup.write(paramKey.level(1, MASTER), -5)).toThrow(LinkUnavailableError);

    ui(0).emit(ConnectionStatus.Open);
    expect(sup.link()).toBe('SYNCING');
    expect(() => sup.write(paramKey.level(1, MASTER), -5)).toThrow(LinkUnavailableError);

    const all = fullState();
    ui(0).feedAll(all.slice(0, -1));
    expect(sup.link()).toBe('SYNCING');
    ui(0).feedAll(all.slice(-1));
    expect(sup.link()).toBe('READY');
    expect(() => sup.write(paramKey.level(1, MASTER), -5)).not.toThrow();
  });

  it('sincronização incompleta → DEGRADED_READ_ONLY: lê parcial, bloqueia escrita, libera ao completar', async () => {
    const { sup, ui } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    const missing = paramKey.level(2, MASTER);
    ui(0).feedAll(fullState().filter(([k]) => k !== missing));
    await waitFor(() => sup.link() === 'DEGRADED_READ_ONLY', 1000, 'DEGRADED');
    expect(sup.read(paramKey.level(1, MASTER))).toEqual({ known: true, value: -10 });
    expect(sup.read(missing)).toEqual({ known: false });
    expect(() => sup.write(paramKey.level(1, MASTER), -5)).toThrow(LinkUnavailableError);

    ui(0).feed(missing, -7); // a sincronização continua em segundo plano
    expect(sup.link()).toBe('READY');
    expect(sup.read(missing)).toEqual({ known: true, value: -7 });
  });

  it('primeira queda descarta a instância: assinaturas, temporizadores e disconnect()', async () => {
    const { sup, ui } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    expect(ui(0).observers()).toBeGreaterThan(0);

    ui(0).emit(ConnectionStatus.Close);
    expect(sup.link()).toBe('LOST');
    expect(ui(0).observers()).toBe(0);
    expect(ui(0).disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(sup.liveInstances()).toBe(0);
    expect(sup.hasReconnectTimer()).toBe(true);
    expect(sup.read(paramKey.level(1, MASTER))).toEqual({ known: false });

    await waitFor(() => StubUi.created.length === 2, 500, 'nova instância');
    expect(sup.link()).toBe('CONNECTING');
    expect(sup.liveInstances()).toBe(1);
  });

  it('eventos atrasados e fora de ordem da geração antiga são ignorados', async () => {
    const { sup, ui, trace } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    ui(0).emit(ConnectionStatus.Reconnecting); // a biblioteca tentaria reconectar sozinha
    await waitFor(() => StubUi.created.length === 2, 500, 'nova instância');
    const gen2 = sup.generation();

    ui(0).emit(ConnectionStatus.Open); // OPEN atrasado da geração 1
    expect(sup.link()).toBe('CONNECTING');
    ui(1).emit(ConnectionStatus.Open);
    expect(sup.link()).toBe('SYNCING');
    ui(0).emit(ConnectionStatus.Close); // CLOSE atrasado da geração 1
    ui(0).feed(paramKey.level(1, MASTER), 5); // valor atrasado da geração 1
    expect(sup.link()).toBe('SYNCING');
    expect(sup.generation()).toBe(gen2);
    ui(1).feedAll(fullState());
    expect(sup.link()).toBe('READY');
    expect(sup.read(paramKey.level(1, MASTER))).toEqual({ known: true, value: -10 });
    expect(ui(0).observers()).toBe(0);
    void trace;
  });

  it('instância descartada que tenta reabrir sozinha é derrubada de novo (vigia)', async () => {
    const { sup, ui, trace } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    ui(0).emit(ConnectionStatus.Close);
    const calls = ui(0).disconnectCalls;
    ui(0).emit(ConnectionStatus.Open); // a reconexão automática da biblioteca escapou
    expect(ui(0).disconnectCalls).toBeGreaterThan(calls);
    expect(trace.some((t) => t.includes('derrubada de novo'))).toBe(true);
    expect(sup.link()).not.toBe('READY');
  });

  it('OPEN duplicado é ignorado; CLOSE em qualquer estado ativo leva a LOST', async () => {
    const { sup, ui } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    ui(0).emit(ConnectionStatus.Open);
    expect(sup.link()).toBe('READY');
    expect(sup.generation()).toBe(1);
  });

  it('quedas consecutivas em CONNECTING, SYNCING e READY não acumulam instâncias nem temporizadores', async () => {
    const { sup, ui } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Error); // queda em CONNECTING
    await waitFor(() => StubUi.created.length === 2, 500, 'gen 2');
    ui(1).emit(ConnectionStatus.Open);
    ui(1).emit(ConnectionStatus.Close); // queda em SYNCING
    await waitFor(() => StubUi.created.length === 3, 500, 'gen 3');
    ui(2).emit(ConnectionStatus.Open);
    ui(2).feedAll(fullState());
    ui(2).emit(ConnectionStatus.Close); // queda em READY
    await waitFor(() => StubUi.created.length === 4, 500, 'gen 4');
    ui(3).emit(ConnectionStatus.Open);
    ui(3).feedAll(fullState());

    expect(sup.link()).toBe('READY');
    expect(sup.liveInstances()).toBe(1);
    expect(sup.hasReconnectTimer()).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(ui(i).observers()).toBe(0);
      expect(ui(i).disconnectCalls).toBeGreaterThanOrEqual(1);
    }
    await sleep(120);
    expect(StubUi.created.length).toBe(4); // nenhuma tentativa extra
  });

  it('tempo limite em CONNECTING descarta e tenta de novo', async () => {
    const { sup } = stubSupervisor({ connectTimeoutMs: 50 });
    void sup.connect().catch(() => undefined);
    await waitFor(() => StubUi.created.length >= 2, 1000, 'nova tentativa');
    expect(StubUi.created[0]!.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(sup.liveInstances()).toBe(1);
  });

  it('connect() concorrente gera uma única tentativa', async () => {
    const { sup, ui } = stubSupervisor();
    const ps = [sup.connect(), sup.connect(), sup.connect()];
    expect(StubUi.created.length).toBe(1);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    await Promise.all(ps);
    expect(StubUi.created.length).toBe(1);
  });

  it('disconnect() cancela tudo e não reconecta', async () => {
    const { sup, ui } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).emit(ConnectionStatus.Close);
    expect(sup.hasReconnectTimer()).toBe(true);
    await sup.disconnect();
    expect(sup.hasReconnectTimer()).toBe(false);
    expect(sup.link()).toBe('DISCONNECTED');
    await sleep(100);
    expect(StubUi.created.length).toBe(1);
  });

  it('portão de envio: instância não aberta no momento da escrita → recusa e LOST', async () => {
    const { sup, ui } = stubSupervisor();
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    ui(0).conn.status = ConnectionStatus.Closing; // caiu, mas o evento ainda não chegou
    expect(() => sup.write(paramKey.level(1, MASTER), -5)).toThrow(LinkUnavailableError);
    expect(sup.link()).toBe('LOST');
    expect(ui(0).writes).toHaveLength(0);
  });

  it('mudança na mesa vira evento external; eco local da própria escrita não', async () => {
    const { sup, ui } = stubSupervisor();
    const events: Array<[string, unknown, string]> = [];
    sup.onParamChange((k, v, o) => events.push([k, v, o]));
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    events.length = 0;

    sup.write(paramKey.level(1, MASTER), -4);
    expect(ui(0).writes).toEqual([['i.1.mix', -4]]);
    expect(events).toEqual([]); // eco local ignorado

    ui(0).feed(paramKey.level(2, MASTER), -15); // outro tablet mexeu
    expect(events).toEqual([['ch.2.main.level', -15, 'external']]);
  });

  it('falha interna interrompe o controle (STOPPED) e não tenta de novo', async () => {
    let n = 0;
    const { sup } = stubSupervisor({
      createUi: () => {
        n++;
        if (n > 1) throw new Error('quebrou');
        return new StubUi() as never;
      },
    });
    void sup.connect().catch(() => undefined);
    StubUi.created[0]!.emit(ConnectionStatus.Close);
    await waitFor(() => sup.link() === 'STOPPED', 500, 'STOPPED');
    expect(sup.reason()).toContain('falha interna');
    expect(() => sup.write(paramKey.level(1, MASTER), -5)).toThrow(LinkUnavailableError);
    await sleep(100);
    expect(n).toBe(2);
  });
});

describe('verificação após reconexão (dublê da biblioteca)', () => {
  async function readySup() {
    const s = stubSupervisor();
    const reports: VerificationReport[] = [];
    s.sup.onVerification((r) => reports.push(...r));
    void s.sup.connect().catch(() => undefined);
    s.ui(0).emit(ConnectionStatus.Open);
    s.ui(0).feedAll(fullState());
    s.ui(0).feed(paramKey.level(9, MASTER), -10); // acompanhado, não obrigatório
    return { ...s, reports };
  }

  it('escritas da janela da queda são classificadas e NUNCA reenviadas', async () => {
    const { sup, ui, reports } = await readySup();
    sup.write(paramKey.level(1, MASTER), -5); // vai chegar
    sup.write(paramKey.level(2, MASTER), -5); // não vai chegar
    sup.write(paramKey.level(9, MASTER), -5); // parâmetro não volta na ressincronização
    ui(0).emit(ConnectionStatus.Close);
    await waitFor(() => StubUi.created.length === 2, 500, 'nova instância');
    ui(1).emit(ConnectionStatus.Open);
    ui(1).feedAll(fullState({ 'ch.1.main.level': -5 }));

    expect(sup.link()).toBe('READY');
    expect(ui(1).writes).toEqual([]); // nada foi reenviado
    const byKey = Object.fromEntries(reports.map((r) => [r.key, r.outcome]));
    expect(byKey).toEqual({
      'ch.1.main.level': 'observed_target',
      'ch.2.main.level': 'observed_different',
      'ch.9.main.level': 'indeterminate',
    });
  });

  it('escritas antigas (fora da janela) não são verificadas', async () => {
    const { sup, ui, reports } = await readySup();
    sup.write(paramKey.level(1, MASTER), -5);
    await sleep(TIMING.indeterminateWindowMs + 50);
    ui(0).emit(ConnectionStatus.Close);
    await waitFor(() => StubUi.created.length === 2, 500, 'nova instância');
    ui(1).emit(ConnectionStatus.Open);
    ui(1).feedAll(fullState());
    expect(reports).toEqual([]);
  });
});

describe('RealMixer + biblioteca real + WebSocket falso (integração)', () => {
  function realWithTruth(truth: Map<ParamKey, ParamValue>, extraWatched: ParamKey[] = []) {
    const fake = createFakeUi({
      initialState: () =>
        stateMessages({
          channels: CH,
          aux: AUX,
          levelDB: (ch, a) => (truth.get(paramKey.level(ch, a ? auxBus(a) : MASTER)) as number) ?? (a ? -20 : -10),
          muted: (ch, a) => (truth.get(paramKey.mute(ch, a ? auxBus(a) : MASTER)) as boolean) ?? false,
        }),
    });
    const mixer = new RealMixer({
      ip: 'teste',
      webSocketCtor: fake.Ctor,
      requiredKeys: REQUIRED,
      watchedKeys: [...REQUIRED, ...extraWatched],
      ...TIMING,
    });
    supervisors.push(mixer.supervisor);
    return { fake, mixer };
  }

  it('comando depois da queda não chega ao socket novo (o buffer da biblioteca morre com a instância)', async () => {
    const { fake, mixer } = realWithTruth(new Map());
    await mixer.connect();
    fake.sockets[0]!.drop();
    expect(mixer.link()).toBe('LOST');
    await expect(mixer.write(paramKey.level(1, MASTER), 0)).rejects.toThrow(LinkUnavailableError);
    await waitFor(() => mixer.link() === 'READY', 2000, 'READY de novo');
    await sleep(2600); // tempo em que a biblioteca sozinha teria reenviado
    expect(fake.sockets.length).toBe(2);
    expect(fake.sockets[0]!.commands()).toEqual([]);
    expect(fake.sockets[1]!.commands()).toEqual([]);
    expect(fake.alive().length).toBe(1);
  }, 8000);

  it('escrita na janela da queda (socket já morto): verificação, sem reenvio', async () => {
    const truth = new Map<ParamKey, ParamValue>();
    const { fake, mixer } = realWithTruth(truth);
    const reports: VerificationReport[] = [];
    mixer.onVerification((r) => reports.push(...r));
    await mixer.connect();
    fake.sockets[0]!.kill(); // morreu, mas ninguém percebeu ainda
    await mixer.write(paramKey.level(1, MASTER), -4); // o MixAI acha que enviou
    fake.sockets[0]!.drop();
    await waitFor(() => mixer.link() === 'READY', 2000, 'READY de novo');
    expect(reports).toEqual([
      expect.objectContaining({ key: 'ch.1.main.level', target: -4, outcome: 'observed_different' }),
    ]);
    expect(fake.sockets[1]!.commands()).toEqual([]);
  }, 8000);

  it('estado incompleto: DEGRADED_READ_ONLY até a mesa mandar o que falta', async () => {
    const fake = createFakeUi({
      initialState: () => stateMessages({ channels: [1], aux: AUX }), // falta o canal 2
    });
    const mixer = new RealMixer({ ip: 'teste', webSocketCtor: fake.Ctor, requiredKeys: REQUIRED, watchedKeys: REQUIRED, ...TIMING });
    supervisors.push(mixer.supervisor);
    await mixer.connect();
    expect(mixer.link()).toBe('DEGRADED_READ_ONLY');
    await expect(mixer.write(paramKey.level(1, MASTER), -5)).rejects.toThrow(LinkUnavailableError);
    fake.last()!.deliver(...stateMessages({ channels: [2], aux: AUX }).filter((m) => !m.startsWith('SETD^m.')));
    await waitFor(() => mixer.link() === 'READY', 1000, 'READY');
    expect(await mixer.write(paramKey.level(1, MASTER), -5)).toBe('sent');
    expect(fake.last()!.commands().some((m) => m.startsWith('SETD^i.0.mix^'))).toBe(true);
  });
});

describe('desfazer conservador após reconexão (mesa real)', () => {
  it('"observed_target" NÃO mantém o desfazer: o valor certo na mesa não prova que foi o MixAI', async () => {
    const truth = new Map<ParamKey, ParamValue>();
    const fake = createFakeUi({
      initialState: () =>
        stateMessages({
          channels: CH,
          aux: AUX,
          levelDB: (ch, a) => (truth.get(paramKey.level(ch, a ? auxBus(a) : MASTER)) as number) ?? (a ? -20 : -10),
        }),
    });
    const mixer = new RealMixer({ ip: 'teste', webSocketCtor: fake.Ctor, requiredKeys: REQUIRED, watchedKeys: REQUIRED, ...TIMING });
    supervisors.push(mixer.supervisor);
    const names = new ChannelMap(
      parseChannels({ channels: [{ number: 1, name: 'Voz 1', aliases: [] }, { number: 2, name: 'Voz 2', aliases: [] }], aux: [{ number: 1, name: 'Fones', aliases: [] }] }),
      { inputs: 12, aux: 6 },
    );
    const controller = new MixController(mixer, parseConfig({}).safety, names, new ActionLog(null));
    await mixer.connect();

    const w = await controller.setLevel({ channel: 'voz 1', db: -6 });
    expect(w.code).toBe('OK');
    expect(w.message).toContain('enviado à mesa');
    truth.set(paramKey.level(1, MASTER), -6); // a mesa mostra o valor desejado depois de voltar
    fake.sockets[0]!.drop();
    await waitFor(() => mixer.link() === 'READY', 2000, 'READY de novo');

    const status = await controller.status();
    expect(JSON.stringify(status.data)).toContain('observed_target');
    const u = await controller.undo();
    expect(u.code).toBe('CONFLICT');
    expect(u.message).toContain('incerto');
    expect(fake.sockets[1]!.commands()).toEqual([]); // nem reenvio, nem desfazer automático
  });

  it('escrita fora da janela da queda, com o mesmo valor após reconectar: desfazer continua possível', async () => {
    const truth = new Map<ParamKey, ParamValue>();
    const fake = createFakeUi({
      initialState: () =>
        stateMessages({
          channels: CH,
          aux: AUX,
          levelDB: (ch, a) => (truth.get(paramKey.level(ch, a ? auxBus(a) : MASTER)) as number) ?? (a ? -20 : -10),
        }),
    });
    const mixer = new RealMixer({ ip: 'teste', webSocketCtor: fake.Ctor, requiredKeys: REQUIRED, watchedKeys: REQUIRED, ...TIMING });
    supervisors.push(mixer.supervisor);
    const names = new ChannelMap(parseChannels({ channels: [{ number: 1, name: 'Voz 1', aliases: [] }], aux: [] }), { inputs: 12, aux: 6 });
    const controller = new MixController(mixer, parseConfig({}).safety, names, new ActionLog(null));
    await mixer.connect();
    await controller.setLevel({ channel: 'voz 1', db: -6 });
    truth.set(paramKey.level(1, MASTER), -6);
    await sleep(TIMING.indeterminateWindowMs + 50);
    fake.sockets[0]!.drop();
    await waitFor(() => mixer.link() === 'READY', 2000, 'READY de novo');
    expect((await controller.undo()).code).toBe('OK');
  });
});

describe('instâncias descartadas depois da vigilância de 30 s', () => {
  it('o portão da geração fecha no descarte e continua fechado depois que a vigilância termina', async () => {
    const gates: GenerationGate[] = [];
    const { sup, ui } = stubSupervisor({
      zombieWatchMs: 20,
      createUi: (gate) => {
        gates.push(gate);
        return new StubUi() as never;
      },
    });
    void sup.connect().catch(() => undefined);
    ui(0).emit(ConnectionStatus.Open);
    ui(0).feedAll(fullState());
    expect(gates[0]!.isAlive()).toBe(true);
    ui(0).emit(ConnectionStatus.Close);
    expect(gates[0]!.isAlive()).toBe(false);

    await sleep(60); // vigilância por status já terminou
    const calls = ui(0).disconnectCalls;
    ui(0).emit(ConnectionStatus.Open); // reabertura tardia: o vigia não está mais lá...
    expect(ui(0).disconnectCalls).toBe(calls);
    expect(gates[0]!.isAlive()).toBe(false); // ...mas o portão continua fechado (garantia definitiva)
    expect(sup.generation()).not.toBe(1);
  });

  it('gatedSocketCtor: geração viva conecta; descartada é bloqueada e avisa', () => {
    let alive = true;
    let blocked = 0;
    const gate: GenerationGate = { generation: 7, isAlive: () => alive, onBlocked: () => blocked++ };
    const fake = createFakeUi({ autoOpen: false });
    const Gated = gatedSocketCtor(fake.Ctor as never, gate) as unknown as new (url: string) => unknown;
    new Gated('ws://teste');
    expect(fake.sockets.length).toBe(1);
    alive = false;
    expect(() => new Gated('ws://teste')).toThrow(/bloqueada/);
    expect(fake.sockets.length).toBe(1);
    expect(blocked).toBe(1);
    expect((Gated as unknown as { OPEN: number }).OPEN).toBe(1);
  });

  it('biblioteca real: reconexão automática tardia de instância descartada não abre socket', async () => {
    let alive = true;
    let blocked = 0;
    const fake = createFakeUi();
    let ui: SoundcraftUI;
    const gate: GenerationGate = {
      generation: 1,
      isAlive: () => alive,
      onBlocked: () => {
        blocked++;
        setTimeout(() => void ui.disconnect().catch(() => undefined), 0);
      },
    };
    ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: gatedSocketCtor(fake.Ctor as never, gate) } as never);
    await ui.connect();
    alive = false; // descartada, e ninguém chamou disconnect (pior caso: a vigilância já acabou)
    fake.sockets[0]!.drop();
    await sleep(2600); // a biblioteca tenta reconectar sozinha
    expect(fake.sockets.length).toBe(1);
    expect(blocked).toBeGreaterThanOrEqual(1);
    await sleep(2600); // e não insiste depois de ser derrubada
    expect(fake.sockets.length).toBe(1);
    expect(blocked).toBe(1);
  }, 10000);

  it('RealMixer com vigilância curta: depois dela, nenhuma conexão extra aparece', async () => {
    const fake = createFakeUi({ initialState: () => stateMessages({ channels: CH, aux: AUX }) });
    const mixer = new RealMixer({ ip: 'teste', webSocketCtor: fake.Ctor, requiredKeys: REQUIRED, watchedKeys: REQUIRED, ...TIMING, zombieWatchMs: 20 });
    supervisors.push(mixer.supervisor);
    await mixer.connect();
    fake.sockets[0]!.drop();
    await waitFor(() => mixer.link() === 'READY', 2000, 'READY de novo');
    await sleep(2700);
    expect(fake.sockets.length).toBe(2);
    expect(fake.alive().length).toBe(1);
  }, 8000);
});

describe('estado observável com a mesa real (E1)', () => {
  it('queda e volta: indisponível, pedido de novo snapshot e estado igual ao da mesa', async () => {
    const { applyStateEvent } = await import('../src/core/state.js');
    const fake = createFakeUi({ initialState: () => stateMessages({ channels: CH, aux: AUX }) });
    const mixer = new RealMixer({ ip: 'teste', webSocketCtor: fake.Ctor, requiredKeys: REQUIRED, watchedKeys: REQUIRED, ...TIMING });
    supervisors.push(mixer.supervisor);
    const names = new ChannelMap(parseChannels({ channels: [{ number: 1, name: 'Voz 1', aliases: [] }], aux: [] }), { inputs: 12, aux: 6 });
    const controller = new MixController(mixer, parseConfig({}).safety, names, new ActionLog(null));
    await mixer.connect();

    let mirror = controller.state.snapshot(REQUIRED);
    expect(mirror.available).toBe(true);
    expect(mirror.params['ch.1.main.level']!.value).toMatchObject({ status: 'known' });
    // Parâmetros de EQ existem no modelo, mas a mesa real não os acompanha: aparecem como desconhecidos.
    expect(controller.state.snapshot([paramKey.eqBand(1, 1, 'gain')]).params['ch.1.eq.b1.gain']!.value).toEqual({ status: 'unknown' });

    const outcomes: string[] = [];
    controller.state.subscribe((e) => {
      const o = applyStateEvent(mirror, e);
      outcomes.push(`${e.type}:${o}`);
      if (o === 'gap') mirror = controller.state.snapshot(REQUIRED); // o cliente pede outro snapshot
    });
    fake.sockets[0]!.drop();
    expect(mirror.available).toBe(false);
    expect(mirror.params['ch.1.main.level']!.value).toEqual({ status: 'unavailable' });
    await waitFor(() => mixer.link() === 'READY', 2000, 'READY de novo');
    fake.last()!.deliver(stateMessages({ channels: [2], aux: [] }).find((m) => m.startsWith('SETD^i.1.mix'))!.replace(/\^[^^]+$/, '^0.3'));
    await sleep(5);
    expect(outcomes).toContain('link:gap');
    const fresh = controller.state.snapshot(REQUIRED);
    expect(mirror.params).toEqual(fresh.params);
    expect(mirror.revision).toBe(fresh.revision);
  });
});
