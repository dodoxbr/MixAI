import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { enter, launch, OPERATOR_PIN, PHONE, YOGA, physicalBandChannels, startLab } from './harness.js';
let browser:Browser; const labs:Awaited<ReturnType<typeof startLab>>[]=[];
beforeAll(async()=>{browser=await launch();});
afterEach(async()=>{for(const ctx of browser.contexts()) await ctx.close();for(const t of labs.splice(0)) await t.server.close();});
afterAll(async()=>{await browser.close();});
for(const [label,device] of [['celular',PHONE],['celular deitado',{...PHONE,viewport:{width:780,height:360}}],['Yoga',YOGA]] as const) {
 it(`progressive voice consultation, keyboard details and no writes — ${label}`,async()=>{
  const t=await startLab({channels:physicalBandChannels()});labs.push(t);
  const {page}=await enter(browser,t.base,OPERATOR_PIN,device);
  const writes=vi.spyOn(t.mixer,'write');
  await page.getByPlaceholder('O que você deseja ajustar?').fill('Minha voz está abafada no retorno');
  await page.getByRole('button',{name:'Enviar',exact:true}).click();
  await page.locator('.chat-question').waitFor();
  expect(await page.locator('.chat-question').count()).toBe(1);
  const fred=page.locator('.diagnostic-options').getByRole('button',{name:'Fred',exact:true});
  await fred.waitFor();
  expect((await fred.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await fred.focus();await fred.press('Enter');
  await expect.poll(()=>page.locator('.chat-context').last().textContent()).toContain('Voz Fred (canal 3)');
  expect(await page.locator('.chat-context').last().textContent()).toContain('FONES');
  expect(await page.locator('.chat-question').count()).toBeLessThanOrEqual(1);
  const details=page.locator('.technical-details').last();
  expect(await details.getAttribute('open')).toBeNull();
  const summary=details.locator('summary');await summary.focus();await summary.press('Enter');
  await expect.poll(()=>details.getAttribute('open')).not.toBeNull();
  expect(await details.locator('.technical-text').textContent()).toContain('Não ouvi o som');
  expect(await details.locator('.technical-references a').count()).toBeGreaterThan(0);
  expect(await page.locator('.proposal').count()).toBe(0);expect(writes).not.toHaveBeenCalled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const back=page.getByRole('button',{name:'Voltar na conversa',exact:true});await back.click();
  expect(await page.evaluate(()=>document.activeElement?.classList.contains('assist-item'))).toBe(true);
 });
}
