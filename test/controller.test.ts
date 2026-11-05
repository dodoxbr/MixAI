import { describe, expect, it } from 'vitest';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { formatDB } from '../src/core/controller.js';
import { setup } from './helpers.js';

describe('volume do canal', () => {
  it('ajuste absoluto e relativo', async () => {
    const { controller, mixer } = await setup();
    let r = await controller.setLevel({ channel: 'voz 2', db: -7 });
    expect(r.ok).toBe(true);
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-7);
    expect(r.message).toContain('Voz 2 no master: -10 dB → -7 dB');

    r = await controller.setLevel({ channel: 'voz 2', deltaDB: 2 });
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-5);
    r = await controller.setLevel({ channel: 'voz 2', deltaDB: -3.3 });
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-8.5); // arredonda para 0,5 dB
  });

  it('exige db OU delta, nunca os dois nem nenhum', async () => {
    const { controller } = await setup();
    expect((await controller.setLevel({ channel: 1 })).ok).toBe(false);
    expect((await controller.setLevel({ channel: 1, db: -5, deltaDB: 2 })).ok).toBe(false);
  });

  it('nunca passa do teto e avisa que limitou', async () => {
    const { controller, mixer } = await setup({ maxChannelLevelDB: -3 });
    const r = await controller.setLevel({ channel: 'cavaco', db: 5, confirm: true });
    expect(r.ok).toBe(true);
    expect(await mixer.getLevelDB(4, MASTER)).toBe(-3);
    expect(r.message).toContain('limitei');
  });

  it('mudança grande pede confirmação e não mexe na mesa', async () => {
    const { controller, mixer } = await setup();
    const r = await controller.setLevel({ channel: 'surdo', deltaDB: 8 });
    expect(r.ok).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(await mixer.getLevelDB(6, MASTER)).toBe(-10);
    expect(mixer.writes).toHaveLength(0);

    const ok = await controller.setLevel({ channel: 'surdo', deltaDB: 8, confirm: true });
    expect(ok.ok).toBe(true);
    expect(await mixer.getLevelDB(6, MASTER)).toBe(-2);
  });

  it('6 dB passa direto; acima de 6 pede confirmação (limite configurável)', async () => {
    const { controller } = await setup();
    expect((await controller.setLevel({ channel: 1, deltaDB: 6 })).ok).toBe(true);
    expect((await controller.setLevel({ channel: 1, deltaDB: -6.5 })).needsConfirmation).toBe(true);
  });

  it('abrir canal que estava todo abaixado conta como mudança grande', async () => {
    const { controller, mixer } = await setup();
    await mixer.setLevelDB(3, MASTER, -Infinity);
    const r = await controller.setLevel({ channel: 'voz 3', db: -10 });
    expect(r.needsConfirmation).toBe(true);
  });

  it('db muito baixo vira fader todo para baixo', async () => {
    const { controller, mixer } = await setup();
    await controller.setLevel({ channel: 1, db: -100, confirm: true });
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-Infinity);
  });

  it('não faz nada se já está no valor', async () => {
    const { controller, mixer } = await setup();
    const r = await controller.setLevel({ channel: 1, db: -10 });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Nada mudou');
    expect(mixer.writes).toHaveLength(0);
  });

  it('nome desconhecido não mexe em nada', async () => {
    const { controller, mixer } = await setup();
    const r = await controller.setLevel({ channel: 'trombone', db: -5 });
    expect(r.ok).toBe(false);
    expect(mixer.writes).toHaveLength(0);
  });
});

describe('retornos (AUX)', () => {
  it('"sobe a voz 1 no retorno do cavaco" mexe só naquele envio', async () => {
    const { controller, mixer } = await setup();
    const r = await controller.setLevel({ channel: 'voz 1', aux: 'retorno do cavaco', deltaDB: 3 });
    expect(r.ok).toBe(true);
    expect(await mixer.getLevelDB(1, auxBus(2))).toBe(-17);
    expect(await mixer.getLevelDB(1, auxBus(1))).toBe(-20);
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-10);
    expect(r.message).toContain('no Retorno Cavaco');
  });

  it('respeita o teto próprio dos retornos', async () => {
    const { controller, mixer } = await setup({ maxAuxSendDB: -6 });
    await controller.setLevel({ channel: 'voz 1', aux: 'cavaco', db: 0, confirm: true });
    expect(await mixer.getLevelDB(1, auxBus(2))).toBe(-6);
  });
});

describe('mute', () => {
  it('muta e desmuta por nome', async () => {
    const { controller, mixer } = await setup();
    await controller.setMute({ channels: ['surdo'], muted: true });
    expect(await mixer.getMute(6, MASTER)).toBe(true);
    await controller.setMute({ channels: ['surdo'], muted: false });
    expect(await mixer.getMute(6, MASTER)).toBe(false);
  });

  it('mutar muitos canais de uma vez pede confirmação', async () => {
    const { controller, mixer } = await setup();
    const r = await controller.setMute({ channels: ['voz 1', 'voz 2', 'voz 3'], muted: true });
    expect(r.needsConfirmation).toBe(true);
    expect(await mixer.getMute(1, MASTER)).toBe(false);
    const ok = await controller.setMute({ channels: ['voz 1', 'voz 2', 'voz 3'], muted: true, confirm: true });
    expect(ok.ok).toBe(true);
    expect(await mixer.getMute(3, MASTER)).toBe(true);
  });

  it('mute no retorno não afeta o master', async () => {
    const { controller, mixer } = await setup();
    await controller.setMute({ channels: ['surdo'], muted: true, aux: 'retorno do violão' });
    expect(await mixer.getMute(6, auxBus(3))).toBe(true);
    expect(await mixer.getMute(6, MASTER)).toBe(false);
  });
});

