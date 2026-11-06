import type { Instrument, InstrumentGuide, Reference } from './contracts.js';
const references: readonly Reference[] = [
  { source: 'shure-live', locator: 'pp. 20–21, regras gerais de captação e experimentação' },
  { source: 'yamaha-eq', locator: 'Peak EQ; filtros; fundamentos de separação' },
];
const guide = (instrument: Instrument, role: string, captureChecks: string[], conditionalAdvice: string[], avoid: string): InstrumentGuide => ({
  instrument, role, captureChecks, conditionalAdvice, avoid, validation: 'not_validated_in_rehearsal', references,
});
/** Adaptações editoriais MixAI ao repertório; não são presets oficiais nem receitas validadas. */
export const instruments: Readonly<Record<Instrument, InstrumentGuide>> = {
  cavaco: guide('cavaco', 'Condução harmônica com ataque curto e definição rítmica.',
    ['Identificar microfone ou captador/DI e impedância compatível.', 'Se microfonado, comparar posição próxima ao braço/corpo e ao ataque, controlando vazamento da roda.'],
    ['Se estridente, revisar ataque/captação antes de discutir redução de presença.', 'Se embolado, avaliar grave sem função musical e competição com violão; HPF é condicionado à escuta do operador.', 'Nos fones, preservar referência rítmica sem encobrir vozes.'],
    'Não retirar todo o corpo nem adicionar brilho indiscriminadamente para fazê-lo aparecer.'),
  violao: guide('violao', 'Harmonia e, no 7 cordas, baixarias que também ocupam o grave.',
    ['Confirmar se é 6 ou 7 cordas e se usa DI ou microfone.', 'Se houver excesso de ressonância, revisar posição em relação à boca; conferir compatibilidade do captador.'],
    ['Se embolar com surdo/tantã, distinguir baixaria intencional de excesso de corpo.', 'Se magro, revisar HPF e DI antes de reforçar graves.', 'Se sumir apenas no conjunto, discutir espaço no arranjo/cavaco antes de elevar nível.'],
    'Não aplicar HPF de cavaco ao violão de 7 cordas sem avaliar as notas graves.'),
  surdo: guide('surdo', 'Fundação do pulso e peso da roda.',
    ['Registrar afinação, abafamento, posição do microfone e distância de paredes.', 'Comparar corpo e ataque no relato do operador; conferir se o PA reproduz o grave esperado.'],
    ['Se embolado, revisar ressonância/ambiente e sustentação em conflito com tantã.', 'Se magro, verificar HPF/cortes antes de boost; manter a fundamental musical.', 'Nos fones, buscar pulso legível sem exigir volume alto de grave.'],
    'Não usar corte alto padronizado, gate agressivo ou boost de subgrave para compensar limites do PA.'),
  tanta: guide('tanta', 'Sustentação do groove e articulação das mãos junto ao surdo.',
    ['Registrar pele/afinação e relação entre captação de mão, pele e ressonância.', 'Verificar vazamento de surdo na captação.'],
    ['Se embolado, comparar tantã e surdo em passagens alternadas e depois juntos.', 'Se abafado, revisar captação do ataque antes de acrescentar presença.', 'Se perde notas suaves, inspecionar gate/compressão manualmente com operador.'],
    'Não tratar tantã como bumbo nem apagar sustentação e notas fracas com gate.'),
  pandeiro: guide('pandeiro', 'Une grave da pele, articulação e brilho das platinelas.',
    ['Identificar equilíbrio pele/platinelas na posição do microfone.', 'Revisar técnica e vazamento; não presumir que só produz agudos.'],
    ['Se estridente, rever ângulo para platinelas antes de EQ.', 'Se magro, verificar se HPF removeu a contribuição grave da pele.', 'Se domina a roda, discutir captação e balanço antes de retirar todo o brilho.'],
    'Não aplicar HPF extremo por tratá-lo como chimbal; preservar a função da pele.'),
  vozes: guide('vozes', 'Inteligibilidade da voz principal e resposta do coro.',
    ['Confirmar qual voz, distância/eixo do microfone e se a queixa ocorre em todas.', 'Revisar efeito de proximidade, vazamento da roda e posição do PA conforme padrão polar.'],
    ['Se embolada, discutir captação/HPF preservando corpo e tessitura.', 'Se estridente apenas nas consoantes, distinguir sibilância de presença; de-esser só manual na interface oficial.', 'Se some nos refrões, revisar distância e competição com instrumentos antes de compressão; AUX 1 afeta todos.'],
    'Não subir todas as vozes nem alterar ganho/phantom por diagnóstico textual; não usar gate que corte finais de palavras.'),
};
