/**
 * Cálculo de progresso da passagem de som. Funções puras e somente de leitura: usam apenas o que o servidor já
 * devolveu (o plano e os registros humanos). Não decidem aprovação nem conclusão: quem conclui é o operador.
 */
export type StepStatus = 'pending' | 'verified' | 'problem' | 'not_applicable';

export const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Pendente',
  verified: 'Verificada',
  problem: 'Problema',
  not_applicable: 'Não aplicável',
};

interface Recorded { human: { stepId: string; status: string } }

/** Situação atual de uma etapa: sem registro (ou valor desconhecido) conta como pendente. */
export function stepStatus(steps: ReadonlyArray<Recorded> | undefined, id: string): StepStatus {
  const status = steps?.find((s) => s.human.stepId === id)?.human.status;
  return status === 'verified' || status === 'problem' || status === 'not_applicable' ? status : 'pending';
}

/** Concluída = verificada pelo operador ou marcada como não aplicável com justificativa. Problema e pendente não contam. */
export const isDone = (s: StepStatus): boolean => s === 'verified' || s === 'not_applicable';

export interface Progress { total: number; done: number; problems: number; pending: number; percent: number }

export function progressOf(plan: ReadonlyArray<{ id: string }>, steps: ReadonlyArray<Recorded> | undefined): Progress {
  const total = plan.length;
  let done = 0, problems = 0;
  for (const p of plan) {
    const s = stepStatus(steps, p.id);
    if (isDone(s)) done++;
    else if (s === 'problem') problems++;
  }
  return { total, done, problems, pending: total - done, percent: total ? Math.round((done / total) * 100) : 0 };
}

/** Texto curto, falado por leitores de tela: "5 de 13 etapas concluídas · 1 com problema". */
export function progressText(p: Progress): string {
  const base = `${p.done} de ${p.total} etapas concluídas`;
  return p.problems ? `${base} · ${p.problems} com problema` : base;
}
