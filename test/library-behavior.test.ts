/**
 * Caracterização da biblioteca soundcraft-ui-connection 7.1.0 SEM o supervisor do MixAI.
 * Estes testes documentam o risco (não o comportamento do MixAI). Se uma versão nova da
 * biblioteca mudar este comportamento, eles falham e avisam para revisar o supervisor.
 */
import { SoundcraftUI } from 'soundcraft-ui-connection';
import { describe, expect, it } from 'vitest';
import { createFakeUi, sleep } from './support/fake-ui-socket.js';

const settle = (ui: SoundcraftUI) => Promise.race([ui.disconnect().catch(() => undefined), sleep(300)]);

describe('biblioteca sozinha (caracterização do risco)', () => {
  it('reenvia na reconexão comandos dados com a conexão caída', async () => {
    const fake = createFakeUi();
    const ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: fake.Ctor as never });
    await ui.connect();
    fake.sockets[0]!.drop();
    await sleep(30);
    ui.master.input(1).setFaderLevelDB(0);
    await sleep(2600); // a biblioteca reconecta sozinha depois de ~2 s
    expect(fake.sockets.length).toBe(2);
    expect(fake.sockets[1]!.commands().some((m) => m.startsWith('SETD^i.0.mix^'))).toBe(true);
    await settle(ui);
  }, 8000);

  it('perde em silêncio um comando dado na janela da queda', async () => {
    const fake = createFakeUi();
    const ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: fake.Ctor as never });
    await ui.connect();
    fake.sockets[0]!.kill();
    expect(() => ui.master.input(1).setFaderLevelDB(-5)).not.toThrow();
    fake.sockets[0]!.drop();
    await sleep(2600);
    expect(fake.sockets[0]!.commands()).toEqual([]);
    expect(fake.sockets[1]?.commands() ?? []).toEqual([]);
    await settle(ui);
  }, 8000);

  it('instância descartada na primeira queda não reconecta nem reenvia', async () => {
    const fake = createFakeUi();
    const ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: fake.Ctor as never });
    await ui.connect();
    fake.sockets[0]!.drop();
    await sleep(10);
    void ui.disconnect().catch(() => undefined);
    ui.master.input(1).setFaderLevelDB(0);
    await sleep(3000);
    expect(fake.sockets.length).toBe(1);
  }, 8000);

  it('disconnect() chamado DENTRO do evento de queda NÃO cancela a reconexão automática', async () => {
    const fake = createFakeUi();
    const ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: fake.Ctor as never });
    ui.status$.subscribe((ev) => {
      if (ev.type === 'CLOSE') void ui.disconnect().catch(() => undefined); // mesmo tick da queda
    });
    await ui.connect();
    fake.sockets[0]!.drop();
    await sleep(2600);
    // A biblioteca ainda abriu um socket novo: por isso o supervisor chama disconnect de novo
    // na próxima volta do loop e vigia a instância descartada.
    expect(fake.sockets.length).toBe(2);
    void ui.disconnect().catch(() => undefined);
    await sleep(10);
  }, 8000);

  it('o estado local reflete a própria escrita na hora (não serve de prova de execução)', async () => {
    const fake = createFakeUi();
    const ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: fake.Ctor as never });
    await ui.connect();
    fake.sockets[0]!.kill(); // a escrita nunca chega à mesa
    const seen: number[] = [];
    const sub = ui.master.input(1).faderLevelDB$.subscribe((v) => seen.push(v));
    ui.master.input(1).setFaderLevelDB(-7);
    sub.unsubscribe();
    expect(seen.some((v) => Math.abs(v + 7) < 0.1)).toBe(true);
    fake.sockets[0]!.drop();
    await settle(ui);
  }, 8000);
});
