import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';

const SCENE = {
  id: 'cena-abc123',
  name: 'Roda de sábado',
  description: '',
  createdAt: '2026-11-05T20:00:00.000Z',
  updatedAt: '2026-11-05T20:00:00.000Z',
  validationStatus: 'UNVERIFIED',
  deviceProfile: { model: 'ui16', inputs: 12, aux: 6 },
  params: 349,
  compat: { compatible: 0, incompatible: 180, unknown: 169 },
};

async function boot(canLoad = true) {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const fixture = TestBed.createComponent(App);
  const session = TestBed.inject(SessionService);
  session.token.set('tok');
  session.role.set('operator');
  fixture.detectChanges();
  await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  ws.receive({ ...hello('operator'), scenes: { available: true, canLoad } });
  answerNames(ws);
  ws.receive(snapshot(0));
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  await settle();
  /** Responde ao último comando de cena do tipo dado. */
  const answer = async (type: string, result: Record<string, unknown>) => {
    const req = [...ws.sent].reverse().find((m) => m['type'] === 'command' && (m['command'] as { type: string }).type === type)!;
    expect(req, `comando ${type} não enviado`).toBeTruthy();
    ws.receive({ type: 'result', requestId: req['requestId'], result });
    await settle();
  };
  const button = (name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === name) as HTMLButtonElement;
  const open = async () => {
    button('Cenas').click();
    await settle();
    await answer('scene_list', { ok: true, code: 'OK', message: '', data: { scenes: [SCENE], invalid: [], canLoad } });
    await answer('scene_get', { ok: true, code: 'OK', message: '', data: { scene: SCENE, rows: [], unknownKeys: [] } });
  };
  return { ws, el, settle, answer, button, open, fixture };
}

describe('tela de Cenas', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Carregar só depois de comparar, sempre com o motivo; nunca envia scene_load sem prévia', async () => {
    const t = await boot();
    await t.open();
    expect(t.el.querySelector('.mx-scenes')!.textContent).toContain('Não são os snapshots da Soundcraft');
    expect(t.button('Carregar…').disabled).toBe(true);
    expect(t.el.querySelector('#load-hint')!.textContent).toContain('Comparar primeiro');
    t.button('Comparar').click();
    await t.settle();
    await t.answer('scene_compare', {
      ok: true,
      code: 'OK',
      message: '1 alteração',
      data: {
        previewId: 'pv-1',
        rows: [{ key: 'ch.9.main.level', group: 'PA', channel: 'Surdo', destination: 'PA', kind: 'level', current: -15, target: -12, deltaDB: 3, applicable: true }],
        totals: { changes: 1, applicable: 1, notApplicable: 0, byGroup: { PA: 1, FONES: 0, MASTER: 0, OUTROS: 0 } },
      },
    });
    expect(t.el.querySelector('.scene-compare tbody')!.textContent).toContain('+3 dB');
    expect(t.button('Carregar…').disabled).toBe(false);
    t.button('Carregar…').click();
    await t.settle();
    t.button('Pedir carregamento').click();
    await t.settle();
    const load = t.ws.last('command')!['command'] as Record<string, unknown>;
    expect(load).toEqual({ type: 'scene_load', id: 'cena-abc123', previewId: 'pv-1' });
  });

  it('fora do laboratório: Comparar e Salvar desabilitados, com o aviso', async () => {
    const t = await boot(false);
    await t.open();
    expect(t.button('Comparar').disabled).toBe(true);
    expect(t.button('Salvar estado atual').disabled).toBe(true);
    expect(t.el.querySelector('.scenes-note')!.textContent).toContain('Fora do laboratório');
    expect(t.el.querySelector('#load-hint')!.textContent).toContain('LABORATÓRIO');
  });

  it('importação recusada: o erro aparece com os detalhes; nada mais é enviado', async () => {
    const t = await boot();
    await t.open();
    const { ScenesUiService } = await import('./scenes.service');
    const svc = TestBed.inject(ScenesUiService);
    const p = svc.importText('{ quebrado');
    await t.settle();
    await t.answer('scene_import', { ok: false, code: 'INVALID', message: 'Cena recusada: o arquivo não é um JSON válido', data: { errors: ['a', 'b'] } });
    await p;
    await t.settle();
    expect(t.el.querySelector('[data-testid=scenes-notice]')!.textContent).toContain('não é um JSON válido');
    expect(t.ws.sent.filter((m) => m['type'] === 'command' && (m['command'] as { type: string }).type === 'scene_load')).toHaveLength(0);
  });
});
