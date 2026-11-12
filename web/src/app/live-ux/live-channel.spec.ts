import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, levelEvent, snapshot } from '../../testing/fake-socket';
async function boot() {
 FakeSocket.all=[]; LiveService.socketFactory=url=>new FakeSocket(url) as unknown as WebSocket;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}')));
 const fixture=TestBed.createComponent(App), session=TestBed.inject(SessionService);
 session.token.set('operator'); session.role.set('operator'); fixture.detectChanges(); await fixture.whenStable();
 const ws=FakeSocket.all.at(-1)!; ws.open(); ws.receive(hello()); answerNames(ws); ws.receive(snapshot());
 const settle=async()=>{await Promise.resolve();await Promise.resolve();fixture.detectChanges();}; await settle();
 const el=fixture.nativeElement as HTMLElement;
 (el.querySelector('[aria-label="Selecionar CH2 — Violão"]') as HTMLButtonElement).click(); await settle();
 return {fixture,session,ws,el,settle,live:TestBed.inject(LiveService)};
}
afterEach(()=>vi.unstubAllGlobals());
it('selects known channel/route without a command, and observes server changes without restoration',async()=>{
 const {ws,el,settle}=await boot();
 const inspector=el.querySelector('mx-live-channel')!; expect(inspector.textContent).toContain('CH2 — Violão');
 expect(inspector.textContent).toContain('−10.0 dB');
 const before=ws.sent.length; const select=inspector.querySelectorAll('select')[1]!;
 select.value='1'; select.dispatchEvent(new Event('change')); await settle();
 expect(inspector.textContent).toContain('−20.0 dB'); expect(inspector.textContent).toContain('compartilhado');
 expect(ws.sent.length).toBe(before);
 ws.receive(levelEvent(0,'ch.2.aux.1.level',-15));await settle();
 expect(inspector.textContent).toContain('−15.0 dB');expect(inspector.textContent).toContain('revisão 1');
 expect(ws.sent.length).toBe(before);
});
it('masks stale data and blocks controls on a revision gap until a fresh snapshot',async()=>{
 const {ws,el,settle,live}=await boot();
 ws.receive(levelEvent(9,'ch.2.main.level',-1)); await settle();
 expect(live.writable()).toBe(false); expect(ws.last('resync')).toBeDefined();
 expect(el.querySelector('mx-live-channel')?.textContent).toContain('Não disponível');
 expect(el.querySelector('mx-live-channel')?.textContent).not.toContain('−10.0 dB');
 ws.receive(snapshot(10));await settle(); expect(live.writable()).toBe(true);
 expect(el.querySelector('mx-live-channel')?.textContent).toContain('−10.0 dB');
});
it('clears selected channel and private receipts when session changes',async()=>{
 const {ws,el,session,settle,live}=await boot();
 ws.receive({type:'fader_result',serverId:'srv-1',result:{ok:true,code:'OK',message:'Privado anterior'}}); await settle();
 expect(live.faderReceipt()).not.toBeNull(); session.token.set('other-session');await settle();
 expect(el.querySelector('mx-live-channel')).toBeNull();expect(live.faderReceipt()).toBeNull();
});
