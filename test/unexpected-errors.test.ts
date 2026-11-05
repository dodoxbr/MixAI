import { describe, expect, it } from 'vitest';
import { MASTER } from '../src/mixer/types.js';
import { confirmed, setup } from './helpers.js';

const FOUR = ['voz 1', 'voz 2', 'voz 3', 'cavaco'];

describe('exceções inesperadas no meio de uma operação', () => {
  it('4 canais, a 2ª escrita lança erro inesperado: enviados × incerto × não enviados, sem sucesso completo', async () => {
    const { controller, mixer, log, clock } = await setup({ bulkMuteConfirmAbove: 10 });
    mixer.throwOnWriteAfter(1, new Error('falha interna da biblioteca'));
    const r = await controller.setMute({ channels: FOUR, muted: true });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.message).toContain('RESULTADO INCERTO');
    expect(r.message).toContain('Voz 2 (falha interna da biblioteca)');
    expect(r.message).toContain('NÃO enviado: Voz 3, Cavaco');
    const outcomes = (r.data!.changes as Array<{ key: string; outcome: string }>).map((c) => [c.key, c.outcome]);
    expect(outcomes).toEqual([
      ['ch.1.main.mute', 'applied_simulated'],
      ['ch.2.main.mute', 'indeterminate'],
      ['ch.3.main.mute', 'not_sent'],
      ['ch.4.main.mute', 'not_sent'],
    ]);
    expect(log.recent(1)[0]!.ok).toBe(false);

    // A fila continua funcionando depois do erro.
    clock.tick(1000);
    expect((await controller.setLevel({ channel: 'voz 1', deltaDB: 1 })).code).toBe('OK');

    // O desfazer cobre só o que foi efetivamente feito (canal 1); o incerto não é desfazível.
    clock.tick(1000);
    await controller.undo(); // desfaz o +1 da voz 1
    clock.tick(1000);
    const u = await controller.undo(); // desfaz o mute parcial
    expect(u.code).toBe('OK');
    expect(await mixer.getMute(1, MASTER)).toBe(false);
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });

  it('comando simples com erro inesperado também não vira sucesso', async () => {
    const { controller, mixer } = await setup();
    mixer.throwOnWriteAfter(0);
    const r = await controller.setLevel({ channel: 'voz 1', deltaDB: 2 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.message).toContain('nada foi concluído');
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });

  it('erro inesperado no meio de um desfazer: incerto relatado e o restante volta para a pilha', async () => {
    const { controller, mixer, clock } = await setup({ bulkMuteConfirmAbove: 10 });
    await controller.setMute({ channels: ['voz 1', 'voz 2', 'voz 3'], muted: true });
    clock.tick(1000);
    mixer.throwOnWriteAfter(1);
    const u = await controller.undo();
    expect(u.code).toBe('PARTIAL');
    expect(u.message).toContain('RESULTADO INCERTO ao desfazer');
    expect(await mixer.getMute(1, MASTER)).toBe(false);
    clock.tick(1000);
    const again = await controller.undo();
    expect(again.code).toBe('OK');
    expect(await mixer.getMute(3, MASTER)).toBe(false);
  });

  it('erro inesperado ao carregar snapshot: resultado incerto e desfazer zerado', async () => {
    const { controller, mixer } = await setup();
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    mixer.throwOnWriteAfter(0, new Error('timeout'));
    const r = await confirmed((id) => controller.loadSnapshot({ show: 'Pagode', snapshot: 'Bar', confirmationId: id }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.message).toContain('RESULTADO INCERTO');
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });
});
