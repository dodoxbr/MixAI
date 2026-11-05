import { decodeValue, StateSync } from './protocol';
import { levelEvent, snapshot } from '../../testing/fake-socket';

describe('protocolo de estado', () => {
  it('-∞, desconhecido e indisponível continuam distintos; valor inválido é recusado', () => {
    expect(decodeValue({ status: 'known', value: '-inf' })).toEqual({ status: 'known', value: -Infinity });
    expect(decodeValue({ status: 'unknown' })).toEqual({ status: 'unknown' });
    expect(decodeValue({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
    expect(() => decodeValue({ status: 'known', value: null })).toThrow();
  });

  it('aplica eventos em sequência e pede snapshot ao detectar um evento perdido', () => {
    let resyncs = 0;
    const sync = new StateSync(() => resyncs++);
    expect(sync.handle(snapshot(0))).toBe('ready');
    expect(sync.handle(levelEvent(0, 'ch.1.main.level', -8))).toBe('applied');
    expect(sync.state!.params['ch.1.main.level']!.value).toEqual({ status: 'known', value: -8 });
    expect(sync.handle(levelEvent(2, 'ch.1.main.level', -4))).toBe('resync'); // faltou o 1→2
    expect(resyncs).toBe(1);
    expect(sync.handle(levelEvent(0, 'ch.1.main.level', -8))).toBe('stale');
    expect(sync.handle(levelEvent(1, 'ch.1.main.level', '-inf'))).toBe('applied');
    expect(sync.state!.params['ch.1.main.level']!.value).toEqual({ status: 'known', value: -Infinity });
  });

  it('servidor reiniciado (outro serverId): descarta o estado e não aplica eventos sem snapshot', () => {
    let resyncs = 0;
    const sync = new StateSync(() => resyncs++);
    sync.handle(snapshot(5, 'antigo'));
    expect(sync.handle(levelEvent(0, 'ch.1.main.level', -8, 'novo'))).toBe('resync');
    expect(sync.state).toBeUndefined();
    expect(sync.handle(snapshot(0, 'novo'))).toBe('ready');
  });

  it('ligação indisponível marca tudo como indisponível; ao voltar pede snapshot', () => {
    let resyncs = 0;
    const sync = new StateSync(() => resyncs++);
    sync.handle(snapshot(0));
    sync.handle({ type: 'event', serverId: 'srv-1', event: { type: 'link', revision: 0, link: 'LOST', available: false } });
    expect(sync.state!.params['ch.1.main.level']!.value).toEqual({ status: 'unavailable' });
    expect(sync.handle({ type: 'event', serverId: 'srv-1', event: { type: 'link', revision: 0, link: 'READY', available: true } })).toBe('resync');
  });
});
