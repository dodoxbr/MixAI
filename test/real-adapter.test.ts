import { describe, expect, it } from 'vitest';
import { paramKey } from '../src/core/revisions.js';
import { RealMixer } from '../src/mixer/real.js';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { createFakeUi, stateMessages } from './support/fake-ui-socket.js';

/**
 * Adaptador da mesa real com WebSocket falso. Mudança da E0 (documentada no escopo §11.2):
 * o socket falso agora manda o estado completo, porque o supervisor só libera escrita em READY.
 * As asserções sobre o protocolo enviado continuam as mesmas da v0.1.
 */
const CHANNELS = [1, 2, 4, 6];
const AUX = [2];

function keys() {
  const required = [paramKey.master()];
  for (const ch of CHANNELS) {
    required.push(paramKey.level(ch, MASTER), paramKey.mute(ch, MASTER));
    for (const a of AUX) required.push(paramKey.level(ch, auxBus(a)), paramKey.mute(ch, auxBus(a)));
  }
  return required;
}

describe('adaptador da mesa real (com WebSocket falso)', () => {
  it('conecta, lê o estado e envia comandos no protocolo da Ui', async () => {
    const fake = createFakeUi({
      initialState: () => stateMessages({ channels: CHANNELS, aux: AUX, muted: (ch, a) => ch === 4 && !a }),
    });
    const mixer = new RealMixer({
      ip: '10.10.1.1',
      webSocketCtor: fake.Ctor,
      connectTimeoutMs: 5000,
      requiredKeys: keys(),
      watchedKeys: keys(),
    });
    await mixer.connect();
    expect(mixer.link()).toBe('READY');
    expect(fake.last()!.url).toContain('10.10.1.1');

    const level = mixer.read(paramKey.level(1, MASTER));
    expect(level.known && Number.isFinite(level.value as number)).toBe(true);
    expect(mixer.read(paramKey.mute(1, MASTER))).toEqual({ known: true, value: false });
    expect(mixer.read(paramKey.mute(4, MASTER))).toEqual({ known: true, value: true });
    const aux = mixer.read(paramKey.level(1, auxBus(2)));
    expect(aux.known && Number.isFinite(aux.value as number)).toBe(true);

    const ws = fake.last()!;
    ws.sent = [];
    expect(await mixer.write(paramKey.level(2, MASTER), -6)).toBe('sent');
    await mixer.write(paramKey.mute(6, MASTER), true);
    await mixer.write(paramKey.level(1, auxBus(2)), -12);
    await mixer.write(paramKey.master(), -3);
    await mixer.loadSnapshot('Pagode', 'Bar');
    const sent = ws.commands().join('\n');
    // Canais começam em 0 no protocolo: canal 2 = i.1, canal 6 = i.5, AUX 2 = aux.1
    expect(sent).toMatch(/SETD\^i\.1\.mix\^/);
    expect(sent).toMatch(/SETD\^i\.5\.mute\^1/);
    expect(sent).toMatch(/SETD\^i\.0\.aux\.1\.value\^/);
    expect(sent).toMatch(/SETD\^m\.mix\^/);
    expect(sent).toMatch(/Pagode/);

    await mixer.disconnect();
    expect(mixer.link()).toBe('DISCONNECTED');
  });

  it('IP errado: falha com mensagem clara depois do tempo limite', async () => {
    const fake = createFakeUi({ autoOpen: false });
    const mixer = new RealMixer({
      ip: '10.0.0.99',
      webSocketCtor: fake.Ctor,
      connectTimeoutMs: 300,
      reconnectBaseMs: 10_000,
      requiredKeys: keys(),
      watchedKeys: keys(),
    });
    await expect(mixer.connect()).rejects.toThrow(/10\.0\.0\.99/);
    expect(mixer.link()).not.toBe('READY');
    await mixer.disconnect();
  });
});