describe('master', () => {
  it('sempre pede confirmação', async () => {
    const { controller, mixer } = await setup();
    const r = await controller.setMaster({ deltaDB: 1 });
    expect(r.needsConfirmation).toBe(true);
    expect(await mixer.getMasterDB()).toBe(-6);
    await controller.setMaster({ deltaDB: 1, confirm: true });
    expect(await mixer.getMasterDB()).toBe(-5);
  });
});

describe('desfazer', () => {
  it('desfaz a última ação e depois as anteriores', async () => {
    const { controller, mixer, clock } = await setup();
    await controller.setLevel({ channel: 'voz 1', db: -5 });
    clock.tick(300);
    await controller.setMute({ channels: ['cavaco'], muted: true });
    clock.tick(300);
    await controller.setLevel({ channel: 'voz 1', aux: 'cavaco', deltaDB: 4 });

    let r = await controller.undo();
    expect(r.ok).toBe(true);
    expect(await mixer.getLevelDB(1, auxBus(2))).toBe(-20);
    expect(await mixer.getMute(4, MASTER)).toBe(true);

    r = await controller.undo(5); // pede mais do que existe: desfaz o que tem
    expect(await mixer.getMute(4, MASTER)).toBe(false);
    expect(await mixer.getLevelDB(1, MASTER)).toBe(-10);
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });

  it('desfaz até o fader todo para baixo', async () => {
    const { controller, mixer } = await setup();
    await mixer.setLevelDB(2, MASTER, -Infinity);
    await controller.setLevel({ channel: 2, db: -12, confirm: true });
    await controller.undo();
    expect(await mixer.getLevelDB(2, MASTER)).toBe(-Infinity);
  });
});

describe('proteções gerais', () => {
  it('limita comandos por segundo', async () => {
    const { controller, clock } = await setup({ maxActionsPerSecond: 3 });
    for (let i = 0; i < 3; i++) expect((await controller.setLevel({ channel: 1, deltaDB: 1 })).ok).toBe(true);
    const blocked = await controller.setLevel({ channel: 1, deltaDB: 1 });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('Muitos comandos');
    clock.tick(1000);
    expect((await controller.setLevel({ channel: 1, deltaDB: 1 })).ok).toBe(true);
  });

  it('sem conexão, recusa tudo que mexe na mesa', async () => {
    const { controller, mixer } = await setup();
    mixer.simulateDisconnect();
    const r = await controller.setLevel({ channel: 1, db: -5 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Sem conexão');
    expect((await controller.mixState()).ok).toBe(false);
    expect((await controller.ensureConnected()).ok).toBe(true);
    expect((await controller.setLevel({ channel: 1, db: -5 })).ok).toBe(true);
  });

  it('registra ações e recusas no log', async () => {
    const { controller, log, clock } = await setup({ maxActionsPerSecond: 1 });
    await controller.setLevel({ channel: 1, db: -5 });
    await controller.setLevel({ channel: 1, db: -4 });
    clock.tick(2000);
    const entries = log.recent();
    expect(entries.map((e) => [e.action, e.ok])).toEqual([
      ['set_level', true],
      ['rate_limit', false],
    ]);
  });
});

describe('snapshots', () => {
  it('lista, pede confirmação, carrega e zera o desfazer', async () => {
    const { controller, mixer } = await setup();
    await controller.setLevel({ channel: 1, db: -5 });
    expect((await controller.listSnapshots()).data?.shows).toEqual({ Pagode: ['Ensaio', 'Bar'] });

    const ask = await controller.loadSnapshot({ show: 'pagode', snapshot: 'bar' });
    expect(ask.needsConfirmation).toBe(true);
    expect(await mixer.currentSnapshot()).toEqual({});

    const ok = await controller.loadSnapshot({ show: 'pagode', snapshot: 'bar', confirm: true });
    expect(ok.ok).toBe(true);
    expect(await mixer.currentSnapshot()).toEqual({ show: 'Pagode', snapshot: 'Bar' });
    expect((await controller.undo()).message).toContain('nada para desfazer');
  });

  it('snapshot inexistente é recusado', async () => {
    const { controller } = await setup();
    expect((await controller.loadSnapshot({ show: 'Pagode', snapshot: 'Casamento', confirm: true })).ok).toBe(false);
  });
});

describe('estado e formatação', () => {
  it('mostra os 12 canais com os nomes da banda', async () => {
    const { controller } = await setup();
    const r = await controller.mixState();
    const channels = r.data?.channels as Array<{ name: string; level: string }>;
    expect(channels).toHaveLength(12);
    expect(channels[3]!.name).toBe('Cavaco');
    expect(channels[8]!.name).toBe('Canal 9');
    expect(r.data?.master).toBe('-6 dB');
  });

  it('formata dB', () => {
    expect(formatDB(-Infinity)).toBe('-∞ dB');
    expect(formatDB(2)).toBe('+2 dB');
    expect(formatDB(-4.54)).toBe('-4.5 dB');
  });
});
