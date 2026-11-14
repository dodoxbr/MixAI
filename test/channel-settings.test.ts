import { afterEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels } from '../src/core/config.js';
import { readonlyRealServer } from './support/readonly-real-server.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const payload = (s: Awaited<ReturnType<typeof readonlyRealServer>>) => ({
  serverId: s.core.serverId,
  ...s.settings.snapshot(),
});
const input = (s: Awaited<ReturnType<typeof readonlyRealServer>>) => {
  const snap = s.settings.snapshot();
  return {
    serverId: s.core.serverId,
    revision: snap.revision,
    channels: snap.channels,
    aux: snap.aux,
  };
};
it('persists the same channels.yaml, preserves comments/metadata/IDs and updates the existing resolver and references immediately', async () => {
  const s = await readonlyRealServer();
  cleanup.push(s.close);
  const file = join(s.loaded.configDir, 'channels.yaml');
  const doc = parse(readFileSync(file, 'utf8'));
  doc.note = 'must survive';
  doc.channels[0].privateMetadata = { keep: true };
  writeFileSync(file, '# keep comment\n' + stringify(doc));
  const data = input(s);
  data.channels[0]!.name = 'Cavaco principal';
  data.channels[0]!.aliases = ['cordas agudas'];
  data.aux[0]!.name = 'Retorno coletivo';
  s.settings.save(data);
  expect(s.controller.names.channel('cordas agudas')).toMatchObject({
    number: 1,
    name: 'Cavaco principal',
  });
  expect(() => s.controller.names.channel('cavaquinho')).toThrow();
  expect(s.loaded.channels.channels[0]!.name).toBe('Cavaco principal');
  const raw = readFileSync(file, 'utf8');
  expect(raw).toContain('# keep comment');
  expect(parse(raw).note).toBe('must survive');
  expect(parse(raw).channels[0].privateMetadata).toEqual({ keep: true });
  const restarted = new ChannelMap(
    parseChannels(parse(raw)),
    s.mixer.capabilities(),
    { allowUnmapped: false },
  );
  expect(restarted.channel('cordas agudas').number).toBe(1);
  expect(restarted.auxBus('Retorno coletivo').number).toBe(1);
  expect(
    readdirSync(join(s.loaded.dataDir!, 'channel-config-backups')),
  ).toHaveLength(1);
  expect(s.fake.last().commands()).toEqual([]);
});
it('rejects duplicate normalized names, prefix/phrase ambiguities, reserved numbers and physical reassignment without changing disk', async () => {
  const s = await readonlyRealServer();
  cleanup.push(s.close);
  const before = readFileSync(s.settings.file, 'utf8');
  for (const mutate of [
    (d: ReturnType<typeof input>) => (d.channels[1]!.name = 'Cávaco'),
    (d: ReturnType<typeof input>) => (d.channels[0]!.aliases = ['CH 2']),
    (d: ReturnType<typeof input>) => (d.channels[0]!.aliases = ['voz']),
    (d: ReturnType<typeof input>) => (d.channels[0]!.name = 'Cavaco Lucius'),
    (d: ReturnType<typeof input>) => (d.channels[0]!.number = 12),
    (d: ReturnType<typeof input>) => d.channels.pop(),
    (d: ReturnType<typeof input>) => (d.channels[0]!.name = 'master'),
  ]) {
    const data = input(s);
    mutate(data);
    expect(() => s.settings.save(data)).toThrow();
    expect(readFileSync(s.settings.file, 'utf8')).toBe(before);
  }
  expect(s.fake.last().commands()).toEqual([]);
});
it('CAS preserves external/concurrent edits and expired session cannot commit', async () => {
  const s = await readonlyRealServer();
  cleanup.push(s.close);
  const first = input(s),
    second = input(s);
  first.channels[0]!.name = 'Primeiro nome';
  s.settings.save(first);
  second.channels[0]!.name = 'Nome atrasado';
  expect(() => s.settings.save(second)).toThrow('arquivo mudou');
  const current = readFileSync(s.settings.file, 'utf8');
  let checked = 0;
  const fresh = input(s);
  fresh.channels[0]!.name = 'Não autorizado';
  expect(() => s.settings.save(fresh, () => ++checked === 1)).toThrow(
    'Sessão encerrada',
  );
  expect(readFileSync(s.settings.file, 'utf8')).toBe(current);
  expect(s.controller.names.inputs.list()[0]!.name).toBe('Primeiro nome');
  expect(s.fake.last().commands()).toEqual([]);
});
it('reports received hardware names separately and never imports or writes them', async () => {
  const s = await readonlyRealServer();
  cleanup.push(s.close);
  const snapshot = s.settings.snapshot();
  expect(snapshot.mixerNames[0]).toMatchObject({
    number: 1,
    name: 'Mesa CH1',
    source: 'device_reported',
  });
  expect(snapshot.channels[0]!.name).toBe('Cavaco');
  s.fake.last().drop();
  expect(s.settings.snapshot().mixerNames[0]!.name).toBeNull();
  expect(s.fake.sockets.flatMap((x) => x.commands())).toEqual([]);
});
it('HTTP requires existing operator auth, same origin, revision and server identity', async () => {
  const s = await readonlyRealServer();
  cleanup.push(s.close);
  const path = '/api/settings/channels',
    headers = { authorization: 'Bearer ' + s.token };
  expect((await s.app.inject({ url: path })).statusCode).toBe(401);
  const musician = s.core.auth.login('1357', 'fixture');
  if (!musician.ok) throw Error('fixture');
  expect(
    (
      await s.app.inject({
        url: path,
        headers: { authorization: 'Bearer ' + musician.token },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await s.app.inject({
        url: path,
        headers: { ...headers, origin: 'https://foreign.invalid' },
      })
    ).statusCode,
  ).toBe(403);
  const get = await s.app.inject({ url: path, headers });
  expect(get.statusCode).toBe(200);
  const data = input(s);
  data.channels[0]!.name = 'Novo cavaco';
  const saved = await s.app.inject({
    method: 'PUT',
    url: path,
    headers,
    payload: data,
  });
  expect(saved.statusCode).toBe(200);
  expect(
    (await s.app.inject({ method: 'PUT', url: path, headers, payload: data }))
      .statusCode,
  ).toBe(409);
  expect(s.controller.names.channel('Novo cavaco').number).toBe(1);
  expect(s.fake.last().commands()).toEqual([]);
});
