import { describe, expect, it } from 'vitest';
import { MASTER } from '../src/mixer/types.js';
import { setup } from './helpers.js';

const FOUR = ['voz 1', 'voz 2', 'voz 3', 'cavaco'];

describe('operações compostas com falha no meio', () => {
  it('mutar 4 canais com queda depois do 2º: resultado PARCIAL e desfazer só do enviado', async () => {
    const { controller, mixer, log, clock } = await setup({ bulkMuteConfirmAbove: 10 });
    mixer.failAfterWrites(2);
    const r = await controller.setMute({ channels: FOUR, muted: true });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.message).toContain('Operação PARCIAL');
    expect(r.message).toContain('NÃO enviado: Voz 3, Cavaco');
    expect(await mixer.getMute(1, MASTER)).toBe(true);
    expect(await mixer.getMute(2, MASTER)).toBe(true);
    expect(await mixer.getMute(3, MASTER)).toBe(false);
    expect(await mixer.getMute(4, MASTER)).toBe(false);
    expect(mixer.link()).toBe('LOST');

    const entry = log.recent(1)[0]!;
    expect(entry.ok).toBe(false);
    const outcomes = (entry.details!.changes as Array<{ key: string; outcome: string }>).map((c) => [c.key, c.outcome]);
    expect(outcomes).toEqual([
      ['ch.1.main.mute', 'applied_simulated'],
      ['ch.2.main.mute', 'applied_simulated'],
      ['ch.3.main.mute', 'not_sent'],
      ['ch.4.main.mute', 'not_sent'],
    ]);

    // Sem conexão, nada mais é aceito.
    expect((await controller.undo()).code).toBe('NO_CONNECTION');

    // Depois de ressincronizar, o desfazer restaura só os 2 que foram enviados.
    mixer.simulateResync();
    clock.tick(1000);
    const u = await controller.undo();
    expect(u.code).toBe('OK');
    expect(await mixer.getMute(1, MASTER)).toBe(false);
    expect(await mixer.getMute(2, MASTER)).toBe(false);
    expect(await mixer.getMute(3, MASTER)).toBe(false);
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });

  it('queda antes da 1ª escrita: nada enviado e nada no desfazer', async () => {
    const { controller, mixer } = await setup({ bulkMuteConfirmAbove: 10 });
    mixer.failAfterWrites(0);
    const r = await controller.setMute({ channels: FOUR, muted: true });
    expect(r.code).toBe('PARTIAL');
    expect(r.message).toContain('nada foi enviado');
    mixer.simulateResync();
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });

  it('queda no meio de um desfazer composto: o que faltou volta para a pilha', async () => {
    const { controller, mixer, clock } = await setup({ bulkMuteConfirmAbove: 10 });
    await controller.setMute({ channels: ['voz 1', 'voz 2', 'voz 3'], muted: true });
    clock.tick(1000);
    mixer.failAfterWrites(1);
    const u = await controller.undo();
    expect(u.code).toBe('PARTIAL');
    expect(await mixer.getMute(1, MASTER)).toBe(false);
    expect(await mixer.getMute(2, MASTER)).toBe(true);

    mixer.simulateResync();
    clock.tick(1000);
    const again = await controller.undo();
    expect(again.code).toBe('OK');
    expect(await mixer.getMute(2, MASTER)).toBe(false);
    expect(await mixer.getMute(3, MASTER)).toBe(false);
  });
});
