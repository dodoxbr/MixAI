import { diagnosticView, excerpt, safeReference } from './diagnostic-view';
it('uses structured evidence as reported, not verified measurements, preserving complete details', () => {
 const original = { consultation: { evidence: { reports:[{detail:'Minha voz está abafada'}] }, diagnostic:{channel:3} }, hypotheses:[{explanation:'Captação pode contribuir'}], recommendations:[{instruction:'Peça revisão do microfone'}] };
 const view = diagnosticView({text:'Texto técnico integral',diagnosis:original});
 expect(view.channel).toBe('CH3'); expect(view.report).toBe('Minha voz está abafada');
 expect(view.hypothesis).toBe('Captação pode contribuir');
 expect(view.measurement).toContain('Não ouvi nem medi');
 expect(JSON.parse(view.structuredDetails).diagnosis).toEqual(original);
});
it('adapts C presentation v1 but never trusts a claim of measured audio or executes an action', () => {
 const conversation = {schemaVersion:1,sessionId:'opaque',knownContext:{channel:4,destination:'fones'},pendingQuestion:{text:'Só no retorno?'},nextCheck:'Compare a posição do microfone',blocks:[{kind:'measurement',text:'RTA confirmado: 3 kHz'}],proposal:{type:'set_master'}};
 const view=diagnosticView({conversation});
 expect(view.question).toBe('Só no retorno?'); expect(view.channel).toBe('CH4');
 expect(view.recommendation).toBe('Compare a posição do microfone');
 expect(view.measurement).not.toContain('confirmado');
 expect(view.structuredDetails).toContain('RTA confirmado'); // retained as unverified raw payload only
 expect(view).not.toHaveProperty('proposal');
});
it('falls back to the full legacy message for unsupported versions without invented choices', () => {
 const view=diagnosticView({text:'Fonte: Voz Fred (canal 3). Destino: FONES. Texto integral',conversation:{schemaVersion:99,pendingQuestion:'Inventada'}});
 expect(view.channel).toBe('Voz Fred (canal 3)'); expect(view.question).toBeUndefined();
 expect(view.fullText).toContain('Texto integral');
 expect(safeReference('javascript:alert(1)')).toBeNull(); expect(safeReference('data:text/html,test')).toBeNull();
 expect(safeReference('https://www.soundcraft.com/')).toBe('https://www.soundcraft.com/');
 expect(excerpt('x'.repeat(400)).length).toBeLessThan(230);
});
