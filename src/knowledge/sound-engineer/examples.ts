import type { DiagnosticInput } from './contracts.js';
/** Relatos fictícios; nenhum dado foi capturado da mesa. */
export const examples = {
  rodaEmbolada: { symptom: 'embolado', evidence: [{ id: 'relato-1', kind: 'operator_report', symptom: 'embolado', detail: 'Com todos tocando, não separo as baixarias do violão e o tantã.' }] },
  cavacoEstridente: { symptom: 'estridente', instrument: 'cavaco', destination: 'pa', evidence: [{ id: 'relato-2', kind: 'operator_report', symptom: 'estridente', detail: 'O ataque do cavaco incomoda no PA; sem apito contínuo.' }] },
  vozAbafada: { symptom: 'abafado', instrument: 'vozes', destination: 'fones', evidence: [{ id: 'relato-3', kind: 'operator_report', symptom: 'abafado', detail: 'No AUX 1, a voz perde dicção ao entrar o coro.' }] },
  surdoMagro: { symptom: 'magro', instrument: 'surdo', destination: 'pa', evidence: [{ id: 'relato-4', kind: 'operator_report', symptom: 'magro', detail: 'No PA falta corpo no surdo, inclusive sozinho.' }] },
  pandeiroDominante: { symptom: 'desequilibrio', instrument: 'pandeiro', destination: 'fones', evidence: [{ id: 'relato-5', kind: 'operator_report', symptom: 'desequilibrio', detail: 'Todos reclamam que o pandeiro encobre a voz no AUX 1.' }] },
  apenasControles: { symptom: 'embolado', instrument: 'tanta', destination: 'pa', evidence: [
    { id: 'estado-1', kind: 'control_state', parameter: 'ch.8.master.level', value: -10, revision: 12, detail: 'Fader observado, não é nível de sinal.' },
    { id: 'simulado-1', kind: 'simulated_meter', valueDB: -24, detail: 'Quadro fictício de laboratório.' },
  ] },
} satisfies Record<string, DiagnosticInput>;
