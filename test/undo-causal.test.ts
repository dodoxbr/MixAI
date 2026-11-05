import { describe, expect, it } from 'vitest';
import { paramKey } from '../src/core/revisions.js';
import { MASTER } from '../src/mixer/types.js';
import { confirmed, setup } from './helpers.js';

const VOZ1 = paramKey.level(1, MASTER);

describe('desfazer causal', () => {
  it('três alterações seguidas no mesmo fader são desfeitas em sequência', async () => {
    const { controller, mixer, clock } = await setup();
    for (const db of [-8, -6, -4]) {
      expect((await controller.setLevel({ channel: 'voz 1', db })).ok).toBe(true);
      clock.tick(400);
    }
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-4);
    for (const expected of [-6, -8, -10]) {
      const r = await controller.undo();
      expect(r.code).toBe('OK');
      expect(await mixer.getLevelDB(1, MASTER)).toBe(expected);
      clock.tick(400);
    }
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });

  it('desfaz várias ações em parâmetros diferentes de uma vez', async () => {
    const { controller, mixer, clock } = await setup({ maxActionsPerSecond: 50 });
    await controller.setLevel({ channel: 'voz 1', deltaDB: 3 });
    await controller.setLevel({ channel: 'voz 2', deltaDB: -3 });
    await controller.setMute({ channels: ['cavaco'], muted: true });
    await controller.setLevel({ channel: 'voz 1', aux: 'cavaco', deltaDB: 4 });
    clock.tick(1000);
    const r = await controller.undo(4);
    expect(r.code).toBe('OK');
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-10);
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-10);
    expect(await mixer.getMute(4, MASTER)).toBe(false);
  });

  it('mudança externa entre duas operações bloqueia o desfazer da primeira', async () => {
    const { controller, mixer, clock } = await setup();
    await controller.setLevel({ channel: 'voz 1', db: -8 }); // A1
    mixer.simulateExternalChange(VOZ1, -9); // outra pessoa
    clock.tick(400);
    await controller.setLevel({ channel: 'voz 1', deltaDB: 2 }); // A2: -9 → -7
    clock.tick(400);

    const u2 = await controller.undo();
    expect(u2.code).toBe('OK');
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-9); // volta ao valor da outra pessoa

    clock.tick(400);
    const u1 = await controller.undo();
    expect(u1.code).toBe('CONFLICT');
    expect(u1.message).toContain('outro aparelho');
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-9); // a mudança externa foi preservada
  });

  it('mudança externa que volta ao mesmo valor também bloqueia (compara revisão, não valor)', async () => {
    const { controller, mixer } = await setup();
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    mixer.simulateExternalChange(VOZ1, -5);
    mixer.simulateExternalChange(VOZ1, -8); // de volta ao valor que o MixAI tinha posto
    const r = await controller.undo();
    expect(r.code).toBe('CONFLICT');
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-8);
  });

  it('desfazer de vários passos pula os conflitos e desfaz o resto', async () => {
    const { controller, mixer, clock } = await setup();
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    await controller.setLevel({ channel: 'voz 2', db: -8 });
    mixer.simulateExternalChange(VOZ1, -3);
    clock.tick(1000);
    const r = await controller.undo(2);
    expect(r.code).toBe('PARTIAL');
    expect(r.message).toContain('Não desfeito (conflito)');
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-10);
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-3);
  });

  it('desfazer respeita o teto atual e o limite de comandos por segundo', async () => {
    const teto = await setup({ maxChannelLevelDB: 0 });
    teto.mixer.simulateExternalChange(VOZ1, 3); // alguém subiu acima do teto pela mesa
    await teto.controller.setLevel({ channel: 'voz 1', db: -2 });
    teto.clock.tick(1000);
    const r = await teto.controller.undo();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('acima do teto');
    expect(await teto.mixer.getLevelDB(1, MASTER)).toBe(-2);

    const limite = await setup({ maxActionsPerSecond: 2 });
    await limite.controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    await limite.controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    expect((await limite.controller.undo()).code).toBe('RATE_LIMIT');
  });

  it('ressincronização com valor diferente invalida; com o mesmo valor mantém', async () => {
    const diff = await setup();
    await diff.controller.setLevel({ channel: 'voz 1', db: -8 });
    diff.mixer.simulateDrop();
    diff.mixer.simulateResync([[VOZ1, -12]]);
    expect((await diff.controller.undo()).code).toBe('CONFLICT');

    const same = await setup();
    await same.controller.setLevel({ channel: 'voz 1', db: -8 });
    same.mixer.simulateDrop();
    same.mixer.simulateResync([[VOZ1, -8]]);
    expect((await same.controller.undo()).code).toBe('OK');
    expect(await same.mixer.getLevelDB(1, MASTER)).toBe(-10);
  });

  it('verificação "indeterminada" após reconexão invalida o desfazer daquele parâmetro', async () => {
    const { controller, mixer } = await setup();
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    mixer.simulateDrop();
    mixer.simulateResync([], [{ key: VOZ1, target: -8, outcome: 'indeterminate' }]);
    const r = await controller.undo();
    expect(r.code).toBe('CONFLICT');
    expect(r.message).toContain('incerto');
  });

  it('carregar snapshot esvazia o desfazer e invalida as revisões', async () => {
    const { controller } = await setup();
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    const snap = await confirmed((id) => controller.loadSnapshot({ show: 'Pagode', snapshot: 'Bar', confirmationId: id }));
    expect(snap.ok).toBe(true);
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });
});
