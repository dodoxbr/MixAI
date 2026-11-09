import type { PlannerInput } from './contracts.js';
/** Fictional classified reports, never physical evidence or authority. */
export const autoConfigCases: ReadonlyArray<{ id: string; input: PlannerInput }> = [
  { id: 'surdo-sem-grave', input: { mode: 'LAB', channel: 8, symptom: 'magro', goal: 'body', destination: 'pa', comparison: 'target_only', isolation: 'alone', report: { id: 'fixture-surdo', kind: 'musician_report', symptom: 'magro', detail: 'Fixture: falta de grave relatada, causa não validada.' } } },
  { id: 'voz-abafada-aux1', input: { mode: 'LAB', channel: 6, symptom: 'abafado', goal: 'comfortable_monitoring', destination: 'fones', comparison: 'unknown', isolation: 'alone', report: { id: 'fixture-voz', kind: 'operator_report', symptom: 'abafado' } } },
  { id: 'lead-vs-coro', input: { mode: 'LAB', channel: 3, symptom: 'desequilibrio', goal: 'intelligibility', destination: 'pa', comparison: 'target_only', isolation: 'ensemble', report: { id: 'fixture-lead', kind: 'musician_report', symptom: 'desequilibrio' } } },
  { id: 'microfonia-contida', input: { mode: 'LAB', channel: 4, symptom: 'microfonia', goal: 'feedback_safety', destination: 'fones', comparison: 'both', isolation: 'unknown', feedback: 'contained', report: { id: 'fixture-feedback', kind: 'operator_report', symptom: 'microfonia' } } },
];
