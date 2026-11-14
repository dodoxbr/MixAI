import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { paramKey } from '../../src/core/revisions.js';
import { MASTER } from '../../src/mixer/types.js';
import { enter, launch, OPERATOR_PIN, PHONE, physicalBandChannels, startLab, YOGA } from './harness.js';
let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[]=[];
const contexts: Array<{close():Promise<void>}>=[];
beforeAll(async()=>{browser=await launch();});
afterAll(async()=>{await browser.close();});
afterEach(async()=>{for(const c of contexts.splice(0)) await c.close(); for(const l of labs.splice(0)) await l.server.close(); vi.restoreAllMocks();});
async function open(device:object=YOGA, channels=physicalBandChannels()) {
 const l=await startLab({channels});labs.push(l);
 const {ctx,page}=await enter(browser,l.base,OPERATOR_PIN,device);contexts.push(ctx);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 return {l,page,errors};
}
async function say(page:Page,text:string) { await page.getByPlaceholder('O que você deseja ajustar?').fill(text);await page.getByRole('button',{name:'Enviar',exact:true}).click(); }
const value=(l:Awaited<ReturnType<typeof startLab>>)=>(l.mixer.read(paramKey.level(2,MASTER) as never) as {value:number}).value;
const screenshots=resolve('docs/live-ux/screenshots');
for(const [name,device] of [['desktop',{viewport:{width:1920,height:1080}}],['yoga',YOGA],['celular',PHONE]] as const) {
 it(`${name}: canal, destino, histórico e alvos acessíveis sem comandos implícitos`,async()=>{
  const {l,page,errors}=await open(device);const write=vi.spyOn(l.mixer,'write');
  const select=page.getByRole('button',{name:'Selecionar CH2 — Violão',exact:true});
  await select.focus();await page.keyboard.press('Enter');
  const panel=page.getByRole('region',{name:'Canal selecionado'});await panel.waitFor();
  expect(await panel.textContent()).toContain('−10.0 dB');
  await panel.getByLabel('Canal',{exact:true}).selectOption('3');
  await expect.poll(()=>panel.textContent()).toContain('CH3 — Voz Fred');
  await panel.getByLabel('Destino dos controles').selectOption('1');
  await expect.poll(()=>panel.textContent()).toContain('−20.0 dB');
  expect(await panel.textContent()).toContain('AUX1 é compartilhado');
  for(const control of await panel.locator('select, button').all()) {
   const box=await control.boundingBox();expect(box?.height).toBeGreaterThanOrEqual(48);
   expect(await control.evaluate(el=>el instanceof HTMLSelectElement ? !!el.labels?.length : !!el.textContent || !!el.getAttribute('aria-label'))).toBe(true);
  }
  await panel.getByRole('button',{name:'Ver histórico'}).click();await page.getByRole('region',{name:'Histórico',exact:true}).waitFor();
  expect(write).not.toHaveBeenCalled();
  if(name === 'celular') { const panelBox=await panel.boundingBox(), listBox=await page.locator('.strips').boundingBox(); expect(panelBox!.y).toBeLessThan(listBox!.y); }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await panel.scrollIntoViewIfNeeded();mkdirSync(screenshots,{recursive:true});await page.screenshot({path:resolve(screenshots,name+'.png'),fullPage:name !== 'celular'});
  expect(errors).toEqual([]);
 });
}
it('proposta cancelada não escreve; resposta atrasada mantém pendência e aplicação usa retorno LAB',async()=>{
 const {l,page}=await open(); const write=vi.spyOn(l.mixer,'write');
 await say(page,'sobe 2 db do violão no PA');let card=page.locator('.proposal').last();await card.waitFor();
 expect(await card.textContent()).toContain('CH2 — Violão');expect(await card.textContent()).toContain('−8.0 dB');
 await card.getByRole('button',{name:'Cancelar',exact:true}).click();expect(value(l)).toBe(-10);expect(write).not.toHaveBeenCalled();
 await say(page,'sobe 2 db do violão no PA');card=page.locator('.proposal').last();await card.waitFor();
 const assistant=l.server.core.assistant!;const original=assistant.apply.bind(assistant);
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 vi.spyOn(assistant,'apply').mockImplementation(async(...args)=>{await gate;return original(...args);});
 await card.getByRole('button',{name:'Confirmar ajuste'}).click();
 await expect.poll(()=>card.textContent()).toContain('Aguardando retorno');expect(value(l)).toBe(-10);
 expect(await card.getByRole('button',{name:'Aguardando retorno…'}).isDisabled()).toBe(true);
 release();await expect.poll(()=>value(l)).toBe(-8);
 await expect.poll(()=>page.locator('.assist-log').textContent()).toContain('simulado');
 await page.getByRole('button',{name:'Selecionar CH2 — Violão'}).click();
 await expect.poll(()=>page.getByRole('region',{name:'Canal selecionado'}).textContent()).toContain('−8.0 dB');
 await page.getByRole('button',{name:'Desfazer último ajuste'}).click();await expect.poll(()=>value(l)).toBe(-10);
});
it('AUX explícito não suportado não vira FONES e conexão interrompida oculta dados e bloqueia controles',async()=>{
 const {l,page}=await open();const write=vi.spyOn(l.mixer,'write');
 await say(page,'Sobe 2 dB do violão no AUX 5');await page.locator('.tone-error').waitFor();
 expect(await page.locator('.tone-error').textContent()).toContain('Nenhum pedido foi enviado');expect(write).not.toHaveBeenCalled();
 await page.getByRole('button',{name:'Selecionar CH2 — Violão'}).click();
 const ws=(l.server.https[0] as unknown as {websocketServer:{clients:Set<{terminate():void}>}}).websocketServer;
 // Block reconnect so the disconnected presentation can be inspected deterministically.
 await page.route('**/api/login',route=>route.abort());
 for(const c of ws.clients)c.terminate();
 await expect.poll(()=>page.getByTestId('link').textContent()).toContain('reconectando');
 const panel=page.getByRole('region',{name:'Canal selecionado'});
 await expect.poll(()=>panel.textContent()).toContain('Não disponível');
 expect(await panel.getByRole('button',{name:'Desfazer último ajuste'}).isDisabled()).toBe(true);
 expect(write).not.toHaveBeenCalled();
});

