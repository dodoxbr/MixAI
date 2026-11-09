import type { Diagnosis, Instrument, Symptom } from './contracts.js';
import type { DiagnosticCheck, DiagnosticChoice, DiagnosticProgress, DiagnosticQuestion } from './conversation-contracts.js';
import { instruments } from './instruments.js';
import { procedures } from './procedures.js';

export interface DiagnosticPlan { question: DiagnosticQuestion | null; choices: DiagnosticChoice[]; nextCheck: DiagnosticCheck | null; complete: boolean; hypothesis?: string }
const question = (field: DiagnosticQuestion['field'], prompt: string, options: Array<[string, string]>): DiagnosticPlan => ({
  question: { id: field, field, prompt }, choices: options.map(([value, label]) => ({ id: `${field}:${value}`, label, value })), nextCheck: null, complete: false,
});
const check = (id: string, instruction: string, symptom: Symptom): DiagnosticCheck => ({ id, instruction,
  expectedObservation: 'Relatar melhora, ausência de mudança ou piora no mesmo trecho, em nível confortável; não é medição.',
  rollback: symptom === 'microfonia' ? 'Interromper o teste e chamar operador se houver apito; nunca restaurar estado inseguro.' : 'Parar se piorar. Reversão somente manual pelo operador, após conferir estado anterior seguro.',
  execution: 'not_executable', requiresHumanReview: true,
});
export function diagnosticChecks(symptom: Symptom, instrument: Instrument | undefined, progress: DiagnosticProgress): DiagnosticCheck[] {
  if (symptom === 'microfonia') return [
    check('containment', 'Sem provocar apito, peça ao operador conferir posição microfone/caixa, padrão polar e microfones abertos. Se o apito persistir, interrompa a escuta.', symptom),
    check('routing', 'Na UI oficial, apenas inspecione o caminho PA/AUX1 e mudanças recentes de nível; não habilite AFS2 nem provoque ring-out com público.', symptom),
  ];
  const guide = instrument ? instruments[instrument] : undefined;
  const capture = progress.capture === 'pickup_di'
    ? 'Peça ao operador conferir fonte, cabo/DI e compatibilidade da entrada, sem trocar conexões ou phantom durante a escuta.'
    : guide ? `${guide.captureChecks[instrument === 'cavaco' || instrument === 'violao' ? 1 : 0]} Confira em nível confortável; sem presumir medições.`
    : 'Se há microfone, confira eixo, distância e vazamento na mesma passagem, em nível confortável; não presuma modelo ou padrão polar.';
  const ensemble = instrument === 'vozes'
    ? 'Compare a articulação vocal quando entra o coro; observe se o cantor se afasta do microfone. Preserve dicção sem pedir esforço vocal ou subir todos.'
    : instrument === 'surdo' || instrument === 'tanta'
      ? 'Compare pulso e sustentação de surdo e tantã; confira afinação, abafamento e vazamento, sem usar gate como correção automática.'
      : instrument === 'cavaco' || instrument === 'violao'
        ? 'Compare ataque e espaço de cavaco e violão. Confirme seis ou sete cordas e preserve baixarias; não eleve toda a mix.'
        : instrument === 'pandeiro' ? 'Confira equilíbrio entre pele e platinelas e ângulo do microfone; preservar o ritmo não exige brilho excessivo.'
          : 'Compare a articulação da fonte no arranjo, sem elevar toda a mix.';
  const destination = 'Na UI oficial, apenas confira envio/MUTE e pre/post no destino escolhido. AUX1 é compartilhado; não copie o PA para os fones.';
  const processing = ['clip', 'ganho', 'ruido'].includes(symptom)
    ? 'Peça ao operador inspecionar entrada e indicadores na UI oficial. Fader não revela ganho real; não altere ganho ou phantom pelo diagnóstico.'
    : 'Na UI oficial, apenas inspecione HPF/EQ, gate e compressor existentes; um corte ou gate excessivo pode remover corpo e finais de palavras. Não altere parâmetros aqui.';
  return [
    check(progress.isolation === 'ensemble' ? 'balance' : 'capture', progress.isolation === 'ensemble' ? ensemble : capture, symptom),
    check('processing', processing, symptom),
    check('routing', progress.scope === 'selected_only' ? destination : procedures[symptom].checks[0]!, symptom),
  ];
}
/**
 * Deterministic planning from reported context; no mixer, model, IO, measured frequency or action.
 * Só pergunta o que ainda não se sabe. O destino (PA ou FONES) já foi dito antes de chegar aqui, então NÃO há pergunta de "só no PA ou
 * também nos fones" (o operador ainda pode dizê-lo por conta própria e isso é respeitado). A captação já cadastrada chega preenchida
 * em `progress`. Esclarecimentos possíveis: relato, isolamento e captação — no máximo três — antes das verificações.
 */
export function planDiagnosticConversation(diagnosis: Diagnosis, instrument: Instrument | undefined, _destination: 'pa' | 'fones', progress: DiagnosticProgress): DiagnosticPlan {
  const complete = (): DiagnosticPlan => ({ question: null, choices: [], nextCheck: null, complete: true });
  if (progress.report === 'conceptual') return complete();
  if (diagnosis.confidence.level === 'insufficient') return question('report', 'Você está relatando esse problema agora ou apenas consultando o conceito?', [['current', 'Estou relatando agora'], ['conceptual', 'Só consultando']]);
  if (!progress.isolation) return question('isolation', 'A fonte soa assim também sozinha ou só com a banda?', [['alone', 'Também sozinha'], ['ensemble', 'Só com a banda'], ['unknown', 'Ainda não comparei']]);
  if (!progress.capture && progress.isolation !== 'ensemble') return question('capture', 'Essa fonte usa microfone ou captador/DI?', [['microphone', 'Microfone'], ['pickup_di', 'Captador/DI'], ['unknown', 'Não sei a captação']]);
  if (progress.results.some(r => r.result === 'better' || r.result === 'worse' || r.result === 'issue_found')) return complete();
  const next = diagnosticChecks(diagnosis.symptom, instrument, progress).find(c => !progress.results.some(r => r.checkId === c.id));
  if (!next) return complete();
  const plan = question('check', 'Confira o passo acima. O que você encontrou?', [['issue_found', 'Encontrei um problema'], ['no_issue', 'Nada evidente'], ['better', 'Melhorou'], ['same', 'Sem mudança'], ['worse', 'Piorou'], ['not_checked', 'Não verifiquei']]);
  return { ...plan, question: { ...plan.question!, id: `check:${next.id}` }, nextCheck: next,
    hypothesis: progress.isolation === 'ensemble' ? 'Se a fonte soa clara sozinha, o arranjo pode mascarar a articulação; é hipótese.'
      : 'Se o problema também ocorre sozinho, captação ou processamento podem contribuir; é hipótese.',
  };
}
