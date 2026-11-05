import { describe, expect, it } from 'vitest';
import { commandHash, PendingStore } from '../src/core/pending.js';
import { paramKey } from '../src/core/revisions.js';
import { MASTER } from '../src/mixer/types.js';
import { setup } from './helpers.js';

const SURDO = paramKey.level(6, MASTER); // na fixture dos testes o surdo é o canal 6

describe('autorização vinculada à operação e ao estado', () => {
  it('confirm: true sozinho NÃO executa', async () => {
    const { controller, mixer } = await setup();
    const r = await controller.setLevel({ channel: 'surdo', deltaDB: 8, confirm: true });
    expect(r.code).toBe('NEEDS_CONFIRMATION');
    expect(r.pendingId).toBeTruthy();
    expect(await mixer.getLevelDB(6, MASTER)).toBe(-10);
    expect(mixer.writes).toHaveLength(0);
  });

  it('o id executa uma vez; reutilizar é recusado', async () => {
    const { controller, mixer, clock } = await setup();
    const ask = await controller.setMaster({ deltaDB: 1 });
    const ok = await controller.setMaster({ deltaDB: 1, confirmationId: ask.pendingId });
    expect(ok.code).toBe('OK');
    expect(await mixer.getMasterDB()).toBe(-5);
    clock.tick(1000);
    const again = await controller.setMaster({ deltaDB: 1, confirmationId: ask.pendingId });
    expect(again.code).toBe('CONFIRMATION_USED');
    expect(await mixer.getMasterDB()).toBe(-5);
  });

  it('expira depois de 60 s', async () => {
    const { controller, mixer, clock } = await setup();
    const ask = await controller.setMaster({ deltaDB: 1 });
    clock.tick(61_000);
    const r = await controller.setMaster({ deltaDB: 1, confirmationId: ask.pendingId });
    expect(r.code).toBe('CONFIRMATION_EXPIRED');
    expect(await mixer.getMasterDB()).toBe(-6);
  });

  it('id de outro comando (valor diferente) é recusado e invalidado', async () => {
    const { controller, mixer } = await setup();
    const ask = await controller.setMaster({ deltaDB: 1 });
    const r = await controller.setMaster({ deltaDB: 2, confirmationId: ask.pendingId });
    expect(r.code).toBe('CONFIRMATION_MISMATCH');
    expect(await mixer.getMasterDB()).toBe(-6);
    const retry = await controller.setMaster({ deltaDB: 1, confirmationId: ask.pendingId });
    expect(retry.code).toBe('CONFIRMATION_USED');
  });

  it('parâmetro mudou antes da confirmação: CONFIRMATION_STALE e novo pedido recalcula', async () => {
    const { controller, mixer } = await setup();
    const ask = await controller.setLevel({ channel: 'surdo', deltaDB: 8 });
    expect(ask.message).toContain('de -10 dB para -2 dB');
    mixer.simulateExternalChange(SURDO, -20); // alguém mexeu no surdo enquanto o usuário pensava

    const stale = await controller.setLevel({ channel: 'surdo', deltaDB: 8, confirmationId: ask.pendingId });
    expect(stale.code).toBe('CONFIRMATION_STALE');
    expect(await mixer.getLevelDB(6, MASTER)).toBe(-20);
    expect((await controller.setLevel({ channel: 'surdo', deltaDB: 8, confirmationId: ask.pendingId })).code).toBe(
      'CONFIRMATION_USED',
    );

    const fresh = await controller.setLevel({ channel: 'surdo', deltaDB: 8 });
    expect(fresh.message).toContain('de -20 dB para -12 dB');
    const ok = await controller.setLevel({ channel: 'surdo', deltaDB: 8, confirmationId: fresh.pendingId });
    expect(ok.code).toBe('OK');
    expect(await mixer.getLevelDB(6, MASTER)).toBe(-12);
  });

  it('mute em lote fica obsoleto se um dos canais mudar', async () => {
    const { controller, mixer } = await setup();
    const ask = await controller.setMute({ channels: ['voz 1', 'voz 2', 'voz 3'], muted: true });
    mixer.simulateExternalChange(paramKey.level(2, MASTER), -3); // outro parâmetro: não afeta
    mixer.simulateExternalChange(paramKey.mute(2, MASTER), true); // parâmetro envolvido: afeta
    const r = await controller.setMute({ channels: ['voz 1', 'voz 2', 'voz 3'], muted: true, confirmationId: ask.pendingId });
    expect(r.code).toBe('CONFIRMATION_STALE');
    expect(await mixer.getMute(1, MASTER)).toBe(false);
  });

  it('id inexistente', async () => {
    const { controller } = await setup();
    expect((await controller.setMaster({ deltaDB: 1, confirmationId: 'naoexiste' })).code).toBe('NOT_FOUND');
  });

  it('PendingStore: hash estável e independente da ordem das chaves', () => {
    expect(commandHash({ a: 1, b: [2, 3] })).toBe(commandHash({ b: [2, 3], a: 1 }));
    expect(commandHash({ db: -Infinity })).not.toBe(commandHash({ db: null }));
    let now = 0;
    const store = new PendingStore(1000, () => now, () => 'fixo');
    const { id } = store.create('h', [], 'teste');
    now = 500;
    expect(store.consume(id, 'h', () => 0)).toEqual({ ok: true });
  });
});

describe('confirmação de snapshot ligada ao estado (revisão global + snapshot atual)', () => {
  const load = (c: Awaited<ReturnType<typeof setup>>['controller'], confirmationId?: string) =>
    c.loadSnapshot({ show: 'Pagode', snapshot: 'Bar', confirmationId });

  it('sem mudanças: confirma e carrega', async () => {
    const { controller, mixer } = await setup();
    const ask = await load(controller);
    expect(ask.code).toBe('NEEDS_CONFIRMATION');
    expect((await load(controller, ask.pendingId)).code).toBe('OK');
    expect(await mixer.currentSnapshot()).toEqual({ show: 'Pagode', snapshot: 'Bar' });
  });

  it('qualquer mudança na mesa antes da confirmação: CONFIRMATION_STALE e nada carregado', async () => {
    const { controller, mixer } = await setup();
    const ask = await load(controller);
    mixer.simulateExternalChange(paramKey.level(11, MASTER), -30); // canal sem relação com o comando
    const r = await load(controller, ask.pendingId);
    expect(r.code).toBe('CONFIRMATION_STALE');
    expect(await mixer.currentSnapshot()).toEqual({});
    const fresh = await load(controller);
    expect((await load(controller, fresh.pendingId)).code).toBe('OK');
  });

  it('outro aparelho trocou o snapshot antes da confirmação: CONFIRMATION_STALE', async () => {
    const { controller, mixer } = await setup();
    const ask = await load(controller);
    mixer.simulateSnapshotLoaded('Pagode', 'Ensaio');
    expect((await load(controller, ask.pendingId)).code).toBe('CONFIRMATION_STALE');
    expect(await mixer.currentSnapshot()).toEqual({ show: 'Pagode', snapshot: 'Ensaio' });
  });

  it('o próprio MixAI mudou algo antes da confirmação: CONFIRMATION_STALE', async () => {
    const { controller } = await setup();
    const ask = await load(controller);
    await controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    expect((await load(controller, ask.pendingId)).code).toBe('CONFIRMATION_STALE');
  });
});
