import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';

/** Nenhuma rede: WebSocket e fetch são falsos. Cartões REAL só alcançam o servidor pelos endpoints de confirmação/cancelamento. */
type Mode = 'real' | 'lab';
async function boot(mode: Mode = 'real', role: 'operator' | 'musician' = 'operator') {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  const calls: Array<{ url: string; body: any }> = [];
  let handler: (url: string, body: any) => Promise<Response> | Response = () => new Response('{}', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (String(url).startsWith('/api/ui16/') && !String(url).includes('/mute-state')) calls.push({ url: String(url), body });
    return String(url).startsWith('/api/ui16/') ? handler(String(url), body) : new Response('{}', { status: 200 });
  }));
  const fixture = TestBed.createComponent(App);
  const session = TestBed.inject(SessionService);
  session.token.set('tok'); session.role.set(role);
  fixture.detectChanges(); await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!; ws.open();
  ws.receive({ ...hello(role), mode, assistant: { available: true, ai: false } });
  answerNames(ws); ws.receive(snapshot(0));
  await Promise.resolve(); fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); fixture.detectChanges(); };
  const say = async (text: string) => {
    const input = el.querySelector('.mx-assistant-input input') as HTMLInputElement;
    input.value = text; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    (el.querySelector('.mx-assistant-input button[type=submit]') as HTMLButtonElement).click();
    await settle(); return ws.last('assistant')!;
  };
  const reply = async (req: Record<string, unknown>, r: object) => { ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: r }); await settle(); };
  const serverId = (hello(role) as { serverId: string }).serverId;
  return { fixture, ws, el, say, reply, settle, calls, serverId, session, respond: (fn: typeof handler) => { handler = fn; } };
}
const card = (serverId: string, over: Record<string, unknown> = {}, rc: Record<string, unknown> = {}) => ({
  id: 'abc123def456', source: 'local', title: 'AUX 5: Cavaco', channel: 'Violão', destination: 'FONES', current: '−20.0 dB', change: '+1 dB', result: '−19.0 dB', needsApproval: true,
  expiresAt: new Date(Date.now() + 15_000).toISOString(),
  realControl: { targetMode: 'real', serverId, category: 'aux_level', confirmationPath: '/api/ui16/controls/abc123def456/confirm', cancelPath: '/api/ui16/controls/abc123def456/cancel', observed: -20, validation: 'simulated_transport', ...rc },
  ...over,
});
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (el: HTMLElement) => el.querySelector('.assist-log')!.textContent!;
const byId = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function withCard(mode: Mode = 'real', over: Record<string, unknown> = {}, rc: Record<string, unknown> = {}) {
  const b = await boot(mode); const req = await b.say('sobe 1 dB do cavaco nos fones');
  await b.reply(req, { kind: 'proposals', source: 'local', text: 'Proposta REAL: nada foi enviado.', proposals: [card(b.serverId, over, rc)] });
  return b;
}

