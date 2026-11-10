import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { catalogFixture } from '../../testing/catalog-fixture';
import { CatalogProviderSettings, ProviderSettingsError, catalogSnapshot, catalogValidation } from './catalog-provider-settings';
import { PROVIDER_SETTINGS_PORT, type ProviderSettingsPort, type ProviderSettingsSnapshot, type ModelValidation, validModelId } from './provider-settings-port';
import { ProviderSettingsComponent } from './provider-settings.component';
import { ProviderSettingsService } from './provider-settings.service';
const deferred = <T>() => { let resolve!: (v:T)=>void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
const validated = (): ModelValidation => ({ schemaVersion: 1, provider: 'openai', model: 'custom-id', validation: 'provider_confirmed', price: null, generationAllowed: false });
function selected(revision=1): ProviderSettingsSnapshot {
  return { ...catalogFixture(), revision, selection: { provider: 'openai', model: 'custom-id', revision, validation: 'provider_confirmed', external: true }, consent: { required: true, granted: true } };
}
function boot(overrides: Partial<ProviderSettingsPort> = {}) {
  const session = { token: signal<string|null>('fixture-token') };
  const live = { hello: signal({ serverId: 'one', role: 'operator', mode: 'lab' }), connection: signal('online') };
  const port: ProviderSettingsPort = { load: vi.fn(async()=>catalogFixture()), validate: vi.fn(async()=>validated()), select: vi.fn(async()=>selected()), clear: vi.fn(async()=>({...catalogFixture(),revision:2})), ...overrides };
  TestBed.configureTestingModule({ providers: [{provide:SessionService,useValue:session},{provide:LiveService,useValue:live}] });
  TestBed.overrideComponent(ProviderSettingsComponent,{set:{providers:[ProviderSettingsService,{provide:PROVIDER_SETTINGS_PORT,useValue:port}]}});
  const f=TestBed.createComponent(ProviderSettingsComponent);f.detectChanges();
  return { f, s:f.componentInstance.s, port, session, live, el:f.nativeElement as HTMLElement };
}
async function settle(f:ReturnType<typeof boot>['f']) {for(let i=0;i<4;i++){await Promise.resolve();f.detectChanges();}}
afterEach(()=>{TestBed.resetTestingModule();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('wire catálogo v1',()=>{
  it('valida configuração/seleção/revisão/consentimento/preços sem converter configuração em conexão',()=>{
    expect(catalogSnapshot(catalogFixture())).toEqual(catalogFixture());
    expect(catalogSnapshot(selected()).selection?.model).toBe('custom-id');
    for(const bad of [null,{}, {...catalogFixture(),mode:'REAL'},{...selected(),revision:0}, {...catalogFixture(),consent:{required:false,granted:true}}, {...catalogFixture(),usage:{...catalogFixture().usage,costUSD:-1}}, {...catalogFixture(),providers:[{...catalogFixture().providers[0],external:true}]}]) expect(()=>catalogSnapshot(bad)).toThrow('INVALID_RESPONSE');
    const choice={provider:'openai' as const,model:'custom-id',confirmExternal:true};
    expect(catalogValidation(validated(),choice).validation).toBe('provider_confirmed');
    expect(()=>catalogValidation({...validated(),model:'other'},choice)).toThrow('INVALID_RESPONSE');
  });
  it('espelha os formatos distintos de ID de Ollama e externos',()=>{
    expect(validModelId('ollama','team/model:latest')).toBe(true);
    expect(validModelId('openai','future-model-v2')).toBe(true);
    for(const model of ['','../model','a//b','https://x','a b','x'.repeat(129)])expect(validModelId('ollama',model)).toBe(false);
    for(const model of ['a','team/model','ft:model','x'.repeat(81)])expect(validModelId('openai',model)).toBe(false);
  });
  it('usa todas as rotas reais, versão e revisão sem alcançar knowledge/providers ou complete',async()=>{
    const session={token:signal<string|null>('fixture')};TestBed.configureTestingModule({providers:[{provide:SessionService,useValue:session}]});
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).endsWith('/validate')?validated():catalogFixture()));vi.stubGlobal('fetch',fetchMock);
    const port=TestBed.inject(CatalogProviderSettings), abort=new AbortController().signal;
    const choice={provider:'openai' as const,model:'custom-id',confirmExternal:true};
    await port.load(abort);await port.validate(choice,abort);await port.select(choice,4,abort);await port.clear(5,abort);
    expect(fetchMock.mock.calls.map(c=>String(c[0]))).toEqual(['/api/ai/models','/api/ai/models/validate','/api/ai/models/selection','/api/ai/models/selection']);
    const calls=(fetchMock.mock.calls as unknown as Array<[string,RequestInit]>);
    expect(calls[1]![1]).toMatchObject({method:'POST',body:JSON.stringify({schemaVersion:1,...choice}),mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error'});
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({schemaVersion:1,...choice,expectedRevision:4});
    expect(calls[3]![1]).toMatchObject({method:'DELETE',body:JSON.stringify({schemaVersion:1,expectedRevision:5})});
  });
  it.each([[401,'UNAUTHORIZED'],[404,'UNSUPPORTED'],[409,'STALE'],[422,'MODEL_UNAVAILABLE'],[429,'BUDGET'],[503,'NOT_CONFIGURED']])('erro %s é sanitizado e preserva código conhecido',async(status,code)=>{
    TestBed.configureTestingModule({providers:[{provide:SessionService,useValue:{token:signal('fixture')}}]});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({schemaVersion:1,code,message:'PRIVATE ERROR'},{status:status as number})));
    await expect(TestBed.inject(CatalogProviderSettings).load(new AbortController().signal)).rejects.toThrow(code as string);
  });
});
describe('painel catálogo',()=>{
  it('mostra seleção vazia real, cinco provedores, configurações e agregado UTC sem confundir fluxos',async()=>{
    const {f,s,el}=boot();await settle(f);
    expect(el.querySelectorAll('input[type=radio]').length).toBe(5);
    expect(el.textContent).toContain('Nenhum modelo selecionado');expect(el.textContent).toContain('responde ao resumo do diagnóstico/RAG e ao planejador do AutoConfig');
    expect(el.textContent).toContain('compartilhado (UTC)');expect(el.textContent).toContain('reservas em andamento');
    s.choose('deepseek');f.detectChanges();expect(el.textContent).toContain('Falta configurar a chave');expect(s.canSave()).toBe(false);
    s.choose('anthropic');f.detectChanges();expect(el.textContent).toContain('Provedor desabilitado');
  });
  it('ID manual fora das sugestões é permitido; validar não seleciona nem concede consentimento',async()=>{
    const {f,s,el,port}=boot();await settle(f);s.choose('openai');s.chooseModel('custom-id');f.detectChanges();
    expect((el.querySelector('#ai-model-id') as HTMLInputElement).readOnly).toBe(false);
    expect(s.canSave()).toBe(false);s.consent.set(true);await s.validate();f.detectChanges();
    expect(port.validate).toHaveBeenCalledWith({provider:'openai',model:'custom-id',confirmExternal:true},expect.any(AbortSignal));
    expect(s.snapshot()?.selection).toBeNull();expect(s.snapshot()?.consent.granted).toBe(false);expect(s.consent()).toBe(false);
    expect(el.textContent).toContain('Custo desconhecido');expect(el.textContent).toContain('não seleciona');
    expect(port.select).not.toHaveBeenCalled();
  });
  it('seleção usa revisão do servidor, novo aceite e renderiza o estado concedido somente após resposta',async()=>{
    const pending=deferred<ProviderSettingsSnapshot>();const {f,s,port}=boot({select:vi.fn(()=>pending.promise)});await settle(f);
    s.choose('openai');s.chooseModel('custom-id');s.consent.set(true);const work=s.save();
    expect(s.snapshot()).toBeNull();expect(port.select).toHaveBeenCalledWith({provider:'openai',model:'custom-id',confirmExternal:true},0,expect.any(AbortSignal));
    pending.resolve(selected());await work;f.detectChanges();expect(s.snapshot()?.consent.granted).toBe(true);expect(s.consent()).toBe(false);
    s.chooseModel('different');expect(s.validation()).toBeNull();expect(s.canSave()).toBe(false);
  });
  it('limpeza efetiva usa DELETE com revisão e confirma seleção vazia/revogação apenas pelo servidor',async()=>{
    const {f,s,port,el}=boot({load:vi.fn(async()=>selected())});await settle(f);expect(s.canClear()).toBe(true);
    await s.clear();f.detectChanges();expect(port.clear).toHaveBeenCalledWith(1,expect.any(AbortSignal));expect(s.snapshot()?.consent.granted).toBe(false);expect(s.snapshot()?.selection).toBeNull();expect(el.textContent).toContain('limpos pelo servidor');
  });
  it('pode limpar enquanto seleção está pendente e não restaura a resposta atrasada',async()=>{
    const pending=deferred<ProviderSettingsSnapshot>();const {f,s,port}=boot({select:vi.fn(()=>pending.promise)});await settle(f);
    s.choose('openai');s.chooseModel('custom-id');s.consent.set(true);const selecting=s.save();expect(s.canClear()).toBe(true);
    await s.clear();pending.resolve(selected());await selecting;expect(s.snapshot()?.selection).toBeNull();expect(port.clear).toHaveBeenCalledWith(0,expect.any(AbortSignal));
  });
  it('cancelar uma seleção ainda permite limpar a revisão conhecida para impedir concessão tardia',async()=>{
    const pending=deferred<ProviderSettingsSnapshot>();const {f,s,port}=boot({select:vi.fn(()=>pending.promise)});await settle(f);
    s.choose('openai');s.chooseModel('custom-id');s.consent.set(true);const work=s.save();s.cancel();await work;
    expect(s.canClear()).toBe(true);await s.clear();pending.resolve(selected());await settle(f);
    expect(port.clear).toHaveBeenCalledWith(0,expect.any(AbortSignal));expect(s.snapshot()?.selection).toBeNull();
  });
  it.each(['STALE','NOT_CONSENTED','MODEL_UNAVAILABLE'])('erro %s não deixa seleção otimista nem repete a operação',async code=>{
    const select=vi.fn(async()=>{throw new ProviderSettingsError(code);});const {f,s}=boot({select});await settle(f);s.choose('openai');s.chooseModel('custom-id');s.consent.set(true);await s.save();expect(s.error()).not.toBe('');expect(s.snapshot()).toBeNull();expect(select).toHaveBeenCalledOnce();
  });
  it('revogação recebida no GET é exibida sem herdar o aceite e sem religar concessão',async()=>{
    const view=selected();view.consent.granted=false;const {f,s,el,port}=boot({load:vi.fn(async()=>view)});await settle(f);expect(el.textContent).toContain('ausente ou revogado');expect(s.consent()).toBe(false);expect(port.select).not.toHaveBeenCalled();
  });
  it('token/servidor/ligação/LAB são cercados; não transfere aceite para outra sessão antes do effect',async()=>{
    const pending=deferred<ProviderSettingsSnapshot>();const {f,s,session,live,port}=boot({select:vi.fn(()=>pending.promise)});await settle(f);
    s.choose('openai');s.chooseModel('custom-id');s.consent.set(true);session.token.set('another');await s.save();expect(port.select).not.toHaveBeenCalled();await settle(f);
    s.choose('openai');s.chooseModel('custom-id');s.consent.set(true);const work=s.save();live.connection.set('offline');f.detectChanges();pending.resolve(selected());await work;await settle(f);expect(s.snapshot()).toBeNull();expect(s.consent()).toBe(false);
    live.hello.set({serverId:'two',role:'operator',mode:'real'});live.connection.set('online');f.detectChanges();expect(s.allowed()).toBe(false);
  });
  it('resposta lenta e timeout são visíveis sem replay nem atualização tardia',async()=>{
    vi.useFakeTimers();const wait=deferred<ProviderSettingsSnapshot>();const load=vi.fn(()=>wait.promise);const {f,s,el}=boot({load});await settle(f);await vi.advanceTimersByTimeAsync(3001);f.detectChanges();expect(el.textContent).toContain('Resposta lenta');await vi.advanceTimersByTimeAsync(32000);f.detectChanges();expect(s.error()).toContain('demorou demais');wait.resolve(catalogFixture());await settle(f);expect(s.snapshot()).toBeNull();expect(load).toHaveBeenCalledOnce();
  });
  it('cancelar não equivale a revogar; fechar respeita Escape sem POST de limpeza implícito',async()=>{
    const {f,s,port}=boot({load:vi.fn(async()=>selected())});await settle(f);s.cancel();expect(s.notice()).toContain('não revoga');expect(port.clear).not.toHaveBeenCalled();
    const closed=vi.fn();f.componentInstance.closed.subscribe(closed);f.nativeElement.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));expect(closed).toHaveBeenCalledOnce();
  });
});
