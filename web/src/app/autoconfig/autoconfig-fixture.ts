import type { AutoAdapter, AutoPlan } from './autoconfig-contract';
/** Demonstrates interaction only. Does not implement C's technical planner or D's mixer simulator. */
export const fixtureAdapter: AutoAdapter = {
  kind: 'fixture',
  async plan(input) {
    const common = {
      channel: input.channel,
      destination: input.destination,
      before: 'Cenário A fictício — não é o estado da mesa',
      evidence: 'Relato informado pelo operador; nenhuma captura de áudio.',
      risk: 'low' as const,
      preconditions: [
        'Revisar este item individualmente.',
        'Usar somente esta demonstração de interface.',
      ],
      limitations: [
        'Fixture de UX, não é uma recomendação técnica.',
        'Sem ganho, EQ ou parâmetro real calculado.',
      ],
      validation:
        'Conferir a transição de cenário na interface; resultado acústico permanece desconhecido.',
      rollback: 'Rejeitar o resultado descarta somente o cenário local.',
      references: [
        {
          title: 'Escopo da demonstração — Issue #74',
          url: 'https://github.com/dodoxbr/MixAI/issues/74',
        },
      ],
    };
    return {
      schemaVersion: 1,
      scope: 'lab_simulation',
      id: 'demo-plan',
      fixture: true,
      items: [
        {
          ...common,
          id: 'balance',
          title: 'Comparar equilíbrio (demonstração)',
          after: 'Cenário B fictício — equilíbrio alternativo',
          rationale:
            'Exercitar revisão de uma diferença antes de autorizar. O planejador C fornecerá sugestões fundamentadas.',
        },
        {
          ...common,
          id: 'clarity',
          title: 'Comparar clareza (demonstração)',
          after: 'Cenário C fictício — clareza alternativa',
          rationale:
            'Demonstrar que uma segunda comparação exige outra aprovação humana, independente da primeira.',
        },
      ],
    } satisfies AutoPlan;
  },
  async simulate({ plan, itemId }) {
    const item = plan.items.find((i) => i.id === itemId)!;
    return {
      schemaVersion: 1,
      scope: 'lab_simulation',
      planId: plan.id,
      itemId,
      before: item.before,
      after: item.after,
      verification:
        'Transição de cenário local concluída. Nenhum parâmetro da mix foi alterado; nenhum áudio foi ouvido ou medido.',
      acousticValidated: false,
    };
  },
};