it('AUX adicional cadastrado é somente uma seleção de vista; ajuste manual LAB afeta somente esse AUX',async()=>{
 const channels=physicalBandChannels();channels.aux.push({number:5,name:'Retorno LAB 5',aliases:[]});
 const {l,page}=await open(PHONE,channels);const write=vi.spyOn(l.mixer,'write');
 await page.getByRole('button',{name:'Selecionar CH2 — Violão'}).click();
 const panel=page.getByRole('region',{name:'Canal selecionado'});
 await panel.getByLabel('Destino dos controles').selectOption('5');
 await expect.poll(()=>panel.textContent()).toContain('AUX 5');expect(write).not.toHaveBeenCalled();
 const slider=page.getByRole('slider',{name:'Violão no AUX 5',exact:true});await slider.focus();await page.keyboard.press('ArrowUp');
 await expect.poll(()=>(l.mixer.read('ch.2.aux.5.level' as never)as {value:number}).value).toBe(-19);await expect.poll(()=>slider.getAttribute('aria-valuenow')).toBe('-19');await page.keyboard.press('ArrowUp');
 await expect.poll(()=>write.mock.calls.length).toBe(2);
 expect((l.mixer.read('ch.2.aux.5.level' as never) as {value:number}).value).toBe(-18);
 expect((l.mixer.read('ch.2.aux.1.level' as never) as {value:number}).value).toBe(-20);expect(value(l)).toBe(-10);
});
it('diagnóstico guiado apresenta sugestões e relatos, sem confirmação física ou botão de ajuste',async()=>{
 const {l,page}=await open();const write=vi.spyOn(l.mixer,'write');
 await say(page,'A voz do Fred está abafada nos fones');
 const current=()=>page.locator('.diagnostic-options').last();
 // Actual conversational choices; no fabricated recommendations or endpoints.
 await current().getByRole('button',{name:'Só com a banda',exact:true}).click();
 const checks=page.getByRole('region',{name:'Verificações guiadas'}).last();await checks.waitFor();
 expect(await checks.textContent()).toContain('Sugestão técnica');
 expect(await checks.textContent()).toContain('Confirmação pela mesa: não disponível');
 await current().getByRole('button',{name:'Sem mudança',exact:true}).click();
 await expect.poll(()=>page.getByRole('region',{name:'Verificações guiadas'}).last().textContent()).toContain('HPF/EQ');
 expect(await page.getByRole('region',{name:'Relatos das verificações'}).last().textContent()).toContain('relato humano, não medição');
 expect(await page.locator('.proposal').count()).toBe(0);expect(write).not.toHaveBeenCalled();
});
