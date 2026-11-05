import { describe, expect, it } from 'vitest';
import { jsonSafe } from '../src/core/log.js';
import { paramKey } from '../src/core/revisions.js';
import { MASTER } from '../src/mixer/types.js';
import { setup } from './helpers.js';

describe('estados distintos', () => {
  it('desconhecido ≠ -∞: só o parâmetro desconhecido fica null, o resto é lido', async () => {
    const { controller, mixer } = await setup();
    await mixer.setLevelDB(5, MASTER, -Infinity);
    mixer.simulateUnknown(paramKey.level(3, MASTER));
    const r = await controller.mixState();
    expect(r.ok).toBe(true);
    const chs = r.data!.channels as Array<{ channel: number; known: boolean; levelDB: number | null; level: string }>;
    expect(chs[2]).toMatchObject({ channel: 3, known: false, levelDB: null, level: 'desconhecido' });
    expect(chs[4]).toMatchObject({ channel: 5, known: true, levelDB: -Infinity, level: '-∞ dB' });
    expect(chs[0]).toMatchObject({ channel: 1, known: true, levelDB: -10 });
    const json = jsonSafe(r.data) as { channels: Array<{ levelDB: unknown }> };
    expect(json.channels[4]!.levelDB).toBe('-inf');
    expect(json.channels[2]!.levelDB).toBeNull();
  });

  it('escrita em parâmetro desconhecido é recusada sem enviar nada', async () => {
    const { controller, mixer } = await setup();
    mixer.simulateUnknown(paramKey.level(3, MASTER));
    const r = await controller.setLevel({ channel: 'voz 3', deltaDB: 2 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DEGRADED_READ_ONLY');
    expect(mixer.writes).toHaveLength(0);
  });

  it('sem conexão: NO_CONNECTION na leitura e na escrita', async () => {
    const { controller, mixer } = await setup();
    mixer.simulateDisconnect();
    expect((await controller.mixState()).code).toBe('NO_CONNECTION');
    expect((await controller.setLevel({ channel: 1, deltaDB: 1 })).code).toBe('NO_CONNECTION');
    mixer.simulateDrop();
    expect((await controller.setLevel({ channel: 1, deltaDB: 1 })).code).toBe('NO_CONNECTION');
  });

  it('sincronizando: RESYNCING, nenhum comando aceito', async () => {
    const { controller, mixer } = await setup();
    for (const s of ['CONNECTING', 'SYNCING'] as const) {
      mixer.simulateLink(s);
      expect((await controller.mixState()).code).toBe('RESYNCING');
      expect((await controller.setMute({ channels: ['surdo'], muted: true })).code).toBe('RESYNCING');
    }
    expect(mixer.writes).toHaveLength(0);
  });

  it('degradado: leitura parcial permitida, toda escrita bloqueada (mesmo de parâmetros conhecidos)', async () => {
    const { controller, mixer } = await setup();
    mixer.simulateDegraded();
    const read = await controller.mixState();
    expect(read.ok).toBe(true);
    expect(read.code).toBe('DEGRADED_READ_ONLY');
    const w = await controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    expect(w.code).toBe('DEGRADED_READ_ONLY');
    expect((await controller.undo()).code).toBe('DEGRADED_READ_ONLY');
    expect(mixer.writes).toHaveLength(0);
  });

  it('controle interrompido: CONTROL_STOPPED e orientação para a interface oficial', async () => {
    const { controller, mixer } = await setup();
    mixer.simulateLink('STOPPED');
    const r = await controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    expect(r.code).toBe('CONTROL_STOPPED');
    expect(r.message).toContain('interface oficial');
  });
});
