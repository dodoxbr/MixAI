import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, OPERATOR_PIN, MUSICIAN_PIN, wsClient } from './server-support.js';
import { MusicianAccess } from '../src/server/musician-access.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
const sockets: Awaited<ReturnType<typeof wsClient>>[] = [];
afterEach(async () => { sockets.splice(0).forEach(s => s.close()); for (const t of servers.splice(0)) await t.server.close(); });
async function setup() {
 const t = await startTestServer({server:{musicianAccess:'pa_without_master'}}); servers.push(t);
 const op = await t.login(OPERATOR_PIN), mus = await t.login(MUSICIAN_PIN);
 const identity = (await t.command(mus,{type:'musician_identity'})).json.result.data;
 const bind = (id='lucius', channels=[1,4], mute=true) => t.command(op,{type:'musician_bind',sessionId:identity.sessionId,musicianId:id,name:id,channels,mute});
 return {t,op,mus,identity,bind};
}
it('shared PIN alone grants no writes or identity selection; operator binds Lucius and channels are enforced over HTTP/WS',async()=>{
 const {t,op,mus,identity,bind}=await setup(); const write=vi.spyOn(t.mixer,'write');
 expect(identity.binding).toBeNull();
 expect((await t.command(mus,{type:'set_level',channel:1,aux:1,deltaDB:2})).json.result.code).toBe('FORBIDDEN');
 expect((await t.command(mus,{type:'musician_bind',sessionId:identity.sessionId,musicianId:'fred',name:'Fred',channels:[3],mute:true})).json.result.code).toBe('FORBIDDEN');
 expect(write).not.toHaveBeenCalled(); expect((await bind()).json.result.ok).toBe(true);
 const c=await wsClient(t.base,mus); sockets.push(c); await c.next(m=>m.type==='snapshot');
 for(const channel of [3,5]) {
  const command={type:'set_level',channel,aux:1,deltaDB:2};
  expect((await t.command(mus,command)).json.result.code).toBe('FORBIDDEN');
  expect((await c.request({type:'command',command})).result.code).toBe('FORBIDDEN');
 }
 for(const channel of [1,4]) expect((await t.command(mus,{type:'set_level',channel,aux:1,deltaDB:2})).json.result.ok).toBe(true);
 expect((await t.command(mus,{type:'set_level',channel:1,deltaDB:2})).json.result.ok).toBe(true);
 const state=(await t.http('/api/state',{token:mus})).json.snapshot.params;
 expect(Object.keys(state).every(k=>/^ch\.(1|4)\.(main|aux\.1)\./.test(k))).toBe(true);
 expect((await t.command(mus,{type:'set_master',deltaDB:1})).json.result.code).toBe('FORBIDDEN');
 await t.command(op,{type:'musician_revoke',sessionId:identity.sessionId});
 expect((await c.request({type:'command',command:{type:'set_mute',channels:[1],aux:1,muted:true}})).result.code).toBe('FORBIDDEN');
});
it('Fred only CH3; mute flag, AUX limit and forged absolute steps remain bounded; new sessions never inherit identity',async()=>{
 const {t,op,mus,bind}=await setup(); expect((await bind('fred',[3],false)).json.result.ok).toBe(true);
 expect((await t.command(mus,{type:'set_mute',channels:[3],aux:1,muted:true})).json.result.code).toBe('FORBIDDEN');
 expect((await t.command(mus,{type:'set_level',channel:3,aux:2,deltaDB:2})).json.result.code).toBe('FORBIDDEN');
 const large=(await t.command(mus,{type:'set_level',channel:3,aux:1,db:0})).json.result;
 expect(large.needsConfirmation).toBe(true); expect(t.mixer.read('ch.3.aux.1.level')).toEqual({known:true,value:-20});
 const next=await t.login(MUSICIAN_PIN);
 expect((await t.command(next,{type:'set_level',channel:3,aux:1,deltaDB:2})).json.result.code).toBe('FORBIDDEN');
 await t.http('/api/logout',{token:mus,body:{}});
 expect((await t.command(op,{type:'status'})).json.result.ok).toBe(true);
 expect((await t.command(op,{type:'musician_sessions'})).json.result.data.sessions.every((s:any)=>s.binding?.musicianId!=='fred')).toBe(true);
});
it('queued writes recheck binding revision; persisted bindings do not authenticate sessions after restart',async()=>{
 const {t,op,mus,identity,bind}=await setup(); await bind();
 const controller=t.controller as any;
 let release!:()=>void; const blocker=controller.queue.run(()=>new Promise<void>(r=>release=r));
 await Promise.resolve();
 const pending=t.command(mus,{type:'set_level',channel:1,aux:1,deltaDB:2});
 await expect.poll(()=>controller.queue.size()).toBe(2);
 await t.command(op,{type:'musician_revoke',sessionId:identity.sessionId}); release(); await blocker;
 expect((await pending).json.result.code).toBe('FORBIDDEN');
 expect(t.mixer.read('ch.1.aux.1.level')).toEqual({known:true,value:-20});
 await bind(); const file=join(t.dir,'musician-bindings.json');
 expect(readFileSync(file,'utf8')).not.toContain(mus);
 const restored=new MusicianAccess(file); expect(restored.list()[0]?.observed).toBe(false);
});
it('assistant application cannot bypass channel ownership or revoked bindings, and non-LAB refuses musician writes',async()=>{
 const {t,mus,bind}=await setup(); await bind('fred',[3]);
 const p=t.server.core.auth.authenticate(mus,'127.0.0.1')!;
 const answer=await t.server.core.assistant!.ask(p,'sobe o cavaco 2 db nos fones');
 expect(answer.kind).toBe('error');
 expect(JSON.stringify(answer)).toContain('FORBIDDEN');
 const write=vi.spyOn(t.mixer,'write');
 Object.defineProperty(t.server.core,'mode',{value:'real',configurable:true});
 expect((await t.command(mus,{type:'set_level',channel:3,aux:1,deltaDB:2})).json.result.code).toBe('FORBIDDEN');
 expect(write).not.toHaveBeenCalled();
});

