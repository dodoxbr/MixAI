import type { ComparisonParam, ComparisonPortrait, LabRealDiffInput } from '../../src/core/lab-real-diff.js';

export const FIXTURE_TIME = '2026-11-06T10:00:00.000Z';
export function known(value: number | boolean | '-inf', revision = 2): ComparisonParam {
  return { value: { status: 'known', value }, revision, support: 'supported' };
}
/** Cada chamada cria dados novos; nenhum endereço de mesa, segredo ou adapter. */
export function labRealFixture(): LabRealDiffInput {
  const base: ComparisonPortrait = {
    mode: 'lab', device: { model: 'ui16', inputs: 12, aux: 6 }, origin: 'fixture', capturedAt: FIXTURE_TIME,
    revision: 10, freshness: 'fresh', available: true, link: 'READY', params: {},
  };
  return {
    comparedAt: FIXTURE_TIME,
    lab: { ...structuredClone(base), params: {
      'ch.1.main.level': known(-10), 'ch.1.main.mute': known(false),
      'ch.2.main.level': known('-inf'), 'ch.2.main.mute': known(true),
      'ch.1.aux.1.level': known(-20), 'ch.1.aux.1.mute': known(false),
      'master.level': known(-6), 'ch.3.main.level': known(-4), 'ch.4.main.level': known(-8),
      'ch.1.eq.b1.gain': known(3), 'ch.1.eq.hpf.freq': known(120), 'ch.1.eq.hpf.slope': known(24),
      'ch.1.eq.bypass': known(false), 'ch.99.main.level': known(-10),
    } },
    real: { ...structuredClone(base), mode: 'real', params: {
      'ch.1.main.level': known(-10.02), 'ch.1.main.mute': known(true),
      'ch.2.main.level': known('-inf'), 'ch.2.main.mute': known(true),
      'ch.1.aux.1.level': known(-12), 'ch.1.aux.1.mute': known(true),
      'master.level': known(-6), 'ch.3.main.level': { value: { status: 'unknown' }, revision: 0, support: 'supported' },
      'ch.5.main.level': known(-5), 'ch.1.eq.b1.gain': known(3), 'ch.1.eq.hpf.freq': known(120),
      'ch.1.eq.hpf.slope': known(24), 'ch.1.eq.bypass': known(false), 'ch.99.main.level': known(-10),
    } },
  };
}
