import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DiagnosticContexts, CONTEXT_TTL_MS, type ContextualReply } from '../src/assistant/diagnostic-context.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';

const names = () => new ChannelMap(parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8'))), { inputs: 12, aux: 6 });
const stamp = (r: ContextualReply) => ({ id: r.diagnosticContext!.id, revision: r.diagnosticContext!.revision });
function setup(options: ConstructorParameters<typeof DiagnosticContexts>[2] = {}) {
  let time = 1000;
  const store = new DiagnosticContexts(names(), 1, { clock: () => time, ...options });
  const ask = (text: string, context?: ReturnType<typeof stamp>, id = 'operator-1') => store.handle(id, text, context)!;
  return { store, ask, advance: (ms: number) => { time += ms; } };
}
const diagnosis = (r: ContextualReply) => { expect(r.kind).toBe('diagnosis'); return r.kind === 'diagnosis' ? r.diagnosis! : undefined!; };

describe('contexto determinístico efêmero', () => {
  it('PA continua a queixa com o relato necessário e encerra o contexto', () => {
    const { ask, store } = setup();
    const pending = ask('Meu cavaco está estridente. O que podemos fazer? Minha senha está em outro lugar.');
    expect(pending.diagnosticContext?.field).toBe('destination');
    const ready = ask('PA.', stamp(pending));
    expect(diagnosis(ready).evidence).toEqual(diagnosis(pending).evidence);
    expect(diagnosis(ready).evidence[0].detail).toBe('Meu cavaco está estridente.');
    expect(ready.text).toContain('Cavaco (canal 1). Destino: PA');
    expect(ready.diagnosticContext).toBeNull();
    expect(store.size).toBe(0);
    expect(ask('Fones').code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
  });

  it('fonte por apelido/canal e fones preservam evidência inicial', () => {
    const { ask } = setup();
    const pending = ask('Minha voz está abafada');
    expect(pending.diagnosticContext?.field).toBe('channel');
    const source = ask('Fred', stamp(pending));
    expect(source.diagnosticContext?.revision).toBe(2);
    expect(source.diagnosticContext?.field).toBe('destination');
    expect(source.diagnosticContext?.subject).toContain('Voz Fred');
    const ready = ask('nos fones', stamp(source));
    expect(ready.text).toContain('AUX 1 compartilhado');
    expect(diagnosis(ready).evidence).toEqual(diagnosis(pending).evidence);
  });

  it('esclarecer sintoma não inventa relato nem perde canal', () => {
    const { ask } = setup();
    const start = ask('diagnóstico do cavaco');
    const symptom = ask('estridente', stamp(start));
    expect(symptom.diagnosticContext?.subject).toContain('Cavaco');
    expect(diagnosis(symptom).evidence).toEqual([]);
    const ready = ask('PA', stamp(symptom));
    expect(diagnosis(ready).confidence.level).toBe('insufficient');
    expect(diagnosis(ready).recommendations).toEqual([]);
  });

  it.each(['Meu cavaco está estridente?', 'Será que meu cavaco está estridente?', 'Se meu cavaco está estridente no PA', 'Meu cavaco não está estridente', 'Por que meu cavaco está estridente'])('pergunta/hipótese/negação não vira evidência: %s', text => {
    const { ask } = setup();
    expect(diagnosis(ask(text)).evidence).toEqual([]);
  });

  it('resposta errada ou ambígua mantém pergunta, revisão, evidências e prazo', () => {
    const { ask } = setup();
    const pending = ask('Meu cavaco está estridente');
    for (const text of ['sim', 'não é PA', 'PA e Fones', 'surdo', 'se for PA']) {
      const wrong = ask(text, stamp(pending));
      expect(wrong.code).toBe('DIAGNOSIS_CLARIFY');
      expect(wrong.diagnosticContext).toEqual(pending.diagnosticContext);
    }
    expect(diagnosis(ask('PA', stamp(pending))).evidence).toEqual(diagnosis(pending).evidence);
  });

  it('novo assunto substitui dados antigos; cancelar e reiniciar não restauram evidência', () => {
    const { ask, store } = setup();
    const first = ask('Meu cavaco está estridente');
    const next = ask('Meu surdo está magro', stamp(first));
    expect(next.diagnosticContext?.id).not.toBe(first.diagnosticContext?.id);
    expect(next.diagnosticContext?.subject).not.toContain('Cavaco');
    expect(diagnosis(next).evidence.map(e => e.detail)).toEqual(['Meu surdo está magro']);
    expect(ask('cancelar diagnóstico', stamp(next)).code).toBe('DIAGNOSIS_CANCELLED');
    expect(store.size).toBe(0);
    const fresh = ask('novo diagnóstico');
    expect(fresh.diagnosticContext?.field).toBe('symptom');
    expect(fresh.text).not.toContain('Meu cavaco');
  });

  it('prazo absoluto: resposta inválida não renova TTL; limite exato elimina entrada', () => {
    const { ask, advance, store } = setup();
    const first = ask('Minha voz está abafada');
    advance(CONTEXT_TTL_MS - 1);
    const second = ask('canal 3', stamp(first));
    expect(second.diagnosticContext?.expiresAt).toBe(first.diagnosticContext?.expiresAt);
    advance(1);
    expect(ask('PA', stamp(second)).code).toBe('DIAGNOSIS_CONTEXT_STALE');
    expect(store.size).toBe(0);
  });

  it('revisões rejeitam resposta concorrente e cancelamento antigo', () => {
    const { ask } = setup();
    const first = ask('Minha voz está abafada');
    const updated = ask('Fred', stamp(first));
    expect(ask('Lucius', stamp(first)).code).toBe('DIAGNOSIS_CONTEXT_STALE');
    expect(ask('cancelar', stamp(first)).code).toBe('DIAGNOSIS_CONTEXT_STALE');
    expect(ask('PA', stamp(updated)).text).toContain('Voz Fred');
  });

  it('sessões, revogação, reinício e sweeper não compartilham dados', () => {
    const { ask, store } = setup();
    const own = ask('Meu cavaco está estridente');
    expect(ask('PA', stamp(own), 'operator-2').code).toBe('DIAGNOSIS_CONTEXT_STALE');
    expect(ask('PA', undefined, 'operator-2').text).not.toContain('Cavaco');
    store.sweep(id => id !== 'operator-1');
    expect(store.size).toBe(0);
    expect(ask('PA').code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
    ask('Meu cavaco está estridente'); store.revoke('operator-1');
    expect(store.size).toBe(0);
    ask('Meu cavaco está estridente'); store.stop();
    expect(store.size).toBe(0);
    expect(setup().ask('PA').code).toBe('DIAGNOSIS_CONTEXT_REQUIRED');
  });

  it('limites de memória e taxa são independentes; cancelar é permitido no limite', () => {
    const { ask, store, advance } = setup({ maxPending: 1, requestsPerMinute: 2, maxSessions: 2 });
    const pending = ask('Meu cavaco está estridente');
    expect(ask('Minha voz está abafada', undefined, 'operator-2').code).toBe('DIAGNOSIS_CAPACITY');
    expect(ask('PA', undefined, 'operator-3').code).toBe('DIAGNOSIS_RATE_LIMIT');
    ask('sim');
    expect(ask('PA').code).toBe('DIAGNOSIS_RATE_LIMIT');
    expect(ask('cancelar', stamp(pending)).code).toBe('DIAGNOSIS_CANCELLED');
    expect(store.size).toBe(0);
    advance(60_000);
    expect(ask('Meu cavaco está estridente', undefined, 'operator-3').kind).toBe('diagnosis');
  });
});
