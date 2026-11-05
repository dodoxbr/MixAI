import { describe, expect, it } from 'vitest';
import { RealMixer } from '../src/mixer/real.js';
import { auxBus, MASTER } from '../src/mixer/types.js';

/**
 * WebSocket falso que imita a Ui16: guarda o que a biblioteca envia
 * e permite injetar as mensagens que a mesa mandaria.
 */
class FakeMixerSocket {
  static last: FakeMixerSocket | undefined;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeMixerSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
      // Estado inicial como a mesa manda ao conectar (valores lineares de fader).
      this.push('SETD^i.0.mix^0.5', 'SETD^i.0.mute^0', 'SETD^i.3.mute^1', 'SETD^m.mix^0.6', 'SETD^i.0.aux.1.value^0.4');
    }, 5);
  }
  push(...messages: string[]) {
    for (const m of messages) this.onmessage?.({ data: `3:::${m}` });
  }
  send(msg: string) {
    this.sent.push(msg);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ wasClean: true, code: 1000 });
  }
}

describe('adaptador da mesa real (com WebSocket falso)', () => {
  it('conecta, lê o estado e envia comandos no protocolo da Ui', async () => {
    const mixer = new RealMixer({ ip: '10.10.1.1', webSocketCtor: FakeMixerSocket, connectTimeoutMs: 5000 });
    await mixer.connect();
    expect(mixer.isConnected()).toBe(true);
    expect(FakeMixerSocket.last!.url).toContain('10.10.1.1');

    const level = await mixer.getLevelDB(1, MASTER);
    expect(Number.isFinite(level)).toBe(true);
    expect(await mixer.getMute(1, MASTER)).toBe(false);
    expect(await mixer.getMute(4, MASTER)).toBe(true);
    expect(Number.isFinite(await mixer.getLevelDB(1, auxBus(2)))).toBe(true);

    const ws = FakeMixerSocket.last!;
    ws.sent = [];
    await mixer.setLevelDB(2, MASTER, -6);
    await mixer.setMute(6, MASTER, true);
    await mixer.setLevelDB(1, auxBus(2), -12);
    await mixer.setMasterDB(-3);
    await mixer.loadSnapshot('Pagode', 'Bar');
    const sent = ws.sent.join('\n');
    // Canais começam em 0 no protocolo: canal 2 = i.1, canal 6 = i.5, AUX 2 = aux.1
    expect(sent).toMatch(/SETD\^i\.1\.mix\^/);
    expect(sent).toMatch(/SETD\^i\.5\.mute\^1/);
    expect(sent).toMatch(/SETD\^i\.0\.aux\.1\.value\^/);
    expect(sent).toMatch(/SETD\^m\.mix\^/);
    expect(sent).toMatch(/Pagode/);
    console.log('Mensagens enviadas:\n' + sent);

    await mixer.disconnect();
    expect(mixer.isConnected()).toBe(false);
  });

  it('IP errado: falha com mensagem clara depois do tempo limite', async () => {
    class NeverOpens extends FakeMixerSocket {
      constructor(url: string) {
        super(url);
        this.onopen = null;
      }
    }
    // Sobrescreve para nunca abrir
    const Ctor = function (this: unknown, url: string) {
      const s = Object.create(FakeMixerSocket.prototype) as FakeMixerSocket;
      Object.assign(s, { url, readyState: 0, sent: [], onopen: null, onclose: null, onmessage: null, onerror: null });
      return s;
    } as unknown as typeof NeverOpens;
    const mixer = new RealMixer({ ip: '10.0.0.99', webSocketCtor: Ctor, connectTimeoutMs: 300 });
    await expect(mixer.connect()).rejects.toThrow(/10\.0\.0\.99/);
    expect(mixer.isConnected()).toBe(false);
  });
});
