import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launch, enter, startLab, OPERATOR_PIN, MUSICIAN_PIN, PHONE, YOGA } from './harness.js';
let browser:Browser;const labs:Awaited<ReturnType<typeof startLab>>[]=[];
beforeAll(async()=>{browser=await launch();});
afterEach(async()=>{for(const ctx of browser.contexts())await ctx.close();for(const lab of labs.splice(0))await lab.server.close();});
afterAll(async()=>{await browser.close();});
for(const [name,device] of [['Yoga',YOGA],['celular',PHONE],['paisagem',{...PHONE,viewport:{width:780,height:360}}]] as const) {
 it(`all seven tasks, back/next/not-found/restart and keyboard dismissal — ${name}`,async()=>{
  const lab=await startLab();labs.push(lab);const {page}=await enter(browser,lab.base,OPERATOR_PIN,device);
  const write=vi.spyOn(lab.mixer,'write');
  const launcher=page.getByRole('button',{name:'Instrutor Ui16 · LAB',exact:true});await launcher.click();
  const dialog=page.getByRole('dialog',{name:'Instrutor visual Ui16'});await dialog.waitFor();
  await expect.poll(()=>dialog.locator('.task').count()).toBe(7);
  const names=await dialog.locator('.task strong').allTextContents();
  for(const title of names) {
   await dialog.getByRole('button',{name:new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();
   await dialog.getByRole('status').filter({hasText:'Etapa 1 de 3'}).waitFor();
   expect(await dialog.locator('figure').textContent()).toContain('não é screenshot');
   expect(await dialog.locator('.version').textContent()).toContain('FIXTURE TEMPORÁRIA');
   const next=dialog.getByRole('button',{name:'Avançar',exact:true});expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(48);
   await dialog.getByRole('button',{name:'Não encontrei',exact:true}).click();await dialog.locator('.not-found').waitFor();expect(await next.isDisabled()).toBe(true);
   await dialog.getByRole('button',{name:'Já conferi, retomar etapa',exact:true}).click();
   await next.click();await dialog.getByRole('status').filter({hasText:'Etapa 2 de 3'}).waitFor();
   await dialog.getByRole('button',{name:'Voltar',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Etapa 1 de 3'}).waitFor();
   await next.click();await next.click();await dialog.getByRole('button',{name:'Concluir estudo',exact:true}).click();await dialog.getByRole('heading',{name:'Estudo concluído',exact:true}).waitFor();
   await dialog.getByRole('button',{name:'Reiniciar tutorial',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Etapa 1 de 3'}).waitFor();
   expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
   await dialog.getByRole('button',{name:'Todas as tarefas',exact:true}).click();
  }
  await dialog.getByRole('button',{name:/AUX SENDS e retorno AUX1/}).click();expect(await dialog.textContent()).toContain('todos ouvem a mesma mix');
  const close=dialog.getByRole('button',{name:'Fechar instrutor',exact:true});await close.focus();await close.press('Shift+Tab');expect(await page.evaluate(()=>document.activeElement?.closest('dialog')!==null)).toBe(true);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});await expect.poll(()=>launcher.evaluate(el=>el===document.activeElement)).toBe(true);
  expect(write).not.toHaveBeenCalled();
 });
}
it('unbound musician can study without receiving channel permissions or leaking progress to a new session',async()=>{
 const lab=await startLab();labs.push(lab);const {page}=await enter(browser,lab.base,MUSICIAN_PIN,PHONE,undefined,false);
 await page.getByRole('button',{name:'Instrutor Ui16 · LAB',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Instrutor visual Ui16'});
 await dialog.getByRole('button',{name:/HPF do canal/}).click();await dialog.getByRole('button',{name:'Avançar',exact:true}).click();
 const token=await page.evaluate(()=>sessionStorage.getItem('mixai.token'));
 expect((await lab.command(token!,{type:'set_level',channel:1,aux:1,deltaDB:2})).json.result.code).toBe('FORBIDDEN');
 await lab.http('/api/logout',{token:token!,body:{}});await page.locator('mx-login').waitFor();expect(await page.locator('dialog').count()).toBe(0);
 for(const d of MUSICIAN_PIN)await page.getByRole('button',{name:d,exact:true}).click();await page.getByRole('button',{name:'Entrar',exact:true}).click();
 await page.getByRole('button',{name:'Instrutor Ui16 · LAB',exact:true}).click();await page.getByRole('heading',{name:'O que você quer aprender?',exact:true}).waitFor();
});
