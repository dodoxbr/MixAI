import { afterEach, describe, expect, it } from 'vitest';
import { allowedInReadOnlyConsole } from '../src/core/readonly-console.js';
import { ChannelMap } from '../src/core/channels.js';
import { loadConfig } from '../src/core/config.js';
import { createApp } from '../src/core/app.js';
import { parseCommand } from '../src/core/parser.js';
import { paramKey } from '../src/core/revisions.js';
import { RealMixer } from '../src/mixer/real.js';
import { MASTER, auxBus } from '../src/mixer/types.js';
import { createFakeUi, sleep, stateMessages, waitFor } from './support/fake-ui-socket.js';

const keys = [paramKey.master(), paramKey.level(1, MASTER), paramKey.mute(1, MASTER),
  paramKey.level(1, auxBus(1)), paramKey.mute(1, auxBus(1))];
const mixers: RealMixer[] = [];
afterEach(async () => { await Promise.all(mixers.splice(0).map((m) => m.disconnect())); });

function setup(complete = true) {
  const fake = createFakeUi({ initialState: () => complete ? stateMessages({ channels: [1], aux: [1] }) : [] });
  const mixer = new RealMixer({ ip: 'f0.invalid', webSocketCtor: fake.Ctor, readOnly: true,
    requiredKeys: keys, watchedKeys: keys, connectTimeoutMs: 1500, syncTimeoutMs: 50,
    reconnectBaseMs: 10, reconnectMaxDelayMs: 20 });
  mixers.push(mixer);
  return { fake, mixer };
}

async function blocked(mixer: RealMixer) {
  for (const [key, value] of [[keys[0]!, -3], [keys[1]!, -12], [keys[2]!, true],
    [keys[3]!, -15], [keys[4]!, true]] as const) {
    await expect(mixer.write(key, value)).rejects.toThrow('F0_READ_ONLY');
  }
  await expect(mixer.loadSnapshot('show', 'snap')).rejects.toThrow('F0_READ_ONLY');
  expect(() => mixer.supervisor.withReadyUi(() => { throw new Error('executado'); })).toThrow('F0_READ_ONLY');
}

describe('F0 somente leitura, biblioteca real com WebSocket falso (sem rede)', () => {
  it('lê em READY mas bloqueia todos os caminhos de escrita antes/durante/depois de quedas repetidas', async () => {
    const { mixer, fake } = setup();
    await blocked(mixer); // desconectado
    await mixer.connect();
    expect(mixer.statusText()).toContain('F0 SOMENTE LEITURA');
    expect(mixer.read(keys[2]!)).toEqual({ known: true, value: false });
    // Consultas de shows/snapshot não podem liberar nem provocar escrita.
    await Promise.all([mixer.listShows(), mixer.currentSnapshot()]);
    await blocked(mixer);
    for (let cycle = 0; cycle < 3; cycle++) {
      const old = fake.last()!;
      old.drop();
      expect(mixer.link()).toBe('LOST');
      expect(mixer.read(keys[1]!)).toEqual({ known: false });
      await blocked(mixer);
      await waitFor(() => mixer.link() === 'READY');
      old.deliver('SETD^i.0.mute^1'); // evento atrasado não contamina a nova geração
      expect(mixer.read(keys[2]!)).toEqual({ known: true, value: false });
      await blocked(mixer);
    }
    await sleep(2600); // ultrapassa o retry/buffer da biblioteca 7.1.0
    expect(fake.sockets).toHaveLength(4);
    expect(fake.alive()).toHaveLength(1);
    expect(fake.sockets.flatMap((s) => s.commands())).toEqual([]);
    await mixer.disconnect();
    const count = fake.sockets.length;
    await sleep(50);
    expect(fake.sockets).toHaveLength(count);
    expect(fake.alive()).toHaveLength(0);
  }, 8000);

  it('estado parcial vira DEGRADED_READ_ONLY; completar a sincronização não libera escrita F0', async () => {
    const { mixer, fake } = setup(false);
    const connected = mixer.connect();
    await waitFor(() => mixer.link() === 'SYNCING');
    await blocked(mixer);
    fake.last()!.deliver('SETD^i.0.mute^0');
    await connected;
    expect(mixer.link()).toBe('DEGRADED_READ_ONLY');
    expect(mixer.read(keys[1]!)).toEqual({ known: false });
    await blocked(mixer);
    fake.last()!.deliver(...stateMessages({ channels: [1], aux: [1] }));
    await waitFor(() => mixer.link() === 'READY');
    await blocked(mixer);
    expect(fake.sockets.flatMap((s) => s.commands())).toEqual([]);
  });

  it('createApp encaminha a proteção ao RealMixer existente sem abrir socket', async () => {
    const cfg = loadConfig({}, ['node', 'console', '--real']);
    cfg.logDir = null;
    const app = await createApp(cfg, { readOnly: true });
    expect(app.mixer).toBeInstanceOf(RealMixer);
    mixers.push(app.mixer as RealMixer);
    await blocked(app.mixer as RealMixer);
    expect(app.mixer.link()).toBe('DISCONNECTED');
  });
});

const cfg = loadConfig({}, []);
const names = new ChannelMap(cfg.channels, { inputs: 12, aux: 6 });
describe('console F0: lista positiva antes do controlador', () => {
  it.each(['status', 'estado', 'estado @ fones', 'nomes', 'snapshots', 'ajuda', 'sair', ''])('permite %j', (line) => {
    expect(allowedInReadOnlyConsole(parseCommand(line, names))).toBe(true);
  });
  it.each(['sobe cavaco', 'desce cavaco', 'nivel cavaco -12', 'muta cavaco', 'abre cavaco',
    'master -3', 'desfazer', 'carrega show / snap', 'log'])('recusa %j sem aprovação nem fila', (line) => {
    expect(allowedInReadOnlyConsole(parseCommand(line, names))).toBe(false);
  });
});
