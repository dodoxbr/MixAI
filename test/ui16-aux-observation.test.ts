import { afterEach, expect, it } from 'vitest';
import { DBToFaderValue } from 'soundcraft-ui-connection';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels } from '../src/core/config.js';
import { keysFor } from '../src/core/app.js';
import { Ui16RealBridge } from '../src/mixer/ui16-real-bridge.js';
import {
  createFakeUi,
  stateMessages,
  waitFor,
} from './support/fake-ui-socket.js';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});
async function setup() {
  const names = new ChannelMap(
    parseChannels({
      channels: [
        { number: 1, name: 'Cavaco' },
        { number: 2, name: 'Violão' },
      ],
      aux: [{ number: 1, name: 'HA800' }],
    }),
    { inputs: 12, aux: 6 },
    { allowUnmapped: false },
  );
  const keys = keysFor(names);
  const fake = createFakeUi({
    initialState: () => stateMessages({ channels: [1, 2], aux: [1] }),
  });
  const mixer = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: keys.required,
    watchedKeys: keys.watched,
    webSocketCtor: fake.Ctor,
    reconnectBaseMs: 5,
    reconnectMaxDelayMs: 10,
  });
  close.push(() => mixer.disconnect());
  await mixer.connect();
  await waitFor(() => mixer.link() === 'READY');
  return { mixer, fake, names, keys };
}
it('observes six AUX optionally without changing registration, required sync, capabilities or write gates', async () => {
  const s = await setup();
  expect(s.keys.required).toHaveLength(9);
  expect(s.names.aux.configured()).toEqual([1]);
  for (let aux = 1; aux <= 6; aux++)
    for (const channel of [1, 2])
      for (const param of ['level', 'mute'])
        expect(s.keys.watched).toContain(`ch.${channel}.aux.${aux}.${param}`);
  for (let aux = 2; aux <= 6; aux++) {
    expect(s.mixer.read(`ch.1.aux.${aux}.level`)).toEqual({ known: false });
    expect(s.mixer.read(`ch.1.aux.${aux}.mute`)).toEqual({ known: false });
  }
  expect(() => s.names.auxBus(2)).toThrow();
  expect(s.mixer.identity().physicalWrite).toBe('blocked');
  await expect(s.mixer.write('ch.1.aux.6.level', -20)).rejects.toThrow();
  expect(s.fake.last().commands()).toEqual([]);
});
it('external observations are independent by AUX, preserving PA and PA master; no reading is not -inf or false', async () => {
  const s = await setup();
  const pa = s.mixer.read('ch.1.main.level'),
    master = s.mixer.read('master.level');
  for (let aux = 2; aux <= 6; aux++)
    s.fake
      .last()
      .deliver(
        `SETD^i.0.aux.${aux - 1}.value^${DBToFaderValue(-10 - aux)}`,
        `SETD^i.0.aux.${aux - 1}.mute^${aux % 2}`,
      );
  for (let aux = 2; aux <= 6; aux++) {
    expect(s.mixer.read(`ch.1.aux.${aux}.level`)).toEqual({
      known: true,
      value: -10 - aux,
    });
    expect(s.mixer.read(`ch.1.aux.${aux}.mute`)).toEqual({
      known: true,
      value: !!(aux % 2),
    });
  }
  expect(s.mixer.read('ch.2.aux.2.level')).toEqual({ known: false });
  expect(s.mixer.read('ch.1.aux.1.level')).toEqual({ known: true, value: -20 });
  s.fake.last().deliver('SETD^i.0.aux.1.value^0');
  expect(s.mixer.read('ch.1.aux.2.level')).toEqual({
    known: true,
    value: -Infinity,
  });
  expect(s.mixer.read('ch.1.main.level')).toEqual(pa);
  expect(s.mixer.read('master.level')).toEqual(master);
  expect(s.fake.last().commands()).toEqual([]);
});
it('reconnection clears extra AUX samples and never restores a stale value as current', async () => {
  const s = await setup();
  s.fake.last().deliver('SETD^i.0.aux.5.value^0.5', 'SETD^i.0.aux.5.mute^1');
  const generation = s.mixer.supervisor.generation(),
    old = s.fake.last();
  old.drop();
  expect(s.mixer.read('ch.1.aux.6.mute')).toEqual({ known: false });
  await waitFor(
    () =>
      s.mixer.supervisor.generation() > generation &&
      s.mixer.link() === 'READY',
  );
  old.deliver('SETD^i.0.aux.5.mute^1');
  expect(s.mixer.read('ch.1.aux.6.mute')).toEqual({ known: false });
  expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
});
