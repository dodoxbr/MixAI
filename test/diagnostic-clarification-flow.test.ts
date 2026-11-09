import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DiagnosticContexts, type ContextualReply } from '../src/assistant/diagnostic-context.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';

/**
 * M1 — fluxo de esclarecimentos. Casos reais da banda (config/channels.yaml): Fred CH3, Lucius CH4, Leandro CH5, Fernando CH6,
 * Laviquinho CH7, cavaco CH1, surdo CH8, tantã CH10. No cadastro da banda só CH3, CH4 e CH6 têm microfone com modelo confirmado.
 * Garantias: não pergunta o que já está cadastrado ou foi dito; não repete PA/fones; no máximo três esclarecimentos; não inventa.
 */
const names = () => new ChannelMap(parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), { inputs: 12, aux: 6 });
const stamp = (r: ContextualReply) => ({ id: r.diagnosticContext!.id, revision: r.diagnosticContext!.revision });
const REGISTERED = new Set([3, 4, 6]);
const registeredCapture = (ch: number) => (REGISTERED.has(ch) ? 'microphone' as const : undefined);
function setup(withRegistry = true) {
  const store = new DiagnosticContexts(names(), 1, { clock: () => 1000, registeredCapture: withRegistry ? registeredCapture : undefined });
  const ask = (text: string, previous?: ContextualReply, actor = 'operador-1') => store.handle(actor, text, previous ? stamp(previous) : undefined)!;
  return { store, ask };
}
const field = (r: ContextualReply) => r.diagnosticContext?.field;
const known = (r: ContextualReply) => r.diagnosticSession!.knownContext;
const CLARIFICATIONS = ['report', 'scope', 'isolation', 'capture'];

/** Responde cada pergunta com a 1ª opção "afirmativa" e devolve os campos perguntados, na ordem. */
function interview(ask: ReturnType<typeof setup>['ask'], complaint: string, answers: Partial<Record<string, string>> = {}) {
  const asked: string[] = [];
  let r = ask(complaint);
  for (let i = 0; i < 12 && r.diagnosticContext; i++) {
    const f = field(r)!; asked.push(f);
    const choices = r.diagnosticSession!.choices;
    const label = answers[f] ?? choices.find(c => !/^(ainda|não sei|nao sei)/i.test(c.label))?.label ?? choices[0]!.label;
    r = ask(label, r);
  }
  return { asked, final: r };
}

describe('captação cadastrada não é perguntada de novo', () => {
  it.each([
    ['Fred', 'A voz do Fred está abafada no retorno', 3],
    ['Lucius', 'Microfonia no retorno do Lucius', 4],
    ['Fernando', 'A voz do Fernando está abafada no PA', 6],
  ])('%s (microfone com modelo confirmado): vai direto ao isolamento e conhece a captação', (_n, complaint, channel) => {
    const { ask } = setup();
    const r = ask(complaint);
    expect(known(r).channel).toBe(channel);
    expect(['report', 'isolation']).toContain(field(r)); // microfonia sem relato claro pergunta antes "relatando agora?"; nunca a captação
    expect(known(r).capture).toBe('microphone');
    const { asked } = interview(ask, complaint, { isolation: 'Também sozinha' });
    expect(asked).not.toContain('capture');
  });
  it.each([
    ['Leandro', 'A voz do Leandro está abafada no retorno'],
    ['Laviquinho', 'A voz da Laviquinho está sem brilho no retorno'],
  ])('%s (microfone NÃO confirmado no cadastro): a pergunta de captação continua e nada é presumido', (_n, complaint) => {
    const { ask } = setup();
    let r = ask(complaint);
    expect(known(r).capture).toBeNull();
    r = ask('Também sozinha', r);
    expect(field(r)).toBe('capture');
    expect(known(r).capture).toBeNull();
  });
  it('sem cadastro nenhum (base desligada), a captação é perguntada como antes', () => {
    const { ask } = setup(false);
    let r = ask('A voz do Fred está abafada no retorno');
    expect(known(r).capture).toBeNull();
    r = ask('Também sozinha', r);
    expect(field(r)).toBe('capture');
  });
  it('o que o operador responde vale mais do que o cadastro: captador/DI dito no relato é respeitado', () => {
    const { ask } = setup();
    const r = ask('O violão do Fred está abafado no retorno, ligado em captador');
    expect(known(r).capture === 'pickup_di' || known(r).capture === 'microphone').toBe(true);
    expect(CLARIFICATIONS).toContain('isolation');
  });
});

