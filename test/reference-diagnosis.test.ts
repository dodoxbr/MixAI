import { expect, it } from 'vitest';
import { diagnose } from '../src/knowledge/sound-engineer/diagnose.js';
for (const symptom of ['abafado', 'microfonia'] as const) it(`keeps ${symptom} musician provenance and emits only non-executable theoretical inspections`, () => {
  const report = { id: 'musician-report', kind: 'musician_report', verification: 'unverified', symptom, detail: 'Relato do músico, não confirmado.' };
  const r = diagnose({ symptom, instrument: 'vozes', channel: 4, destination: 'fones', evidence: [report] });
  expect(r.status).toBe('theoretical_guidance'); expect(r.audioAnalysis).toBe('not_performed');
  expect(r.confidence).toMatchObject({ level: 'low', basis: 'musician_report_only' });
  expect(r.consultation.evidence.reports).toEqual([report]);
  expect(r.recommendations.length).toBeGreaterThan(0);
  expect(r.recommendations.every(x => x.kind === 'inspection' && x.execution === 'not_executable')).toBe(true);
  expect(r.consultation.recommendations.every(x => x.validationStatus === 'theory' && x.requiresApproval)).toBe(true);
  expect(r.consultation.proposal).toBeNull(); expect(r.consultation.authorizedActions).toEqual([]);
  expect(r.consultation.evidence.controlReadings).toEqual([]); expect(r.consultation.evidence.unavailableMeasurements).toContain('audio');
});
