import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { InstructorService, INSTRUCTOR_CATALOG } from './instructor.service';
import { InstructorComponent } from './instructor.component';
import { adaptInstructionCatalog } from './instructor-contract';
import { instructorFixtures } from './instructor-fixtures';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';

function boot(loader = vi.fn(async (): Promise<unknown> => instructorFixtures)) {
 const token=signal<string|null>('session-a');const hello=signal<any>({mode:'lab',role:'operator',serverId:'server-a'});const connection=signal('online');
 const command=vi.fn();
 TestBed.configureTestingModule({providers:[{provide:INSTRUCTOR_CATALOG,useValue:loader},{provide:SessionService,useValue:{token}},{provide:LiveService,useValue:{hello,connection,command}}]});
 const fixture=TestBed.createComponent(InstructorComponent);fixture.detectChanges();
 const service=TestBed.inject(InstructorService);return {fixture,service,token,hello,connection,command,loader};
}
it('covers seven requested tasks, carries version/source/risks and rejects malformed or executable scopes',()=>{
 const catalog=adaptInstructionCatalog(instructorFixtures);
 expect(catalog.procedures.map(p=>p.id)).toEqual(['connection','channel-name','eq','hpf','gain','aux1','snapshots']);
 for(const p of catalog.procedures) {
  expect(p.validation).toBe('fixture');expect(p.origin.url).toMatch(/^https:/);expect(p.steps.length).toBeGreaterThan(1);
  for(const step of p.steps){expect(step.caution).toBeTruthy();expect(step.alternative).toBeTruthy();expect(step.schematic.length).toBeGreaterThan(0);}
 }
 const invalid=structuredClone(catalog);(invalid.procedures[0] as any).scope='real';expect(()=>adaptInstructionCatalog(invalid)).toThrow();
 invalid.procedures[0]!.scope='lab_instruction';invalid.procedures[0]!.origin.url='javascript:alert(1)';expect(()=>adaptInstructionCatalog(invalid)).toThrow();
 expect(()=>adaptInstructionCatalog({schemaVersion:99,procedures:[]})).toThrow();
});
it('next/back/not-found/completion/restart are local learning state and never dispatch commands',async()=>{
 const {service:s,fixture,command}=boot();await s.show();fixture.detectChanges();s.choose('aux1');fixture.detectChanges();
 expect(s.index()).toBe(0);s.back();expect(s.index()).toBe(0);
 s.notFound();s.next();s.finish();expect(s.index()).toBe(0);expect(s.complete()).toBe(false);
 fixture.detectChanges();expect(fixture.nativeElement.textContent).toContain('Não encontrou?');
 s.found();s.next();expect(s.index()).toBe(1);s.back();expect(s.index()).toBe(0);s.next();s.next();s.next();expect(s.index()).toBe(2);
 s.finish();fixture.detectChanges();expect(s.complete()).toBe(true);expect(fixture.nativeElement.textContent).toContain('não comprova execução');
 s.restart();expect(s.index()).toBe(0);expect(s.complete()).toBe(false);expect(command).not.toHaveBeenCalled();
});
it('displays loader failure and supports explicit retry without background execution',async()=>{
 const loader=vi.fn<()=>Promise<unknown>>().mockRejectedValueOnce(new Error('private diagnostic detail')).mockResolvedValueOnce(instructorFixtures);
 const {service:s,fixture,command}=boot(loader);await s.show();fixture.detectChanges();expect(s.error()).toContain('Não foi possível');
 expect(fixture.nativeElement.textContent).not.toContain('private diagnostic detail');await s.load();expect(s.catalog()?.procedures).toHaveLength(7);expect(command).not.toHaveBeenCalled();
});
it.each(['token','server','mode','role'] as const)('invalidates late catalogs and progress after %s change',async change=>{
 let resolve!:(v:unknown)=>void;const loader=vi.fn(()=>new Promise<unknown>(r=>resolve=r));const {service:s,fixture,token,hello}=boot(loader);
 const pending=s.show();
 if(change==='token')token.set('session-b');if(change==='server')hello.update(h=>({...h,serverId:'server-b'}));if(change==='mode')hello.update(h=>({...h,mode:'real'}));if(change==='role')hello.update(h=>({...h,role:'agent'}));
 fixture.detectChanges();resolve(instructorFixtures);await pending;expect(s.catalog()).toBeNull();expect(s.open()).toBe(false);
 s.next();expect(s.index()).toBe(0);
});
it('keeps loaded learning state offline but never enables outside LAB; escapes source text',async()=>{
 const payload=structuredClone(instructorFixtures);payload.procedures[0]!.title='<img src=x onerror=alert(1)>';
 const {service:s,fixture,connection,hello,command}=boot(vi.fn(async()=>payload));await s.show();fixture.detectChanges();
 expect(fixture.nativeElement.querySelector('img')).toBeNull();expect(fixture.nativeElement.textContent).toContain('<img');
 s.choose('eq');connection.set('offline');fixture.detectChanges();expect(fixture.nativeElement.textContent).toContain('Sem conexão');s.next();expect(s.index()).toBe(1);
 hello.update(h=>({...h,mode:'mock'}));fixture.detectChanges();await s.show();expect(s.open()).toBe(false);expect(command).not.toHaveBeenCalled();
});