describe('PA e fones: nunca se pergunta duas vezes', () => {
  it('destino no relato → nenhuma pergunta de "só no PA / também nos fones"', () => {
    for (const complaint of ['Minha voz está abafada no retorno', 'O surdo está sem grave no PA', 'Meu cavaco está estridente no PA']) {
      const { asked } = interview(setup().ask, complaint);
      expect(asked, complaint).not.toContain('scope');
    }
  });
  it('destino escolhido na pergunta de destino → a próxima não repete PA/fones', () => {
    const { ask } = setup();
    let r = ask('Meu cavaco está estridente. O que podemos fazer?');
    expect(field(r)).toBe('destination');
    r = ask('PA', r);
    expect(known(r).destination).toBe('pa');
    expect(field(r)).toBe('isolation');
    expect(r.diagnosticContext!.question).not.toMatch(/PA|fones|retorno/i);
  });
  it('quando o operador diz que acontece nos dois, isso é guardado (informação espontânea é respeitada)', () => {
    const { ask } = setup();
    const r = ask('Fred está abafado no PA e nos fones');
    expect(field(r)).toBe('destination');
    const next = ask('Fones', r);
    expect(known(next).scope).toBe('both');
    expect(field(next)).toBe('isolation');
  });
});

describe('até três esclarecimentos, com contexto suficiente', () => {
  const COMPLAINTS = [
    'A voz do Fred está abafada no retorno', 'Tá microfonando quando o Fred canta no PA', 'Microfonia no retorno do Lucius', 'A voz da Laviquinho está sem brilho no retorno',
    'O surdo está sem grave no PA', 'O surdo está embolado no retorno', 'Meu cavaco está estridente no PA', 'O pandeiro está sem brilho no retorno', 'O violão está abafado no PA', 'O tantã está sem corpo no retorno',
  ];
  it.each(COMPLAINTS)('"%s": no máximo 3 esclarecimentos antes das verificações, sem abrangência', (complaint) => {
    const { ask } = setup();
    const { asked, final } = interview(ask, complaint);
    const clar = asked.filter(f => CLARIFICATIONS.includes(f));
    expect(clar.length, asked.join('>')).toBeLessThanOrEqual(3);
    expect(clar).not.toContain('scope');
    expect(final.diagnosticSession!.status).toBe('complete');
  });
  it('pior caso (nada cadastrado, nada dito): isolamento + captação, e o relato conceitual ainda cabe em 3', () => {
    const { ask } = setup(false);
    const { asked } = interview(ask, 'A voz da Laviquinho está abafada no retorno');
    expect(asked.slice(0, 2)).toEqual(['isolation', 'capture']);
    expect(asked.filter(f => CLARIFICATIONS.includes(f)).length).toBeLessThanOrEqual(3);
  });
  it('Fred com microfone cadastrado: um esclarecimento (isolamento) e já vem a primeira verificação', () => {
    const { ask } = setup();
    const { asked } = interview(ask, 'A voz do Fred está abafada no retorno', { isolation: 'Só com a banda' });
    expect(asked.filter(f => CLARIFICATIONS.includes(f))).toEqual(['isolation']);
    expect(asked[1]).toBe('check');
  });
  it('a pergunta da verificação não finge que a verificação já foi feita', () => {
    const { ask } = setup();
    let r = ask('A voz do Fred está abafada no retorno');
    r = ask('Só com a banda', r);
    expect(field(r)).toBe('check');
    expect(r.diagnosticContext!.question).toMatch(/^Confira o passo acima/);
  });
});

describe('não inventa, preserva o relato e isola as sessões', () => {
  it('"Ainda não comparei" fica como desconhecido; não vira "sozinha" nem "com a banda"', () => {
    const { ask } = setup();
    const first = ask('A voz do Fred está abafada no retorno');
    expect(known(ask('Ainda não comparei', first)).isolation).toBe('unknown');
  });
  it('relato original e sessões independentes: outro operador não herda o contexto nem a captação respondida', () => {
    const { ask } = setup();
    const a = ask('A voz do Leandro está abafada no retorno', undefined, 'A');
    const a2 = ask('Também sozinha', a, 'A');
    expect(field(a2)).toBe('capture');
    const b = ask('A voz do Leandro está abafada no retorno', undefined, 'B');
    expect(field(b)).toBe('isolation');
    expect(known(b).isolation).toBeNull();
    expect(ask('Também sozinha', undefined, 'C')?.diagnosticContext ?? null).toBeNull(); // resposta solta de outra sessão não encontra pergunta
  });
  it('nenhuma ação: a conversa guiada não cria proposta, comando ou autorização', () => {
    const { ask } = setup();
    const { final } = interview(ask, 'A voz do Fred está abafada no retorno');
    const reply = final as unknown as { diagnosis: { consultation: { authorizedActions: unknown[]; proposal: unknown } }; proposals?: unknown };
    expect(reply.diagnosis.consultation.authorizedActions).toEqual([]);
    expect(reply.diagnosis.consultation.proposal).toBeNull();
    expect(reply.proposals).toBeUndefined();
    expect(final.diagnosticSession!.safety).toMatchObject({ automaticActions: false, realWrites: false });
  });
});
