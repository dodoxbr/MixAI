import { expect, it } from 'vitest';
import { rehearseAutoConfig } from '../scripts/autoconfig-rehearsal.js';
it('comparação offline registra fundamentação, reversão e recusas em vez de alegar qualidade de modelos reais', async () => {
  const r = await rehearseAutoConfig(); expect(r.mode).toBe('offline_fixtures_only'); expect(r.results).toHaveLength(16);
  for (const row of r.results) {
    expect(row.execution).toBe('not_executable');
    if (row.status === 'proposal') { expect(row.grounded).toBe(true); expect(row.validationAndRollback).toBe(true); expect(row.numericTarget).toBeNull(); expect(row.authorization).toBe('not_granted'); }
    else expect(row.refusedCorrectly).toBe(true);
  }
});