describe('assistente: cartões REAL', () => {
  it('mostra modo REAL, valor anterior, proposto e observado; nada é enviado antes da confirmação', async () => {
    const { el, calls, ws } = await withCard();
    expect(byId(el, 'assist-mode')!.textContent).toContain('REAL');
    expect(byId(el, 'card-mode')!.textContent).toContain('REAL');
    expect(byId(el, 'card-current')!.textContent).toContain('−20.0');
    expect(byId(el, 'card-observed')!.textContent).toContain('−20.0');
    expect(byId(el, 'card-result')!.textContent).toContain('−19.0');
    expect(calls).toEqual([]); expect(ws.last('proposal_apply')).toBeUndefined();
  });
  it('confirmar usa SÓ o endpoint de confirmação da proposta (nunca o Aplicar legado) e mostra observed_target sem afirmar causalidade', async () => {
    const b = await withCard(); b.respond(() => json({ result: { ok: true, code: 'OK', message: 'ok' }, confirmation: { status: 'observed_target', previous: -20, requested: -19, observed: -19, causalAcknowledgement: false } }));
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]).toMatchObject({ url: '/api/ui16/controls/abc123def456/confirm', body: { targetMode: 'real', serverId: b.serverId, humanConfirmed: true } });
    expect(String(b.calls[0]!.body.requestId)).toMatch(/^ui-[A-Za-z0-9]+$/);
    expect(b.ws.last('proposal_apply')).toBeUndefined();
    expect(byId(b.el, 'card-state')!.textContent).toContain('observação recebida');
    expect(text(b.el)).toContain('−19.0 dB'); expect(text(b.el)).toContain('não prova que o MixAI causou');
  });
  it('unconfirmed: informa resultado incerto, sem repetir e sem desfazer sozinho', async () => {
    const b = await withCard(); b.respond(() => json({ result: { ok: false, code: 'OK', message: 'x' }, confirmation: { status: 'unconfirmed', previous: -20, requested: -19, observed: -20 } }));
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    expect(byId(b.el, 'card-state')!.textContent).toContain('NÃO confirmado'); expect(text(b.el)).toContain('Nada foi repetido');
    await new Promise(r => setTimeout(r, 30)); expect(b.calls).toHaveLength(1); expect(byId(b.el, 'card-undo')).toBeNull();
  });
  it('not_sent: informa que nada foi enviado', async () => {
    const b = await withCard(); b.respond(() => json({ result: { ok: false, code: 'CONFIRMATION_EXPIRED', message: 'Confirmação expirada. Faça nova prévia.' }, confirmation: { status: 'not_sent' } }));
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    expect(byId(b.el, 'card-state')!.textContent).toContain('Recusado'); expect(text(b.el)).toContain('Nada foi enviado');
  });
  it('perda de conexão/timeout: resultado incerto, nenhum reenvio automático', async () => {
    const b = await withCard(); b.respond(() => { throw new TypeError('network'); });
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    expect(byId(b.el, 'card-state')!.textContent).toContain('indeterminado'); expect(text(b.el)).toContain('PODE ter ocorrido');
    await new Promise(r => setTimeout(r, 30)); expect(b.calls).toHaveLength(1);
  });
  it('sessão encerrada durante a operação (401): resultado incerto, nada repetido', async () => {
    const b = await withCard(); b.respond(() => json({ code: 'UNAUTHORIZED' }, 401));
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    expect(byId(b.el, 'card-state')!.textContent).toContain('indeterminado'); expect(b.calls).toHaveLength(1);
  });
  it('cancelar descarta a prévia no servidor (endpoint de cancelamento) e nunca confirma', async () => {
    const b = await withCard(); byId(b.el, 'card-cancel')!.click(); await b.settle();
    expect(b.calls).toEqual([{ url: '/api/ui16/controls/abc123def456/cancel', body: { targetMode: 'real', serverId: b.serverId } }]);
    expect(byId(b.el, 'card-state')!.textContent).toContain('Cancelado'); expect(b.ws.last('proposal_cancel')).toBeUndefined();
    expect(byId(b.el, 'card-confirm')).toBeNull();
  });
  it('instância do servidor diferente da proposta: não envia', async () => {
    const b = await withCard('real', {}, { serverId: '00000000-0000-4000-8000-000000000000' });
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    expect(b.calls).toEqual([]); expect(text(b.el)).toContain('Nada foi enviado');
  });
  it('troca de sessão durante a confirmação descarta a resposta tardia', async () => {
    const b = await withCard(); let release!: (r: Response) => void; b.respond(() => new Promise<Response>(res => { release = res; }));
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    b.session.token.set('outra-sessao'); await b.settle();
    release(json({ confirmation: { status: 'observed_target', observed: -19, previous: -20, requested: -19 } })); await b.settle();
    expect(b.el.textContent).not.toContain('Observação recebida da mesa');
  });
  it('desfazer: só após observação, pede NOVA proposta ao assistente (nova confirmação) e não aparece no cartão de desfazer', async () => {
    const b = await withCard(); b.respond(() => json({ result: { ok: true, code: 'OK', message: 'ok' }, confirmation: { status: 'observed_target', previous: -20, requested: -19, observed: -19 } }));
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    byId(b.el, 'card-undo')!.click(); await b.settle();
    expect(b.ws.last('assistant')).toMatchObject({ text: 'Desfaz o último ajuste' }); expect(b.calls).toHaveLength(1);
    await b.reply(b.ws.last('assistant')!, { kind: 'proposals', source: 'local', proposals: [card(b.serverId, { id: '111111111111', title: 'Desfazer o último ajuste', destination: 'DESFAZER' }, { confirmationPath: '/api/ui16/controls/111111111111/confirm', cancelPath: '/api/ui16/controls/111111111111/cancel' })] });
    expect(b.el.querySelectorAll('[data-testid="card-confirm"]')).toHaveLength(1); expect(b.calls).toHaveLength(1);
  });
  it('cartão de EQ/HPF mostra "canal de entrada" e unidade própria, sem destino PA/AUX', async () => {
    const b = await boot(); const req = await b.say('muda o ganho da banda 2 do violão para 1 dB');
    await b.reply(req, { kind: 'proposals', source: 'local', proposals: [card(b.serverId, { id: '222222222222', title: 'EQ banda 2 · ganho', destination: 'CANAL', current: '0.0 dB', change: '0.0 dB → +1.0 dB', result: '+1.0 dB' }, { category: 'processing', unit: 'dB', observed: 0, confirmationPath: '/api/ui16/processing/222222222222/confirm', cancelPath: '/api/ui16/processing/222222222222/cancel' })] });
    expect(b.el.textContent).toContain('Canal de entrada (sem destino PA/AUX)'); expect(byId(b.el, 'card-mode')!.textContent).toContain('EQ/HPF do canal de entrada');
    expect(byId(b.el, 'card-observed')!.textContent).toContain('0.0 dB');
  });
  it('recurso REAL bloqueado pelo servidor: aviso claro e nenhum cartão', async () => {
    const b = await boot(); const req = await b.say('muta o violão no PA');
    await b.reply(req, { kind: 'error', source: 'local', code: 'REAL_READ_ONLY', text: 'Recurso REAL bloqueado ou recusado: Esta categoria REAL não foi habilitada pelo bootstrap confiável. Nada foi preparado ou enviado.' });
    expect(byId(b.el, 'real-blocked')!.textContent).toContain('Recurso REAL bloqueado'); expect(b.el.querySelector('.proposal')).toBeNull();
  });
  it('LAB: cartão simulado continua pelo Aplicar legado e o painel indica LAB', async () => {
    const b = await boot('lab'); const req = await b.say('sobe o surdo no PA');
    await b.reply(req, { kind: 'proposals', source: 'local', proposals: [{ id: 'c1', source: 'local', title: 'PA: Surdo', channel: 'Surdo', destination: 'PA', current: '−10.0 dB', change: '+2 dB', result: '−8.0 dB', needsApproval: false, expiresAt: new Date(Date.now() + 60_000).toISOString() }] });
    expect(byId(b.el, 'assist-mode')!.textContent).toContain('LAB'); expect(byId(b.el, 'card-mode')!.textContent).toContain('LAB · simulado');
    byId(b.el, 'card-confirm')!.click(); await b.settle();
    expect(b.ws.last('proposal_apply')).toMatchObject({ proposalId: 'c1' }); expect(b.calls).toEqual([]);
  });
});
