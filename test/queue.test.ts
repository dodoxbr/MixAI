import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/core/queue.js';
import { MASTER } from '../src/mixer/types.js';
import { setup } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('fila única', () => {
  it('executa na ordem de chegada, uma tarefa por vez', async () => {
    const q = new CommandQueue();
    const order: number[] = [];
    let running = 0;
    let maxRunning = 0;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        q.run(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await sleep(20 - i); // as primeiras demoram mais: sem fila, a ordem inverteria
          order.push(i);
          running--;
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(maxRunning).toBe(1);
    expect(q.size()).toBe(0);
  });

  it('um erro numa tarefa não trava as próximas', async () => {
    const q = new CommandQueue();
    const failing = q.run(async () => {
      throw new Error('falhou');
    });
    const next = q.run(async () => 'seguiu');
    await expect(failing).rejects.toThrow('falhou');
    await expect(next).resolves.toBe('seguiu');
  });

  it('+3 e +3 em paralelo no mesmo canal resultam em +6 (sem atropelar)', async () => {
    const { controller, mixer } = await setup();
    const [a, b] = await Promise.all([
      controller.setLevel({ channel: 'voz 1', deltaDB: 3 }),
      controller.setLevel({ channel: 'voz 1', deltaDB: 3 }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-4);
  });

  it('mute e volume concorrentes em canais diferentes chegam todos', async () => {
    const { controller, mixer } = await setup({ maxActionsPerSecond: 50 });
    await Promise.all([
      controller.setLevel({ channel: 'voz 1', deltaDB: 2 }),
      controller.setMute({ channels: ['surdo'], muted: true }),
      controller.setLevel({ channel: 'voz 2', deltaDB: -2 }),
      controller.setLevel({ channel: 'voz 1', deltaDB: 2 }),
    ]);
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-6);
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-12);
    expect(await mixer.getMute(6, MASTER)).toBe(true);
  });
});
