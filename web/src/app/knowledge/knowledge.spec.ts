import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';
import { KnowledgeAdminComponent } from './knowledge-admin.component';
import { KnowledgeAdminService } from './knowledge.service';
import { knowledgeView } from './knowledge-view';

const status = { store: { kind: 'file', ok: true, detail: 'arquivo local' }, ollama: { reachable: false, embedModel: false, chatModel: false, detail: 'Ollama indisponível', narrative: false }, sources: 2, documents: 1, chunks: 4, embeddedChunks: 0, mode: 'keyword', note: 'Busca por palavras (Ollama indisponível ou sem embeddings).' };
const mics = { verifiedModel: 'akg-p3s', bandMicModel: 'AKG Perception P3 S', safety: 'Não aplicar EQ uniforme.', models: { 'akg-p3s': { model: 'AKG Perception P3 S', pattern: 'cardioid' } }, assignments: { CH5: { musician: 'Leandro', modelId: null, role: 'backing', evidence: 'unconfirmed' }, CH3: { musician: 'Fred', modelId: 'akg-p3s', role: 'lead', evidence: 'operator_report' } } };

function boot(role = 'operator', routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }> = {}) {
  const live = { hello: signal({ serverId: 's', role, mode: 'lab' }), connection: signal('online') };
  const session = { token: signal<string | null>('token-test') };
  const defaults: Record<string, (init?: RequestInit) => { status?: number; body: unknown }> = {
    '/api/knowledge/status': () => ({ body: status }),
    '/api/knowledge/sources': () => ({ body: { sources: [{ id: 'akg-p3', title: 'AKG P3 S', url: 'https://br.akg.com/P3.html', downloaded: false, documents: 0, local: false }] } }),
    '/api/knowledge/documents': () => ({ body: { documents: [{ id: 'dabc', sourceId: 'akg-p3', fileName: 'akg-p3.md', chunks: 4, embedded: 0, ingestedAt: '2026-11-07T00:00:00Z' }] } }),
    '/api/knowledge/microphones': () => ({ body: mics }),
    ...routes,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = defaults[String(input)];
    const r = handler ? handler(init) : { status: 404, body: { code: 'NOT_FOUND' } };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  TestBed.configureTestingModule({ providers: [{ provide: LiveService, useValue: live }, { provide: SessionService, useValue: session }] });
  const svc = TestBed.inject(KnowledgeAdminService);
  const f = TestBed.createComponent(KnowledgeAdminComponent);
  f.detectChanges();
  return { f, svc, live, session, fetchMock, el: f.nativeElement as HTMLElement };
}
const settle = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
  // O fetch falso resolve em microtarefas encadeadas: cede ao laço de eventos algumas vezes.
  for (let i = 0; i < 4; i++) { await f.whenStable(); await new Promise((r) => setTimeout(r, 0)); f.detectChanges(); }
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('knowledgeView (validação do que o servidor envia)', () => {
  it('limita tamanhos, descarta trechos incompletos e só mostra resumo marcado como não verificado', () => {
    const v = knowledgeView({
      mode: 'keyword', degraded: true, reason: 'x'.repeat(500),
      passages: [{ title: 'AKG', url: 'https://br.akg.com/P3.html', locator: 'p.1', excerpt: 'texto' }, { title: '', excerpt: 'sem título' }, { title: 'sem trecho' }, ...Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, excerpt: `e${i}` }))],
      microphone: { channel: 'CH3', musician: 'Fred', model: 'AKG Perception P3 S', evidence: 'operator_report', note: 'Não aplicar EQ uniforme.' },
      caseRef: { id: 'microfonia', title: 'Microfonia' }, narrative: { text: 'Resumo teórico.', source: 'ollama', verified: false },
    })!;
    expect(v.reason!.length).toBe(160);
    expect(v.passages.length).toBe(6);
    expect(v.passages[0]).toMatchObject({ title: 'AKG', locator: 'p.1' });
    expect(v.microphone).toMatchObject({ channel: 'CH3', model: 'AKG Perception P3 S' });
    expect(v.caseTitle).toBe('Microfonia');
    expect(v.narrative).toBe('Resumo teórico.');
    expect(knowledgeView({ mode: 'keyword', passages: [], narrative: { text: 'afirma ser verificado', verified: true } })!.narrative).toBeUndefined();
  });
  it('formato inesperado vira nada, nunca erro', () => {
    for (const bad of [undefined, null, 5, 'x', [], { mode: 'outro' }, { passages: 'não-lista' }]) expect(knowledgeView(bad)).toBeUndefined();
    expect(knowledgeView({ mode: 'deterministic', passages: 'não-lista', microphone: 'x' })).toMatchObject({ mode: 'deterministic', passages: [] });
  });
});

