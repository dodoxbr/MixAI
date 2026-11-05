import { describe, expect, it } from 'vitest';
import { paramKey, type ParamKey } from '../src/core/revisions.js';
import {
  applyStateEvent,
  decodeValue,
  encodeValue,
  snapshotToWire,
  type MixerStateSnapshot,
  type StateEvent,
} from '../src/core/state.js';
import { MASTER } from '../src/mixer/types.js';
import { confirmed, setup } from './helpers.js';

const VOZ1 = paramKey.level(1, MASTER);

describe('codificação de valores', () => {
  it('-∞ ↔ "-inf"; booleanos e números passam; null/inválido = desconhecido', () => {
    expect(encodeValue(-Infinity)).toBe('-inf');
    expect(decodeValue('-inf')).toBe(-Infinity);
    expect(encodeValue(-3.5)).toBe(-3.5);
    expect(decodeValue(true)).toBe(true);
    expect(decodeValue(null)).toBeUndefined();
    expect(decodeValue('abc')).toBeUndefined();
    expect(decodeValue(Infinity)).toBeUndefined();
    expect(() => encodeValue(Infinity)).toThrow();
  });
});

describe('estado observável (StateHub)', () => {
  it('snapshot distingue known, -∞, unknown e unavailable', async () => {
    const { controller, mixer } = await setup();
    await mixer.setLevelDB(2, MASTER, -Infinity);
    mixer.simulateUnknown(paramKey.level(3, MASTER));
    const s = controller.state.snapshot();
    expect(s.available).toBe(true);
    expect(s.params[VOZ1]!.value).toEqual({ status: 'known', value: -10 });
    expect(s.params['ch.2.main.level']!.value).toEqual({ status: 'known', value: -Infinity });
    expect(s.params['ch.3.main.level']!.value).toEqual({ status: 'unknown' });
    const json = snapshotToWire(s) as unknown as { params: Record<string, { value: { value?: unknown } }> };
    expect(json.params['ch.2.main.level']!.value.value).toBe('-inf');

    mixer.simulateDrop();
    const off = controller.state.snapshot();
    expect(off.available).toBe(false);
    expect(off.params[VOZ1]!.value).toEqual({ status: 'unavailable' });
    expect(off.params['ch.3.main.level']!.value).toEqual({ status: 'unavailable' });
  });

  it('inclui EQ/HPF/bypass no estado (valores do simulador), sem tool para alterá-los', async () => {
    const { controller } = await setup();
    const s = controller.state.snapshot();
    expect(s.params['ch.1.eq.b1.gain']!.value).toEqual({ status: 'known', value: 0 });
    expect(s.params['ch.1.eq.hpf.slope']!.value).toEqual({ status: 'known', value: 12 });
    expect(s.params['ch.1.eq.bypass']!.value).toEqual({ status: 'known', value: false });
  });

  it('revisões globais e por parâmetro, com o ator de cada mudança', async () => {
    const { controller, mixer } = await setup();
    const r0 = controller.state.snapshot().revision;
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    mixer.simulateExternalChange(paramKey.mute(2, MASTER), true);
    const s = controller.state.snapshot();
    expect(s.revision).toBe(r0 + 2);
    expect(s.params[VOZ1]).toMatchObject({ revision: r0 + 1, actor: 'mixai' });
    expect(s.params['ch.2.main.mute']).toMatchObject({ revision: r0 + 2, actor: 'external' });
    expect(s.params['ch.4.main.level']).toMatchObject({ revision: 0 });
  });

  it('eventos encadeados: cada evento começa onde o anterior terminou', async () => {
    const { controller, mixer, clock } = await setup({ bulkMuteConfirmAbove: 10, maxActionsPerSecond: 100 });
    const events: StateEvent[] = [];
    controller.state.subscribe((e) => events.push(e));
    await controller.setLevel({ channel: 'voz 1', deltaDB: 2 });
    await controller.setMute({ channels: ['voz 2', 'voz 3'], muted: true });
    mixer.simulateExternalChange(VOZ1, -1);
    clock.tick(1000);
    await controller.undo();
    const params = events.filter((e): e is Extract<StateEvent, { type: 'params' }> => e.type === 'params');
    expect(params.length).toBe(4);
    for (let i = 1; i < params.length; i++) expect(params[i]!.fromRevision).toBe(params[i - 1]!.revision);
    expect(params[1]!.changes.map((c) => c.key).sort()).toEqual(['ch.2.main.mute', 'ch.3.main.mute']);
    expect(params[2]!.changes[0]).toMatchObject({ key: VOZ1, actor: 'external', value: { status: 'known', value: -1 } });
  });

  it('sincronização: snapshot + eventos reproduz exatamente um snapshot novo', async () => {
    const { controller, mixer, clock } = await setup({ bulkMuteConfirmAbove: 10, maxActionsPerSecond: 100 });
    const mirror = controller.state.snapshot();
    const outcomes: string[] = [];
    controller.state.subscribe((e) => outcomes.push(applyStateEvent(mirror, e)));

    await controller.setLevel({ channel: 'voz 1', db: -8 });
    await controller.setLevel({ channel: 'voz 2', aux: 'cavaco', deltaDB: 3 });
    await controller.setMute({ channels: ['voz 1', 'cavaco', 'surdo'], muted: true });
    mixer.simulateExternalChange(paramKey.level(5, MASTER), -2);
    clock.tick(1000);
    await controller.undo(2);
    await confirmed((id) => controller.setMaster({ deltaDB: 1, confirmationId: id }));
    mixer.simulateResync([[paramKey.level(6, MASTER), -30]], [{ key: VOZ1, target: -8, outcome: 'observed_target' }]);
    mixer.throwOnWriteAfter(0);
    await controller.setLevel({ channel: 'voz 3', deltaDB: 1 });
    await confirmed((id) => controller.loadSnapshot({ show: 'Pagode', snapshot: 'Bar', confirmationId: id }));

    expect(outcomes.every((o) => o === 'applied')).toBe(true);
    const fresh = controller.state.snapshot();
    expect(mirror.revision).toBe(fresh.revision);
    expect(mirror.params).toEqual(fresh.params);
  });

  it('buraco na sequência e evento repetido são detectados', async () => {
    const { controller } = await setup();
    const mirror = controller.state.snapshot();
    const events: StateEvent[] = [];
    controller.state.subscribe((e) => events.push(e));
    await controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    await controller.setLevel({ channel: 'voz 2', deltaDB: 1 });
    expect(applyStateEvent(mirror, events[1]!)).toBe('gap'); // pulou o primeiro
    expect(applyStateEvent(mirror, events[0]!)).toBe('applied');
    expect(applyStateEvent(mirror, events[0]!)).toBe('stale');
    expect(applyStateEvent(mirror, events[1]!)).toBe('applied');
  });

  it('ligação: indisponível marca tudo como unavailable; ao voltar, pede novo snapshot', async () => {
    const { controller, mixer } = await setup();
    const mirror: MixerStateSnapshot = controller.state.snapshot();
    const outcomes: string[] = [];
    controller.state.subscribe((e) => outcomes.push(`${e.type}:${applyStateEvent(mirror, e)}`));
    mixer.simulateDrop();
    expect(mirror.available).toBe(false);
    expect(mirror.params[VOZ1]!.value).toEqual({ status: 'unavailable' });
    mixer.simulateResync();
    expect(outcomes).toEqual(['link:applied', 'link:gap']);
  });

  it('um assinante com erro não atrapalha os outros nem o comando', async () => {
    const { controller } = await setup();
    let got = 0;
    controller.state.subscribe(() => {
      throw new Error('assinante quebrado');
    });
    controller.state.subscribe(() => got++);
    const r = await controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    expect(r.ok).toBe(true);
    expect(got).toBe(1);
  });

  it('chaves pedidas no snapshot podem ser filtradas', async () => {
    const { controller } = await setup();
    const keys: ParamKey[] = [VOZ1, 'master.level'];
    expect(Object.keys(controller.state.snapshot(keys).params)).toEqual(keys);
  });
});