it('revocation invalidates a pending approval even if the operator approves later', async () => {
 const {t,op,mus,identity,bind}=await setup(); await bind('fred',[3]);
 const large=(await t.command(mus,{type:'set_level',channel:3,deltaDB:5})).json.result;
 expect(large.needsConfirmation).toBe(true);
 await t.command(op,{type:'musician_revoke',sessionId:identity.sessionId});
 const response=await t.http(`/api/pending/${large.pendingId}/approve`,{token:op,body:{requestId:'late-approval',pendingId:large.pendingId}});
 expect(response.json.result.code).toBe('FORBIDDEN');
 expect(t.mixer.read('ch.3.main.level')).toEqual({known:true,value:-10});
});

it('TTL expiration removes the binding and never transfers it to a fresh login', async () => {
 const {t,mus,bind}=await setup(); await bind('fred',[3]);
 const p=t.server.core.auth.authenticate(mus,'127.0.0.1')!;
 t.clock.advance(12*3600000+1);
 expect(t.server.core.auth.isActive(p)).toBe(false);
 expect(t.server.core.musicianIdentity(p).binding).toBeNull();
 const next=await t.login(MUSICIAN_PIN);
 expect((await t.command(next,{type:'musician_identity'})).json.result.data.binding).toBeNull();
});

it('a large AUX request is applied only by an active operator approval under the same step policy', async () => {
 const {t,op,mus,bind}=await setup(); await bind('fred',[3]);
 const pending=(await t.command(mus,{type:'set_level',channel:3,aux:1,deltaDB:5})).json.result;
 expect(pending.needsConfirmation).toBe(true);
 expect(t.mixer.read('ch.3.aux.1.level')).toEqual({known:true,value:-20});
 const approved=await t.http(`/api/pending/${pending.pendingId}/approve`,{token:op,body:{requestId:'approve-aux'}});
 expect(approved.json.result.ok).toBe(true);
 expect(t.mixer.read('ch.3.aux.1.level')).toEqual({known:true,value:-15});
});
