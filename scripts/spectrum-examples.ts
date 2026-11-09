/** Fixed synthetic fixtures only. Prints JSON; never captures audio, reads files or contacts services. */
import { analyzePcm, compareSpectra } from '../src/audio-intelligence/index.js';
import { pcm, pilotOrigins, tones } from '../test/fixtures/audio-intelligence/signals.js';
const cases = [
  { name: 'CH8_surdo', origin: pilotOrigins.surdo, before: [[46.875, 0.5]], after: [[187.5, 0.5]] },
  { name: 'CH3_voz', origin: pilotOrigins.voz, before: [[750, 0.5]], after: [[3000, 0.5]] },
  { name: 'CH1_cavaco', origin: pilotOrigins.cavaco, before: [[3000, 0.5]], after: [[9000, 0.5]] },
  { name: 'AUX1_mix_artificial', origin: pilotOrigins.aux1, before: [[93.75, 0.2], [1500, 0.2]], after: [[93.75, 0.1], [1500, 0.2], [6000, 0.1]] },
] satisfies Array<{ name: string; origin: typeof pilotOrigins.surdo; before: Array<[number, number]>; after: Array<[number, number]> }>;
const examples = cases.map(c => {
  const before = analyzePcm(pcm(tones(c.before), { origin: c.origin }));
  const after = analyzePcm(pcm(tones(c.after), { origin: c.origin }));
  // Excerpts omit the dense bin array; comparison itself is complete.
  const { bins: _beforeBins, ...beforeSummary } = before;
  const { bins: _afterBins, ...afterSummary } = after;
  return { scenario: c.name, excerpt: true, omitted: ['bins'], before: beforeSummary, after: afterSummary, comparison: compareSpectra(before, after) };
});
// One complete, schema-valid measurement, small enough to inspect/export.
const completeMeasurement = analyzePcm(pcm(tones([[1500, 0.5]], 48000, 256), { origin: pilotOrigins.voz, settings: { fftSize: 256, peakCount: 3 } }));
console.log(JSON.stringify({ notice: 'LAB: SYNTHETIC PCM ONLY. Not real band audio; no diagnostic verdict or EQ settings.', completeMeasurement, examples }, null, 2));
