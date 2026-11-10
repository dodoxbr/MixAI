import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { FileKnowledgeStore } from '../../src/knowledge/local/store.js';
import { LocalKnowledge } from '../../src/knowledge/local/service.js';
import { OllamaClient } from '../../src/knowledge/local/ollama.js';
import { enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, YOGA, startLab } from './harness.js';
let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async()=>{browser=await launch();});
afterEach(async()=>{for(const ctx of browser.contexts())await ctx.close();for(const t of labs.splice(0))await t.server.close();vi.restoreAllMocks();});
afterAll(async()=>{await browser.close();});
async function lab() {
  const dir=mkdtempSync(join(tmpdir(),'mixai-catalog-ui-')), calls:string[]=[];
  let release!:()=>void, started!:()=>void, hold=false;
  const waiting=new Promise<void>(r=>{started=r;});
  const fake:typeof fetch=async(url,init)=>{
    const address=String(url);calls.push(address);
    if(init?.body)throw Error('UI must never generate text or send prompts');
    if(address.includes('slow-model')&&hold){started();await new Promise<void>(r=>{release=r;});}
    if(address.includes('missing-model'))return new Response('{}',{status:404});
    if(address.endsWith('/api/tags'))return Response.json({models:[{name:'fixture-model'},{name:'team/voice:latest'}]});
    if(address.endsWith('/models'))return Response.json({data:[{id:'fixture-model'},{id:'manual-model'},{id:'slow-model'}]});
    return Response.json({id:address.split('/').at(-1)});
  };
  const ollama=new OllamaClient({url:'http://127.0.0.1:11434',chatModel:'fixture-model',embedModel:'fixture-embed',embedDimensions:4,timeoutMs:1000},fake);
  const knowledge=new LocalKnowledge({store:new FileKnowledgeStore(join(dir,'knowledge.json')),ollama,chatProviders:[ollama],inboxDir:join(dir,'inbox'),seedDir:join(process.cwd(),'knowledge/seed/banda-v1_2'),maxDocumentBytes:1024*1024,maxPassages:3,narrative:false});
  const prices={'fixture-model':{inputPerMTok:1,outputPerMTok:2},'manual-model':{inputPerMTok:3,outputPerMTok:6},'slow-model':{inputPerMTok:1,outputPerMTok:2}};
  const t=await startLab({dir,knowledge,modelCatalog:{enabled:true,providers:{
    ollama:{enabled:true,models:['fixture-model']},openai:{enabled:true,models:['fixture-model'],prices},gemini:{enabled:true,models:[]},deepseek:{enabled:true,models:[]},anthropic:{enabled:false,models:[]},
  }},modelCatalogFetch:fake,openaiApiKey:'FAKE_CATALOG_OPENAI_KEY_123456',geminiApiKey:'FAKE_CATALOG_GEMINI_KEY_123456'});
  labs.push(t);return {t,calls,waiting,hold:()=>{hold=true;},release:()=>release()};
}
async function open(page:Page) {
  await page.getByRole('button',{name:'Configurações',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Inteligência Artificial'});
  await expect.poll(()=>panel.getByLabel('Seleção do catálogo nesta sessão').textContent()).toContain('Nenhum modelo');return panel;
}
const sessionToken=(page:Page)=>page.evaluate(()=>sessionStorage.getItem('mixai.token'));
for(const [name,device]of [['desktop',{viewport:{width:1440,height:960}}],['yoga',YOGA],['celular',PHONE]]as const){
  it(`${name}: rotas v1 reais, ID manual, metadados, seleção e limpeza isoladas do RAG/mixer`,async()=>{
    const {t,calls}=await lab(),writes=vi.spyOn(t.mixer,'write');const {page}=await enter(browser,t.base,OPERATOR_PIN,device);
    const token=(await sessionToken(page))!;
    const legacyBefore=(await t.http('/api/knowledge/providers',{token})).json;
    const panel=await open(page);expect(await panel.getByRole('radio').count()).toBe(5);
    expect(await panel.locator('.state').allTextContents()).toEqual(['Configurado','Configurado','Não configurado','Indisponível','Configurado']);
    expect(await panel.textContent()).toContain('responde ao resumo do diagnóstico/RAG e ao planejador do AutoConfig');
    await panel.getByRole('radio',{name:/OpenAI/}).check();await panel.getByLabel('ID do modelo',{exact:true}).fill('manual-model');
    const save=panel.getByRole('button',{name:'Selecionar no catálogo'}),validate=panel.getByRole('button',{name:'Validar modelo'});
    await expect.poll(()=>save.isDisabled()).toBe(true);await panel.getByRole('checkbox').check();await validate.click();
    await expect.poll(()=>panel.textContent()).toContain('Esta validação não seleciona');
    expect((await t.http('/api/ai/models',{token})).json.selection).toBeNull();
    expect((await t.http('/api/ai/models',{token})).json.consent.granted).toBe(false);
    expect(await panel.getByRole('checkbox').isChecked()).toBe(false);
    await expect.poll(()=>save.isDisabled()).toBe(true);
    expect(await panel.textContent()).toContain('preço configurado em USD');
    await panel.getByRole('checkbox').check();
    if(process.env['MIXAI_CAPTURE_PROVIDER_UI']==='1'){
      mkdirSync('docs/ai-providers/screenshots',{recursive:true});
      if(name==='celular')await panel.screenshot({path:'docs/ai-providers/screenshots/celular-consentimento.png'});
      await panel.evaluate(el=>{el.scrollTop=0;});await panel.screenshot({path:`docs/ai-providers/screenshots/${name}.png`});
    }
    await save.click();await expect.poll(()=>panel.getByLabel('Seleção do catálogo nesta sessão').textContent()).toContain('manual-model');
    expect((await t.http('/api/ai/models',{token})).json.consent.granted).toBe(true);
    expect((await t.http('/api/knowledge/providers',{token})).json).toEqual(legacyBefore);
    await panel.getByRole('button',{name:'Limpar seleção e revogar catálogo'}).click();
    await expect.poll(()=>panel.getByLabel('Seleção do catálogo nesta sessão').textContent()).toContain('Nenhum modelo');
    const cleared=(await t.http('/api/ai/models',{token})).json;expect(cleared.selection).toBeNull();expect(cleared.consent.granted).toBe(false);expect(cleared.revision).toBe(2);
    expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
    expect(await page.getByRole('button',{name:'Configurações',exact:true}).evaluate(el=>document.activeElement===el)).toBe(true);
    expect(writes).not.toHaveBeenCalled();expect(calls.some(url=>url.includes('/responses')||url.includes('generateContent'))).toBe(false);
  });
}
it('modelo indisponível, preço desconhecido e revogação em seleção pendente sem resposta tardia',async()=>{
  const f=await lab();const {page}=await enter(browser,f.t.base,OPERATOR_PIN,YOGA),panel=await open(page);
  await panel.getByRole('radio',{name:/OpenAI/}).check();await panel.getByLabel('ID do modelo',{exact:true}).fill('missing-model');await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'Selecionar no catálogo'}).click();
  await expect.poll(()=>panel.textContent()).toContain('Modelo indisponível');
  await panel.getByRole('button',{name:'Atualizar estado'}).click();await panel.getByRole('radio',{name:/Gemini/}).check();await panel.getByLabel('ID do modelo',{exact:true}).fill('unknown-price');await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'Validar modelo'}).click();
  await expect.poll(()=>panel.textContent()).toContain('Custo desconhecido');
  await panel.getByRole('radio',{name:/OpenAI/}).check();await panel.getByLabel('ID do modelo',{exact:true}).fill('slow-model');f.hold();await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'Selecionar no catálogo'}).click();await f.waiting;
  await panel.getByRole('button',{name:'Limpar seleção e revogar catálogo'}).click();await expect.poll(()=>panel.textContent()).toContain('limpos pelo servidor');f.release();
  await expect.poll(async()=> (await f.t.http('/api/ai/models',{token:(await sessionToken(page))!})).json.selection).toBeNull();
});
it('duas sessões, revisão antiga, limpeza e logout não transferem concessões',async()=>{
  const {t}=await lab();const a=await enter(browser,t.base,OPERATOR_PIN,YOGA),b=await enter(browser,t.base,OPERATOR_PIN,PHONE);
  const tokenA=(await sessionToken(a.page))!, tokenB=(await sessionToken(b.page))!;
  const select={schemaVersion:1,provider:'openai',model:'manual-model',confirmExternal:true,expectedRevision:0};
  await t.http('/api/ai/models/selection',{token:tokenA,body:select});
  await t.http('/api/ai/models/selection',{token:tokenB,body:select});
  await a.page.getByRole('button',{name:'Configurações',exact:true}).click();const panel=a.page.getByRole('dialog');await expect.poll(()=>panel.textContent()).toContain('manual-model');
  await t.http('/api/ai/models/selection',{token:tokenA,method:'DELETE',body:{schemaVersion:1,expectedRevision:1}});
  await panel.getByRole('button',{name:'Limpar seleção e revogar catálogo'}).click();await expect.poll(()=>panel.textContent()).toContain('A revisão mudou');
  expect((await t.http('/api/ai/models',{token:tokenB})).json.consent.granted).toBe(true);
  await panel.getByRole('button',{name:'Atualizar estado'}).click();await expect.poll(()=>panel.textContent()).toContain('Nenhum modelo');
  await t.http('/api/logout',{token:tokenA,body:{}});await a.page.getByRole('button',{name:'Entrar',exact:true}).waitFor();
  expect((await t.http('/api/ai/models',{token:tokenB})).json.consent.granted).toBe(true);
});
it('músico não recebe painel e catálogo recusa acesso; desabilitado não cai para a rota legada',async()=>{
  const f=await lab();const {page}=await enter(browser,f.t.base,MUSICIAN_PIN,PHONE,undefined,false);
  expect(await page.getByRole('button',{name:'Configurações',exact:true}).count()).toBe(0);
  expect((await f.t.http('/api/ai/models',{token:(await sessionToken(page))!})).status).toBe(403);
  const t=await startLab();labs.push(t);const operator=await enter(browser,t.base,OPERATOR_PIN,YOGA);
  await operator.page.getByRole('button',{name:'Configurações',exact:true}).click();const panel=operator.page.getByRole('dialog');
  await expect.poll(()=>panel.textContent()).toContain('Requer LAB e habilitação');
  expect(await panel.getByRole('button',{name:'Selecionar no catálogo'}).isDisabled()).toBe(true);
});
