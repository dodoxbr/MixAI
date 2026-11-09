import { isDone, progressOf, progressText, stepStatus, STATUS_LABEL } from './soundcheck-progress';

const plan = Array.from({ length: 13 }, (_, i) => ({ id: `s${i + 1}` }));
const rec = (stepId: string, status: string) => ({ human: { stepId, status } });

describe('progresso da passagem de som', () => {
  it('sem registros: tudo pendente e 0%', () => {
    expect(progressOf(plan, [])).toEqual({ total: 13, done: 0, problems: 0, pending: 13, percent: 0 });
    expect(progressOf(plan, undefined).pending).toBe(13);
  });

  it('só verificada e não aplicável contam como concluídas; problema e pendente não', () => {
    const steps = [rec('s1', 'verified'), rec('s2', 'not_applicable'), rec('s3', 'problem'), rec('s4', 'pending')];
    expect(progressOf(plan, steps)).toEqual({ total: 13, done: 2, problems: 1, pending: 11, percent: 15 });
    expect(isDone('verified')).toBe(true);
    expect(isDone('not_applicable')).toBe(true);
    expect(isDone('problem')).toBe(false);
    expect(isDone('pending')).toBe(false);
  });

  it('status desconhecido ou etapa fora do plano não infla o progresso', () => {
    expect(stepStatus([rec('s1', 'aprovado-por-ia')], 's1')).toBe('pending');
    expect(progressOf(plan, [rec('inexistente', 'verified')]).done).toBe(0);
  });

  it('todas verificadas = 100%; o texto não afirma validação física', () => {
    const all = plan.map((p) => rec(p.id, 'verified'));
    const p = progressOf(plan, all);
    expect(p).toMatchObject({ done: 13, pending: 0, percent: 100 });
    expect(progressText(p)).toBe('13 de 13 etapas concluídas');
    expect(progressText(progressOf(plan, [rec('s1', 'verified'), rec('s2', 'problem')]))).toBe('1 de 13 etapas concluídas · 1 com problema');
    expect(JSON.stringify(STATUS_LABEL)).not.toMatch(/validad|aprovad.*acústic|físic/i);
  });

  it('plano vazio não divide por zero', () => {
    expect(progressOf([], [])).toEqual({ total: 0, done: 0, problems: 0, pending: 0, percent: 0 });
  });
});
