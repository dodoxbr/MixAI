import { afterEach, expect, it } from 'vitest';
import { readonlyRealServer } from './support/readonly-real-server.js';
import { wsClient } from './server-support.js';
import { waitFor } from './support/fake-ui-socket.js';
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of close.splice(0).reverse()) await f();
});
it('external MUTE/unmute reaches revisions and existing WS for every registered channel, PA and each AUX, with zero SETD', async () => {
  const s = await readonlyRealServer({ aux2: true });
  close.push(s.close);
  const base = await s.app.listen({ port: 0, host: '127.0.0.1' });
  const client = await wsClient(base, s.token);
  close.push(async () => {
    client.ws.close();
    await client.closed;
  });
  await client.next((m) => m.type === 'snapshot');
  for (const ch of s.loaded.channels.channels)
    for (const aux of [undefined, 1, 2]) {
      const key = aux
        ? `ch.${ch.number}.aux.${aux}.mute`
        : `ch.${ch.number}.main.mute`;
      const path = aux
        ? `i.${ch.number - 1}.aux.${aux - 1}.mute`
        : `i.${ch.number - 1}.mute`;
      for (const value of [true, false, true, false]) {
        s.fake.last().deliver(`SETD^${path}^${Number(value)}`);
        const event = await client.next(
          (m) =>
            m.type === 'event' &&
            m.event.type === 'params' &&
            m.event.changes.some((c: any) => c.key === key),
        );
        expect(
          event.event.changes.find((c: any) => c.key === key).value,
        ).toEqual({ status: 'known', value });
      }
    }
  expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
});
it('unknown stays unknown; repeats do not duplicate revisions; reconnect discards retired events', async () => {
  const s = await readonlyRealServer({ missingMute: true });
  close.push(s.close);
  expect(s.mixer.link()).toBe('READY');
  expect(s.mixer.supervisor.read('ch.1.main.mute')).toEqual({
    known: true,
    value: false,
  });
  expect(s.mixer.read('ch.1.main.mute')).toEqual({ known: false });
  expect(s.mixer.reading('ch.1.main.mute')).toMatchObject({
    state: 'pending',
    reason: 'not_received',
  });
  s.fake.last().deliver('SETD^i.0.mute^1');
  await waitFor(() => s.mixer.link() === 'READY');
  const revision = s.controller.state.snapshot().revision;
  s.fake.last().deliver('SETD^i.0.mute^1');
  expect(s.controller.state.snapshot().revision).toBe(revision);
  const old = s.fake.last(),
    generation = s.mixer.supervisor.generation();
  old.drop();
  expect(s.mixer.read('ch.1.main.mute')).toEqual({ known: false });
  await waitFor(
    () =>
      s.mixer.supervisor.generation() > generation &&
      s.mixer.link() === 'READY',
  );
  old.deliver('SETD^i.0.mute^1');
  expect(s.mixer.read('ch.1.main.mute')).toEqual({ known: false });
  s.fake.last().deliver('SETD^i.0.mute^0');
  expect(s.mixer.read('ch.1.main.mute')).toEqual({ known: true, value: false });
  expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
});
