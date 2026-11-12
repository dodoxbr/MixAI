import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { answerNames, FakeSocket, hello, snapshot } from '../../testing/fake-socket';

async function boot(role: 'operator' | 'musician' = 'operator') {
  FakeSocket.all = [];
  LiveService.socketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const fixture = TestBed.createComponent(App);
  const session = TestBed.inject(SessionService);
  session.token.set('tok');
  session.role.set(role);
  fixture.detectChanges();
  await fixture.whenStable();
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  ws.receive({ ...hello(role), assistant: { available: true, ai: false } });
  answerNames(ws);
  ws.receive(snapshot(0));
  await Promise.resolve();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  };
  const say = async (text: string) => {
    const input = el.querySelector('.mx-assistant-input input') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (el.querySelector('.mx-assistant-input button[type=submit]') as HTMLButtonElement).click();
    await settle();
    return ws.last('assistant')!;
  };
  return { fixture, ws, el, say, settle };
}

const CARD = {
  id: 'c1',
  source: 'local',
  title: 'PA: Surdo',
  channel: 'Surdo',
  destination: 'PA',
  current: '−10.0 dB',
  change: '+2 dB',
  result: '−8.0 dB',
  needsApproval: false,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
};

describe('assistente na tela', () => {
  it('contexto pendente mostra assunto acessível, envia PA com revisão e desabilita opções antigas', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('Meu cavaco está estridente');
    const context = { id: 'd599a8db-b6ef-4d42-b0f7-a6f3b55ce891', revision: 1, expiresAt: new Date(Date.now() + 300000).toISOString(), subject: 'Cavaco · estridente · Destino a confirmar', field: 'destination', question: 'No PA ou nos FONES?' };
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'diagnosis', source: 'local', text: 'Não ouvi o som.', diagnosticContext: context, diagnosticOptions: [{ label: 'Fones', input: { evidence: ['não reenviar dado privado'] } }] } });
    await settle();
    expect(el.querySelector('[aria-label="Diagnóstico pendente"]')?.textContent).toContain('Cavaco');
    const next = await say('PA');
    expect(next).toMatchObject({ type: 'assistant', text: 'PA', context: { id: context.id, revision: 1 } });
    ws.receive({ type: 'assistant_reply', requestId: next['requestId'], reply: { kind: 'diagnosis', source: 'local', text: 'Destino: PA. Sem ajustes.', diagnosticContext: null } });
    await settle();
    expect(el.querySelector('[aria-label="Diagnóstico pendente"]')).toBeNull();
    expect((el.querySelector('.diagnostic-options button') as HTMLButtonElement).disabled).toBe(true);
    expect(ws.last('proposal_apply')).toBeUndefined();
  });

  it('opções contextuais enviam apenas resposta e revisão; cancelar limpa o assunto', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('Meu cavaco está estridente');
    const context = { id: 'd599a8db-b6ef-4d42-b0f7-a6f3b55ce891', revision: 1, expiresAt: new Date(Date.now() + 300000).toISOString(), subject: 'Cavaco · estridente', field: 'destination', question: 'PA ou FONES?' };
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'diagnosis', source: 'local', text: 'Consulta', diagnosticContext: context, diagnosticOptions: [{ label: 'Fones', input: { detail: 'dado privado que não é autoridade do cliente' } }] } });
    await settle();
    (el.querySelector('.diagnostic-options button') as HTMLButtonElement).click(); await settle();
    const sent = ws.last('assistant_conversation')!;
    expect(sent).toMatchObject({ input: { text: 'Fones', context: { id: context.id, revision: 1 } } });
    expect(JSON.stringify(sent)).not.toContain('dado privado');
    ws.receive({ type: 'assistant_reply', requestId: sent['requestId'], reply: { kind: 'answer', source: 'local', text: 'Esclareça', diagnosticContext: context } });
    await settle();
    (el.querySelector('.diagnostic-context button') as HTMLButtonElement).click(); await settle();
    const cancel = ws.last('assistant')!;
    expect(cancel).toMatchObject({ text: 'cancelar diagnóstico', context: { id: context.id, revision: 1 } });
    ws.receive({ type: 'assistant_reply', requestId: cancel['requestId'], reply: { kind: 'answer', source: 'local', text: 'Diagnóstico encerrado', diagnosticContext: null } });
    await settle();
    expect(el.querySelector('.diagnostic-context')).toBeNull();
  });

  it('projeção expirada e troca de sessão eliminam o assunto, inclusive resposta atrasada', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('Meu cavaco está estridente');
    const context = { id: 'd599a8db-b6ef-4d42-b0f7-a6f3b55ce891', revision: 1, expiresAt: new Date(Date.now() - 1).toISOString(), subject: 'Cavaco', field: 'destination', question: 'PA ou FONES?' };
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'diagnosis', source: 'local', text: 'Consulta expirada', diagnosticContext: context } });
    await settle();
    expect(el.querySelector('.diagnostic-context')).toBeNull();
    const pending = await say('Minha voz está abafada');
    TestBed.inject(SessionService).token.set('sessao-nova'); await settle();
    ws.receive({ type: 'assistant_reply', requestId: pending['requestId'], reply: { kind: 'diagnosis', source: 'local', text: 'Relato privado anterior', diagnosticContext: { ...context, expiresAt: new Date(Date.now() + 300000).toISOString() } } });
    await settle();
    expect(el.querySelector('.diagnostic-context')).toBeNull();
    expect(el.textContent).not.toContain('Relato privado anterior');
  });

  it('consulta técnica mostra fontes e esclarece por consulta, sem botão de aplicar', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('Meu cavaco está estridente. O que podemos fazer?');
    const input = { symptom: 'estridente', channel: 1, destination: 'pa', evidence: [] };
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: {
      kind: 'diagnosis', source: 'local', text: 'Não ouvi o som. Confiança baixa. No PA ou nos FONES?',
      references: [{ title: 'Manual Ui16', url: 'https://www.soundcraft.com/', locator: '5.2' }],
      diagnosticOptions: [{ label: 'PA', input }],
      proposals: [CARD], // diagnóstico nunca desenha cartões, mesmo com campo indevido
    } });
    await settle();
    expect(el.textContent).toContain('Conhecimento técnico · somente leitura');
    expect(el.querySelector('.technical-text')?.textContent).toContain('Não ouvi o som');
    expect(el.querySelector('.technical-references a')?.getAttribute('href')).toBe('https://www.soundcraft.com/');
    expect(el.querySelector('.proposal')).toBeNull();
    expect(el.querySelector('.assist-feedback')).toBeNull();
    (el.querySelector('.diagnostic-options button') as HTMLButtonElement).click();
    await settle();
    expect(ws.last('assistant_diagnose')).toMatchObject({ type: 'assistant_diagnose', input });
    expect(ws.last('proposal_apply')).toBeUndefined();
    expect(ws.sent.filter(m => m['type'] === 'command' && ['set_level', 'set_mute', 'set_lab_eq'].includes((m['command'] as {type: string})?.type))).toEqual([]);
  });

  it('resposta de consulta atrasada não aparece depois de trocar de sessão', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('Meu cavaco está estridente no PA');
    TestBed.inject(SessionService).token.set('outra-sessao');
    await settle();
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'diagnosis', source: 'local', text: 'Relato privado anterior' } });
    await settle();
    expect(el.textContent).not.toContain('Relato privado anterior');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('envia o texto e mostra o cartão de proposta (sem alterar nada)', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('aumenta um pouco o surdo no PA');
    expect(req).toMatchObject({ type: 'assistant', text: 'aumenta um pouco o surdo no PA' });
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'proposals', source: 'local', proposals: [CARD] } });
    await settle();
    const card = el.querySelector('.proposal')!;
    expect(card.textContent).toContain('Surdo');
    expect(card.textContent).toContain('PA');
    expect(card.textContent).toContain('−10.0 dB');
    expect(card.textContent).toContain('+2 dB');
    expect(card.textContent).toContain('−8.0 dB');
    expect(ws.sent.some((m) => m['type'] === 'command' && (m['command'] as { type: string }).type === 'set_level')).toBe(false);
  });

  it('Aplicar manda o id da proposta; aplicado → "Melhorou?"; "Não, voltar" pede a reversão', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('sobe o surdo no PA');
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'proposals', source: 'local', proposals: [CARD] } });
    await settle();
    (el.querySelector('.proposal .btn-approve') as HTMLButtonElement).click();
    await settle();
    const apply = ws.last('proposal_apply')!;
    expect(apply['proposalId']).toBe('c1');
    ws.receive({ type: 'proposal_result', requestId: apply['requestId'], status: 'applied', message: 'ok', result: {ok:true,code:'OK',message:'LAB',data:{changes:[{outcome:'applied_simulated'}]}}, askFeedback: true });
    await settle();
    expect(el.querySelector('.proposal-state')!.textContent).toContain('Aplicado');
    expect(el.querySelector('.assist-feedback')!.textContent).toContain('Melhorou?');
    const no = [...el.querySelectorAll('.assist-feedback button')].find((b) => b.textContent!.includes('Não')) as HTMLButtonElement;
    no.click();
    await settle();
    expect(ws.last('assistant_feedback')).toMatchObject({ proposalId: 'c1', better: false });
  });

  it('valor mudou: mostra a proposta recalculada e o cartão antigo fica inativo', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('sobe o surdo no PA');
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'proposals', source: 'local', proposals: [CARD] } });
    await settle();
    (el.querySelector('.proposal .btn-approve') as HTMLButtonElement).click();
    await settle();
    const apply = ws.last('proposal_apply')!;
    ws.receive({
      type: 'proposal_result',
      requestId: apply['requestId'],
      status: 'recalculated',
      message: 'O valor mudou desde a proposta.',
      proposal: { ...CARD, id: 'c2', current: '−14.0 dB', result: '−12.0 dB' },
    });
    await settle();
    const cards = el.querySelectorAll('.proposal');
    expect(cards.length).toBe(2);
    expect(cards[0]!.querySelector('.btn-approve')).toBeNull();
    expect(cards[1]!.textContent).toContain('−12.0 dB');
  });

  it('pergunta com opções: tocar numa opção envia o pedido completo', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('aumenta um pouco o surdo');
    ws.receive({
      type: 'assistant_reply',
      requestId: req['requestId'],
      reply: { kind: 'clarify', source: 'local', question: 'No PA ou nos FONES?', options: [{ label: 'PA', text: 'aumenta um pouco o surdo no PA' }, { label: 'Fones', text: 'aumenta um pouco o surdo nos fones' }] },
    });
    await settle();
    expect(el.querySelector('.assist-log')!.textContent).toContain('No PA ou nos FONES?');
    (el.querySelectorAll('.assist-options button')[1] as HTMLButtonElement).click();
    await settle();
    expect(ws.last('assistant')).toMatchObject({ text: 'aumenta um pouco o surdo nos fones' });
  });

  it('Cancelar avisa o servidor e desativa o cartão', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('sobe o surdo no PA');
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'proposals', source: 'local', proposals: [CARD] } });
    await settle();
    (el.querySelector('.proposal .btn-reject') as HTMLButtonElement).click();
    await settle();
    expect(ws.last('proposal_cancel')).toMatchObject({ proposalId: 'c1' });
    expect(el.querySelector('.proposal-state')!.textContent).toContain('Cancelado');
  });

  it('conexão cai durante Aplicar: avisa que PODE ter sido aplicado e NÃO repete', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('sobe o surdo no PA');
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'proposals', source: 'local', proposals: [CARD] } });
    await settle();
    (el.querySelector('.proposal .btn-approve') as HTMLButtonElement).click();
    await settle();
    const applies = ws.sent.filter((m) => m['type'] === 'proposal_apply').length;
    ws.close(1006);
    await settle();
    expect(el.querySelector('.assist-log')!.textContent).toContain('PODE ter sido aplicado');
    const again = FakeSocket.all.filter((s) => s !== ws).flatMap((s) => s.sent).filter((m) => m['type'] === 'proposal_apply').length;
    expect(applies).toBe(1);
    expect(again).toBe(0);
  });

  it('IA indisponível: mostra o aviso e a mesa continua utilizável', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('preciso organizar melhor a mix');
    expect(el.querySelector('.assist-thinking')).not.toBeNull();
    // enquanto espera, os controles da mesa seguem ativos
    expect((el.querySelector('.mute') as HTMLButtonElement).disabled).toBe(false);
    ws.receive({
      type: 'assistant_reply',
      requestId: req['requestId'],
      reply: { kind: 'error', source: 'ai', code: 'AI_UNAVAILABLE', text: 'Os recursos avançados de IA estão temporariamente indisponíveis.' },
    });
    await settle();
    expect(el.querySelector('.tone-error')!.textContent).toContain('temporariamente indisponíveis');
  });

  it('painel recolhível: "Recolher" esconde a conversa; o botão Assistente volta a mostrar', async () => {
    const { el, say, fixture } = await boot();
    await say('sobe o surdo no PA');
    expect(el.querySelector('mx-assistant-panel')).not.toBeNull();
    (el.querySelector('[aria-label="Recolher o assistente"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('mx-assistant-panel')).toBeNull();
    // pelo nome acessível (no retrato o texto visível é "Chat")
    const toggle = [...el.querySelectorAll('.toolbar button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent!.trim()) === 'Assistente') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    expect(el.querySelector('mx-assistant-panel')).not.toBeNull();
  });

  it('músico: campo do assistente aparece depois do aviso de retorno compartilhado', async () => {
    const { el } = await boot('musician');
    const warning = el.querySelector('.shared-warning')!;
    const input = el.querySelector('.mx-assistant-input')!;
    expect(warning.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sem conexão: o botão fica desabilitado COM o motivo escrito, e o texto não se perde', async () => {
    const { ws, el, fixture } = await boot();
    ws.close(1006);
    fixture.detectChanges();
    const input = el.querySelector('.mx-assistant-input input') as HTMLInputElement;
    const button = el.querySelector('.mx-assistant-input button[type=submit]') as HTMLButtonElement;
    expect(input.disabled).toBe(false); // dá para escrever
    expect(button.disabled).toBe(true);
    expect(el.querySelector('[data-testid=assist-hint]')!.textContent).toContain('Sem conexão');
    input.value = 'sobe o surdo no PA';
    input.dispatchEvent(new Event('input'));
    (el.querySelector('.mx-assistant-input form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(input.value).toBe('sobe o surdo no PA'); // continua no campo
    expect(FakeSocket.all.flatMap((s) => s.sent).filter((m) => m['type'] === 'assistant')).toHaveLength(0);
  });

  it('enviar com o campo vazio explica o que fazer (não fica em silêncio)', async () => {
    const { el, fixture } = await boot();
    (el.querySelector('.mx-assistant-input button[type=submit]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=assist-hint]')!.textContent).toContain('Escreva');
  });

  it('esperando resposta: botão desabilitado com motivo; conexão cai → erro visível e o pedido NÃO é repetido', async () => {
    const { ws, el, say, settle } = await boot();
    await say('preciso organizar melhor a mix');
    expect((el.querySelector('.mx-assistant-input button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
    expect(el.querySelector('[data-testid=assist-hint]')!.textContent).toContain('Esperando a resposta');
    ws.close(1006);
    await settle();
    expect(el.querySelector('.tone-error')!.textContent).toContain('não será repetido');
    const sentAgain = FakeSocket.all.filter((s) => s !== ws).flatMap((s) => s.sent).filter((m) => m['type'] === 'assistant');
    expect(sentAgain).toHaveLength(0);
  });

  it('resposta vazia ou fora do formato ainda aparece na conversa', async () => {
    const { ws, el, say, settle } = await boot();
    const req = await say('sobe o surdo no PA');
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'] });
    await settle();
    expect(el.querySelector('.tone-error')!.textContent).toContain('formato');
    const req2 = await say('qualquer coisa');
    ws.receive({ type: 'assistant_reply', requestId: req2['requestId'], reply: { kind: 'answer', source: 'local' } });
    await settle();
    expect([...el.querySelectorAll('.assist-item')].at(-1)!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it('nova sessão: a conversa antiga (e os cartões) somem', async () => {
    const { ws, el, say, settle, fixture } = await boot();
    const req = await say('sobe o surdo no PA');
    ws.receive({ type: 'assistant_reply', requestId: req['requestId'], reply: { kind: 'proposals', source: 'local', proposals: [CARD] } });
    await settle();
    expect(el.querySelector('.proposal')).not.toBeNull();
    const session = TestBed.inject(SessionService);
    session.token.set('outro');
    fixture.detectChanges();
    await settle();
    expect(el.querySelector('.proposal')).toBeNull();
  });
});

it('progressive chat renders one question, keeps technical details collapsed and treats HTML as text', async () => {
 const {ws,el,say,settle}=await boot();
 const req=await say('Minha voz está abafada no retorno');
 const context={id:'ctx-progressive',revision:1,expiresAt:new Date(Date.now()+300000).toISOString(),subject:'Voz · FONES',field:'channel',question:'Qual é sua voz?'};
 ws.receive({type:'assistant_reply',requestId:req['requestId'],reply:{kind:'diagnosis',source:'local',text:'<img src=x onerror=alert(1)> Dados integrais',diagnosticContext:context,diagnosticOptions:[{label:'Voz Fred',input:{channel:3}},{label:'Voz Lucius',input:{channel:4}}],references:[{title:'Manual',url:'javascript:alert(1)',locator:'seção'}]}});
 await settle();
 expect(el.querySelectorAll('.chat-question')).toHaveLength(1);
 expect(el.querySelector('.chat-question')?.textContent).toBe('Qual é sua voz?');
 expect((el.querySelector('.technical-details') as HTMLDetailsElement).open).toBe(false);
 expect(el.querySelector('.technical-text')?.textContent).toContain('<img');
 expect(el.querySelector('.technical-details img')).toBeNull();
 expect(el.querySelector('.technical-references a')).toBeNull();
 expect(el.querySelector('.diagnostic-options button')?.textContent?.trim()).toBe('Fred');
 (el.querySelector('.diagnostic-options button') as HTMLButtonElement).click(); await settle();
 expect(ws.last('assistant_conversation')).toMatchObject({input:{text:'Voz Fred',context:{id:context.id,revision:1}}});
 expect(ws.last('proposal_apply')).toBeUndefined();
 expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
});

it('server unavailability is explained and cannot enqueue a chat request', async () => {
 const {ws,el,settle}=await boot();
 ws.receive({...hello('operator'),assistant:{available:false,ai:false}});await settle();
 const input=el.querySelector('.mx-assistant-input input') as HTMLInputElement;
 input.value='Minha voz está abafada';input.dispatchEvent(new Event('input'));await settle();
 expect((el.querySelector('.mx-assistant-input button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
 expect(el.querySelector('[data-testid="assist-hint"]')?.textContent).toContain('indisponível');
 expect(ws.last('assistant')).toBeUndefined();
});


it('compatible C choices use only the existing readonly consultation transport', async () => {
 const {ws,el,say,settle}=await boot();
 const req=await say('Consulta técnica');
 ws.receive({type:'assistant_reply',requestId:req['requestId'],reply:{kind:'diagnosis',source:'local',text:'Payload integral',conversation:{schemaVersion:1,sessionId:'diagnostic-session',pendingQuestion:'Qual canal?',choices:[{label:'Voz Fred',input:{channel:3,symptom:'abafado',evidence:[]}}],proposal:{type:'set_master'}}}});
 await settle();
 expect(el.querySelector('.chat-question')?.textContent).toBe('Qual canal?');
 (el.querySelector('.diagnostic-options button') as HTMLButtonElement).click();await settle();
 expect(ws.last('assistant_diagnose')).toMatchObject({input:{channel:3,symptom:'abafado',evidence:[]}});
 expect(ws.last('proposal_apply')).toBeUndefined();
 expect(ws.sent.some(m=>(m['command'] as any)?.type==='set_master')).toBe(false);
});

describe('confirmação de operação ao vivo', () => {
 afterEach(() => vi.unstubAllGlobals());
 it.each(['AUX 5','AUX-5','AUX cinco'])('blocks unsupported %s before sending rather than targeting shared AUX1', async (destination) => {
  const {ws,el,say}=await boot(); await say('Sobe 2 dB do violão no ' + destination);
  expect(ws.last('assistant')).toBeUndefined(); expect(el.textContent).toContain('Nenhum pedido foi enviado');
 });
 it('keeps delayed operation pending and shows only actual returned result, never proposed final value', async () => {
  const {ws,el,say,settle}=await boot(); const req=await say('sobe o cavaco no PA');
  ws.receive({type:'assistant_reply',requestId:req['requestId'],reply:{kind:'proposals',source:'local',proposals:[{...CARD,channel:'Cavaco'}]}}); await settle();
  (el.querySelector('.proposal .btn-approve') as HTMLButtonElement).click(); await settle();
  expect(el.textContent).toContain('Aguardando retorno');
  expect((el.querySelector('.proposal .btn-approve') as HTMLButtonElement).disabled).toBe(true);
  const apply=ws.last('proposal_apply')!;
  ws.receive({type:'proposal_result',requestId:apply['requestId'],status:'applied',proposalId:CARD.id,message:'Enviado',result:{ok:true,code:'OK',message:'Estado ainda não confirmado',data:{changes:[{outcome:'sent'}]}}}); await settle();
  expect(el.textContent).toContain('sem confirmação física'); expect(el.textContent).not.toContain('agora −8.0');
 });
});

describe('retorno insuficiente ou recusado', () => {
 afterEach(() => vi.unstubAllGlobals());
 it.each([
  [{status:'applied',message:'ok'},'confirmação final não disponível'],
  [{status:'failed',message:'Permissão revogada'},'Permissão revogada'],
 ])('não transforma %j em conclusão confirmada',async(reply,label)=>{
  const {ws,el,say,settle}=await boot();const req=await say('sobe o cavaco no PA');
  ws.receive({type:'assistant_reply',requestId:req['requestId'],reply:{kind:'proposals',source:'local',proposals:[CARD]}});await settle();
  (el.querySelector('.proposal .btn-approve') as HTMLButtonElement).click();await settle();
  const apply=ws.last('proposal_apply')!;ws.receive({type:'proposal_result',requestId:apply['requestId'],...reply});await settle();
  expect(el.querySelector('.assist-log')!.textContent).toContain(label);
  expect(el.querySelector('.proposal-state')!.textContent).not.toContain('Aplicado');
  expect(el.querySelector('.proposal .btn-approve')).toBeNull();
 });
});
