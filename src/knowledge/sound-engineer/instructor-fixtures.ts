import { queryInstructorGuidance } from './field-library.js';
/** Fictional reports for B's instructor integration. Not rehearsal evidence or credentials. */
export function instructorFixtures() {
  return {
    voiceMuffled: queryInstructorGuidance({ symptom: 'abafado', instrument: 'vozes', channel: 3, destination: 'fones', evidence: [
      { id: 'fixture-voice', kind: 'operator_report', symptom: 'abafado', detail: 'Fixture: voz abafada relatada no retorno, sem medição.' },
    ] }),
    surdoNoBass: queryInstructorGuidance({ symptom: 'magro', instrument: 'surdo', channel: 8, destination: 'pa', evidence: [
      { id: 'fixture-surdo', kind: 'musician_report', verification: 'unverified', symptom: 'magro', detail: 'Fixture: falta de grave relatada, causa não validada.' },
    ] }),
    missingEvidence: queryInstructorGuidance({ symptom: 'microfonia', instrument: 'vozes', channel: 5, destination: 'pa', evidence: [] }),
  };
}