describe('painel de administração', () => {
  it('operador vê o estado, a base em arquivo, o Ollama desligado e o modo de busca', async () => {
    const { f, el } = boot(); await settle(f);
    expect(el.textContent).toContain('Base de conhecimento');
    expect(el.textContent).toContain('Base: arquivo local');
    expect(el.textContent).toContain('Ollama: desligado');
    expect(el.textContent).toContain('Busca: por palavras');
  });
  it('base desligada no servidor (404) esconde a seção sem erro', async () => {
    const { f, el, svc } = boot('operator', { '/api/knowledge/status': () => ({ status: 404, body: { code: 'NOT_FOUND' } }) }); await settle(f);
    expect(svc.available()).toBe(false); expect(el.querySelector('.knowledge-admin')).toBeNull(); expect(svc.error()).toBe('');
  });
  it('resposta fora do formato também esconde a seção', async () => {
    const { f, el } = boot('operator', { '/api/knowledge/status': () => ({ body: {} }) }); await settle(f);
    expect(el.querySelector('.knowledge-admin')).toBeNull();
  });
  it('músico nunca consulta a administração', async () => {
    const { f, fetchMock, el } = boot('musician'); await settle(f);
    expect(fetchMock).not.toHaveBeenCalled(); expect(el.querySelector('.knowledge-admin')).toBeNull();
  });
  it('lista microfones por canal e confirma o modelo com o corpo exato, sem tocar na mesa', async () => {
    const post = vi.fn((init?: RequestInit) => ({ body: { assignment: JSON.parse(String(init?.body)) } }));
    const { f, el, svc, fetchMock } = boot('operator', { '/api/knowledge/microphones': (init) => (init?.method === 'POST' ? post(init) : { body: mics }) });
    await settle(f); svc.open.set(true); f.detectChanges();
    const rows = Array.from(el.querySelectorAll('.knowledge-table tbody tr')).map((r) => r.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('CH3'); expect(rows[0]).toContain('Fred'); expect(rows[0]).toContain('relato do operador');
    expect(rows[1]).toContain('CH5'); expect(rows[1]).toContain('não confirmado');
    const select = el.querySelector('select[aria-label="Modelo do microfone no CH5"]') as HTMLSelectElement;
    select.value = 'akg-p3s'; select.dispatchEvent(new Event('change')); await settle(f);
    expect(JSON.parse(String(post.mock.calls[0]![0]!.body))).toEqual({ channel: 5, modelId: 'akg-p3s' });
    expect(fetchMock.mock.calls.every(([path]) => String(path).startsWith('/api/knowledge'))).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => /command|fader|assistant/.test(String(path)))).toBe(false);
  });
  it('POST sempre leva corpo JSON (o servidor recusa corpo vazio) e DELETE não', async () => {
    const seen: Array<{ method?: string; body?: unknown; ct?: string }> = [];
    const spy = (init?: RequestInit) => { seen.push({ method: init?.method, body: init?.body, ct: (init?.headers as Record<string, string>)?.['content-type'] }); return { body: { items: [], documents: [] } }; };
    const { f, svc } = boot('operator', { '/api/knowledge/import-seed': spy, '/api/knowledge/ingest': spy, '/api/knowledge/documents/dabc': spy });
    await settle(f);
    await svc.importSeed(); await svc.runIngest(); await svc.removeDocument('dabc');
    expect(seen[0]).toEqual({ method: 'POST', body: '{}', ct: 'application/json' });
    expect(seen[1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(seen[2]).toEqual({ method: 'DELETE', body: undefined, ct: undefined });
  });
  it('mostra o resultado da pesquisa como texto (sem executar HTML) e links só http(s)', async () => {
    const { f, el, svc } = boot('operator', { '/api/knowledge/search': () => ({ body: { mode: 'keyword', passages: [
      { title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', locator: 'p.2', excerpt: '<script>bad()</script> cardioide' },
      { title: 'AKG P3 S', url: 'https://br.akg.com/P3.html', locator: 'p.1', excerpt: 'padrão cardioide' }] } }) });
    await settle(f); svc.open.set(true); f.detectChanges();
    await svc.search('cardioide'); await settle(f);
    expect(el.querySelector('script')).toBeNull(); expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<script>bad()</script> cardioide');
    const hrefs = Array.from(el.querySelectorAll('.knowledge-passages a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://br.akg.com/P3.html']);
  });
  it('erro do servidor aparece sem detalhes técnicos; sair da sessão limpa tudo', async () => {
    const { f, el, svc, session } = boot('operator', { '/api/knowledge/ingest': () => ({ status: 500, body: { code: 'UNAVAILABLE', stack: 'C:\\segredo' } }) });
    await settle(f); svc.open.set(true); f.detectChanges();
    await svc.runIngest(); f.detectChanges();
    expect(svc.error()).toContain('motor determinístico'); expect(el.textContent).not.toContain('segredo');
    session.token.set(null); f.detectChanges(); await settle(f);
    expect(svc.available()).toBe(false); expect(svc.status()).toBeNull(); expect(svc.mics()).toBeNull();
  });
});

describe('chat: fontes locais dentro dos detalhes técnicos', () => {
  async function chat() {
    FakeSocket.all = [];
    LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const fixture = TestBed.createComponent(App);
    const session = TestBed.inject(SessionService); session.token.set('tok'); session.role.set('operator');
    fixture.detectChanges(); await fixture.whenStable();
    const ws = FakeSocket.all.at(-1)!; ws.open(); ws.receive({ ...hello('operator'), assistant: { available: true, ai: false } }); answerNames(ws); ws.receive(snapshot(0));
    await Promise.resolve(); fixture.detectChanges();
    return { fixture, ws, el: fixture.nativeElement as HTMLElement };
  }
  async function ask(c: Awaited<ReturnType<typeof chat>>, knowledge: unknown) {
    const input = c.el.querySelector('.mx-assistant-input input') as HTMLInputElement;
    input.value = 'Fred está microfonando no PA'; input.dispatchEvent(new Event('input')); c.fixture.detectChanges();
    (c.el.querySelector('.mx-assistant-input button[type=submit]') as HTMLButtonElement).click();
    await Promise.resolve(); await Promise.resolve();
    const req = c.ws.last('assistant')!;
    c.ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'diagnosis', source: 'local', text: 'Fonte: Voz Fred (canal 3). Destino: PA.\nConsulta somente leitura.', knowledge } });
    await Promise.resolve(); await Promise.resolve(); c.fixture.detectChanges();
  }
  it('mostra trechos, ficha do microfone e resumo marcado como não verificado', async () => {
    const c = await chat();
    await ask(c, { mode: 'keyword', degraded: true, reason: 'Ollama indisponível: busca por palavras.', passages: [{ title: 'Shure', url: 'https://www.shure.com/x.pdf', locator: 'p.22', excerpt: 'Posicione o microfone.' }],
      microphone: { channel: 'CH3', musician: 'Fred', model: 'AKG Perception P3 S', evidence: 'operator_report', note: 'AKG Perception P3 S (relato do operador).' }, caseRef: { id: 'microfonia', title: 'Microfonia' }, narrative: { text: 'Teoria a conferir.', source: 'ollama', verified: false } });
    const block = c.el.querySelector('.knowledge-block')!;
    expect(block).not.toBeNull();
    expect(block.textContent).toContain('busca por palavras'); expect(block.textContent).toContain('Ollama indisponível');
    expect(block.textContent).toContain('CH3 Fred'); expect(block.textContent).toContain('Shure'); expect(block.textContent).toContain('não verificado');
    expect(block.closest('details.technical-details')).not.toBeNull();
    expect(c.el.querySelectorAll('.card-actions button').length).toBe(0);
  });
  it('sem o campo knowledge o chat é idêntico ao de antes', async () => {
    const c = await chat();
    await ask(c, undefined);
    expect(c.el.querySelector('.knowledge-block')).toBeNull();
    expect(c.el.querySelector('details.technical-details')).not.toBeNull();
  });
  it('campo knowledge malformado não quebra a tela', async () => {
    const c = await chat();
    await ask(c, { mode: 42, passages: 'x' });
    expect(c.el.querySelector('.knowledge-block')).toBeNull();
    expect(c.el.textContent).toContain('Consulta somente leitura');
  });
});
