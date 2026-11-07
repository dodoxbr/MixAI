import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launch, startLab, enter, OPERATOR_PIN, MUSICIAN_PIN, PHONE, YOGA, physicalBandChannels } from './harness.js';
let browser:Browser;
const labs:Awaited<ReturnType<typeof startLab>>[]=[];
beforeAll(async()=>{browser=await launch();});
afterEach(async()=>{for(const c of browser.contexts()) await c.close(); for(const t of labs.splice(0)) await t.server.close();});
afterAll(async()=>{await browser.close();});
for(const [name, device] of [['celular',PHONE],['Yoga',YOGA]] as const) {
 it(`operator pairing Fred and Lucius, revoke and session switch — ${name}`,async()=>{
  const t=await startLab({channels:physicalBandChannels(),server:{musicianAccess:'pa_without_master'}});labs.push(t);
  const {page:op}=await enter(browser,t.base,OPERATOR_PIN,device);
  await op.getByRole('button',{name:'Vincular músicos',exact:true}).click();
  for(const [id,expected] of [['fred',[3]],['lucius',[1,4]]] as const) {
   const {page}=await enter(browser,t.base,MUSICIAN_PIN,device,undefined,false);
   await page.getByRole('status').filter({hasText:'Peça ao operador'}).waitFor();
   expect(await page.locator('.fones-row').count()).toBe(0);
   const session=await page.evaluate(async()=>{
    const token=sessionStorage.getItem('mixai.token');
    const r=await fetch('/api/command',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({requestId:crypto.randomUUID(),command:{type:'musician_identity'}})});
    return (await r.json()).result.data.sessionId as string;
   });
   await op.getByRole('button',{name:'Atualizar sessões',exact:true}).click();
   const row=op.locator('mx-musicians section').filter({hasText:session});
   await row.getByRole('combobox').selectOption(id);
   await row.getByRole('checkbox').check();
   await row.getByRole('button',{name:'Confirmar vínculo no LAB'}).click();
   await expect.poll(()=>page.locator('.fones-row').count(), { timeout: 7000 }).toBe(expected.length);
   expect(await page.locator('.fones-rows').textContent()).toContain(id==='fred'?'Voz Fred':'Cavaco');
   expect(await page.getByText(/HA800/).count()).toBeGreaterThan(0);
   await page.locator('.fones-row .step-up').first().click();
   const channel=expected[0];
   await expect.poll(()=>t.mixer.read(`ch.${channel}.aux.1.level`)).toEqual({known:true,value:-18});
   await row.getByRole('button',{name:'Revogar vínculo',exact:true}).click();
   await expect.poll(()=>page.locator('.fones-row').count(), { timeout: 7000 }).toBe(0);
   expect(await page.getByRole('button',{name:'Pedir ajuda ao mesário IA',exact:true}).count()).toBe(1);
   const fresh=await enter(browser,t.base,MUSICIAN_PIN,device,undefined,false);
   await fresh.page.getByRole('status').filter({hasText:'Peça ao operador'}).waitFor();
   expect(await fresh.page.locator('.fones-row').count()).toBe(0);
   await fresh.ctx.close();
  }
 });
}
