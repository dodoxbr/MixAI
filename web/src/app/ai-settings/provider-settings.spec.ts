import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { LegacyProviderSettings, ProviderSettingsError, legacySnapshot } from './legacy-provider-settings';
import { PROVIDER_SETTINGS_PORT, type ProviderSettingsPort, type ProviderSettingsSnapshot, trustedAmount, validModelId } from './provider-settings-port';
import { ProviderSettingsComponent } from './provider-settings.component';
import { ProviderSettingsService } from './provider-settings.service';

const raw = () => ({
  chat: { selected: 'ollama', options: [
    { id: 'ollama', external: false, configured: true },
    { id: 'gemini', external: true, configured: true },
    { id: 'deepseek', external: true, configured: false, model: 'ds-a', models: ['ds-a', 'ds-b'] },
    { id: 'anthropic', external: true, configured: true, model: 'claude-a', models: ['claude-a', 'claude-b'] },
  ] }, narrative: true, embed: { id: 'ollama', external: false }, externalFallback: 'ollama',
});
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function boot(opts: { load?: ProviderSettingsPort['load']; select?: ProviderSettingsPort['select'] } = {}) {
  const session = { token: signal<string | null>('test-session') };
  const live = { hello: signal({ serverId: 'one', role: 'operator' }), connection: signal('online') };
  const port: ProviderSettingsPort = { load: vi.fn(opts.load ?? (async () => legacySnapshot(raw()))), select: vi.fn(opts.select ?? (async () => { throw new ProviderSettingsError('INVALID'); })) };
  TestBed.configureTestingModule({ providers: [{ provide: SessionService, useValue: session }, { provide: LiveService, useValue: live }] });
  TestBed.overrideComponent(ProviderSettingsComponent, { set: { providers: [
    // Keep the real state machine; replace only its transport boundary.
    { provide: PROVIDER_SETTINGS_PORT, useValue: port },
    ProviderSettingsService,
  ] } });
  const fixture = TestBed.createComponent(ProviderSettingsComponent); fixture.detectChanges();
  return { fixture, s: fixture.componentInstance.s, port, session, live, el: fixture.nativeElement as HTMLElement };
}
async function settle(f: ReturnType<typeof boot>['fixture']) {
  for (let i = 0; i < 3; i++) { await Promise.resolve(); f.detectChanges(); }
}
afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('adaptador de compatibilidade dos provedores', () => {
  it('lista os cinco, distingue configuração de conexão e não inventa modelo, custo ou OpenAI', () => {
    const view = legacySnapshot({ ...raw(), budget: 500, connected: true, price: 0 });
    expect(view.options.map(o => o.id)).toEqual(['ollama', 'gemini', 'deepseek', 'anthropic', 'openai']);
    expect(view.options[1]).toMatchObject({ status: 'configured', model: null, modelMode: 'server_only' });
    expect(view.options[2]!.status).toBe('not_configured');
    expect(view.options[4]).toMatchObject({ status: 'unavailable', selectable: false });
    expect(view.budget).toBeNull(); expect(view.consumed).toBeNull();
    expect(view.options.every(o => o.price === null)).toBe(true);
  });
  it('rejeita formatos inválidos, IDs duplicados, escala externa falsa e modelos indevidos', () => {
    for (const value of [null, {}, { chat: raw().chat }, { ...raw(), chat: { ...raw().chat, selected: 'openai' } },
      { ...raw(), chat: { ...raw().chat, options: [...raw().chat.options, raw().chat.options[0]] } },
      { ...raw(), chat: { selected: 'ollama', options: [{ id: 'ollama', configured: true, external: true }] } },
      { ...raw(), chat: { selected: 'ollama', options: [{ id: 'ollama', configured: true, external: false, models: ['bad model'] }] } }]) {
      expect(() => legacySnapshot(value)).toThrow('INVALID_RESPONSE');
    }
  });
  it('a chamada real usa somente a API same-origin e o corpo legado, sem persistir o aceite', async () => {
    const session = { token: signal<string | null>('fixture-token') };
    TestBed.configureTestingModule({ providers: [{ provide: SessionService, useValue: session }] });
    const fetch = vi.fn(async () => new Response(JSON.stringify(raw()))); vi.stubGlobal('fetch', fetch);
    await TestBed.inject(LegacyProviderSettings).select({ provider: 'anthropic', model: 'claude-b', confirmExternal: true }, new AbortController().signal);
    expect(fetch).toHaveBeenCalledWith('/api/knowledge/providers', expect.objectContaining({ method: 'POST', credentials: 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error', body: JSON.stringify({ chat: 'anthropic', confirmExternal: true, model: 'claude-b' }) }));
    await expect(TestBed.inject(LegacyProviderSettings).select({ provider: 'openai', confirmExternal: true }, new AbortController().signal)).rejects.toThrow('UNSUPPORTED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('recusa sessão trocada e nunca expõe o corpo de erro do servidor', async () => {
    const session = { token: signal<string | null>('old') }; const response = deferred<Response>();
    TestBed.configureTestingModule({ providers: [{ provide: SessionService, useValue: session }] });
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const work = TestBed.inject(LegacyProviderSettings).load(new AbortController().signal);
    session.token.set('new'); response.resolve(new Response(JSON.stringify(raw())));
    await expect(work).rejects.toThrow('STALE');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"private detail"}', { status: 401 })));
    await expect(TestBed.inject(LegacyProviderSettings).load(new AbortController().signal)).rejects.toThrow('UNAUTHORIZED');
  });
  it('IDs manuais e valores monetários exigem sintaxe e proveniência válidas', () => {
    expect(validModelId('org/model:latest')).toBe(true);
    for (const id of ['', '../model', 'bad model', '<script>', 'a'.repeat(161)]) expect(validModelId(id)).toBe(false);
    const good = { source: 'backend', currency: 'USD', value: 0, asOf: '2026-11-10T00:00:00Z' } as const;
    expect(trustedAmount(good)).toBe(good);
    for (const value of [-1, Infinity, NaN]) expect(trustedAmount({ ...good, value })).toBeNull();
    expect(trustedAmount({ ...good, asOf: 'unknown' })).toBeNull();
  });
});

describe('Configurações → Inteligência Artificial', () => {
  it('mostra seleção real, cinco provedores, custo desconhecido e ausência de chave', async () => {
    const { fixture: f, el, s, port } = boot(); await settle(f);
    expect(el.querySelectorAll('input[type=radio]').length).toBe(5);
    expect(el.textContent).toContain('Modelo não informado pela API');
    s.choose('deepseek'); f.detectChanges();
    expect(el.textContent).toContain('Não configurado. Falta configurar a chave');
    expect(el.textContent).toContain('Custo desconhecido'); expect(s.canSave()).toBe(false);
    expect(port.select).not.toHaveBeenCalled();
    s.choose('openai'); f.detectChanges();
    expect(el.textContent).toContain('Provedor indisponível nesta versão'); expect(s.canSave()).toBe(false);
  });
  it('exige novo consentimento por provedor/modelo e só altera o ativo após confirmação do servidor', async () => {
    const save = deferred<ProviderSettingsSnapshot>();
    const { fixture: f, el, s, port } = boot({ select: () => save.promise }); await settle(f);
    s.choose('anthropic'); expect(s.canSave()).toBe(false);
    s.consent.set(true); expect(s.canSave()).toBe(true);
    s.chooseModel('claude-b'); expect(s.consent()).toBe(false);
    s.consent.set(true); const work = s.save(); f.detectChanges();
    expect(s.snapshot()).toBeNull(); expect(el.textContent).toContain('Consultando seleção ativa');
    expect(port.select).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-b', confirmExternal: true }, expect.any(AbortSignal));
    const next = legacySnapshot(raw()); next.active = { provider: 'anthropic', model: 'claude-b' }; save.resolve(next); await work; f.detectChanges();
    expect(s.snapshot()?.active.provider).toBe('anthropic'); expect(s.notice()).toContain('confirmada pelo servidor'); expect(s.consent()).toBe(false);
    expect(el.textContent).toContain('não revoga um aceite');
  });
  it('pode voltar ao Ollama sem consentimento e não envia um modelo ausente na API', async () => {
    const { fixture: f, s, port } = boot({ select: async () => legacySnapshot(raw()) }); await settle(f);
    await s.save();
    expect(port.select).toHaveBeenCalledWith({ provider: 'ollama', confirmExternal: false }, expect.any(AbortSignal));
  });
  it('não finge ID editável quando a API legada não admite modelo manual; informa limite Gemini', async () => {
    const { fixture: f, s, el } = boot(); await settle(f); s.choose('gemini'); f.detectChanges();
    expect((el.querySelector('#ai-model-id') as HTMLInputElement).readOnly).toBe(true);
    expect(el.textContent).toContain('Gemini mantém a seleção confirmada entre sessões');
    s.chooseModel('not-offered'); s.consent.set(true); expect(s.canSave()).toBe(false);
  });
  it('consome modelo manual, estado conectado e preços apenas pelo contrato isolado futuro', async () => {
    const view = legacySnapshot(raw()); view.sessionConsent = 'server_enforced';
    view.options = view.options.map(o => o.id === 'openai' ? { ...o, selectable: true, status: 'connected', modelMode: 'manual', model: 'org/model', price: { model: 'org/model', inputPerMillion: { source: 'backend', currency: 'USD', value: 1.25, asOf: '2026-11-10' }, outputPerMillion: { source: 'backend', currency: 'USD', value: 2.5, asOf: '2026-11-10' } } } : o);
    const { fixture: f, el, s, port } = boot({ load: async () => view, select: async () => view }); await settle(f);
    s.choose('openai'); f.detectChanges();
    expect((el.querySelector('#ai-model-id') as HTMLInputElement).readOnly).toBe(false);
    expect(el.textContent).toContain('Conectado'); expect(el.textContent).toContain('por milhão de tokens');
    s.chooseModel('bad model'); s.consent.set(true); expect(s.canSave()).toBe(false);
    s.chooseModel('org/model'); s.consent.set(true); await s.save();
    expect(port.select).toHaveBeenCalledWith({ provider: 'openai', model: 'org/model', confirmExternal: true }, expect.any(AbortSignal));
    s.chooseModel('another-model'); f.detectChanges(); expect(el.textContent).not.toContain('por milhão de tokens');
  });
  it('exibe erro sanitizado de modelo e mantém a seleção desconhecida após POST recusado', async () => {
    const { fixture: f, el, s } = boot({ select: async () => { throw new ProviderSettingsError('MODEL_UNAVAILABLE'); } }); await settle(f);
    s.choose('anthropic'); s.consent.set(true); await s.save(); f.detectChanges();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Modelo indisponível');
    expect(s.snapshot()).toBeNull(); expect(el.textContent).not.toContain('confirmada pelo servidor');
  });
  it('apresenta ausência de API/erro de rede sem simular sucesso', async () => {
    const { fixture: f, s, el } = boot({ load: async () => { throw new ProviderSettingsError('UNSUPPORTED'); } }); await settle(f);
    expect(s.snapshot()).toBeNull(); expect(el.textContent).toContain('não disponível nesta versão');
    expect(s.canSave()).toBe(false);
  });
  it('invalida consentimento e respostas tardias após revogação, troca de sessão ou desconexão', async () => {
    const save = deferred<ProviderSettingsSnapshot>();
    const { fixture: f, s, session, live } = boot({ select: () => save.promise }); await settle(f);
    s.choose('anthropic'); s.consent.set(true); const work = s.save();
    session.token.set(null); live.connection.set('offline'); f.detectChanges();
    save.resolve(legacySnapshot(raw())); await work; await settle(f);
    expect(s.snapshot()).toBeNull(); expect(s.consent()).toBe(false); expect(s.canSave()).toBe(false);
  });
  it('não transfere um checkbox antigo para outra sessão antes de o effect limpar a tela', async () => {
    const { fixture: f, s, session, port } = boot(); await settle(f);
    s.choose('anthropic'); s.consent.set(true); expect(s.canSave()).toBe(true);
    session.token.set('different-session'); await s.save();
    expect(port.select).not.toHaveBeenCalled(); expect(s.canSave()).toBe(false);
    await settle(f); expect(s.consent()).toBe(false);
  });
  it('informa resposta lenta e timeout sem manter seleção presumida ou repetir POST', async () => {
    vi.useFakeTimers(); const wait = deferred<ProviderSettingsSnapshot>();
    const { fixture: f, el, s, port } = boot({ load: () => wait.promise }); await settle(f);
    await vi.advanceTimersByTimeAsync(3001); f.detectChanges(); expect(el.textContent).toContain('Resposta lenta');
    await vi.advanceTimersByTimeAsync(22_000); f.detectChanges();
    expect(s.error()).toContain('demorou demais'); expect(s.snapshot()).toBeNull();
    wait.resolve(legacySnapshot(raw())); await settle(f); expect(s.snapshot()).toBeNull();
    expect(port.load).toHaveBeenCalledTimes(1); expect(port.select).not.toHaveBeenCalled();
  });
  it('cancelar não aplica resposta atrasada e fechar não persiste o checkbox', async () => {
    const wait = deferred<ProviderSettingsSnapshot>();
    const { fixture: f, s } = boot({ load: () => wait.promise }); await settle(f);
    s.cancel(); wait.resolve(legacySnapshot(raw())); await settle(f);
    expect(s.snapshot()).toBeNull(); expect(s.notice()).toContain('não revoga');
    const closed = vi.fn(); f.componentInstance.closed.subscribe(closed);
    f.nativeElement.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })); expect(closed).toHaveBeenCalledOnce();
    f.destroy();
  });
  it('cancelar encerra a espera mesmo se o port ignorar AbortSignal, sem repetir a seleção', async () => {
    const { fixture: f, s, port } = boot({ select: () => new Promise(() => {}) }); await settle(f);
    s.choose('anthropic'); s.consent.set(true);
    const work = s.save(); s.cancel(); await work;
    expect(s.busy()).toBe(false); expect(s.snapshot()).toBeNull(); expect(s.consent()).toBe(false);
    expect(port.select).toHaveBeenCalledTimes(1);
  });
});
