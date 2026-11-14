import { aged, bandCurve, parseProcessing, unknownReading } from './processing-view';
import { processingFixture as response } from './processing-fixture';
it('uses independent evidence only; computes a theoretical band curve and ages confirmed readings', () => {
  const parsed = parseProcessing(response(), 3, 'srv-1');
  const read = (s: string) => parsed.parameters[`ch.3.eq.${s}`] ?? unknownReading();
  expect(read('b4.gain').value).toBe(-1);
  expect(bandCurve(read)?.path).toMatch(/^M/);
  expect(aged(read('b4.gain'), 3001).state).toBe('last_observation');
  expect(bandCurve((s) => aged(read(s), 4000))?.old).toBe(true);
});
it('suppresses partial, unknown, previous generation and uncertain curves, without filling defaults', () => {
  const body = response();
  delete body.parameters['ch.3.eq.b1.q'];
  let p = parseProcessing(body, 3, 'srv-1');
  expect(bandCurve((s) => p.parameters[`ch.3.eq.${s}`] ?? unknownReading())).toBeNull();
  const complete = response();
  complete.connection.generation = 8;
  p = parseProcessing(complete, 3, 'srv-1');
  expect(p.parameters['ch.3.eq.b4.gain']!.state).toBe('stale');
  expect(bandCurve((s) => p.parameters[`ch.3.eq.${s}`]!)).toBeNull();
  expect(aged({ ...unknownReading(), state: 'stale' }, 9999).state).toBe('stale');
});
it('rejects optimistic/invalid readings and fences channel/server responses', () => {
  const b = response();
  b.parameters['ch.3.eq.b4.gain'] = { state: 'confirmed', value: -1 } as any;
  (b.parameters['ch.3.eq.b1.q'] as any).display.value = NaN;
  const p = parseProcessing(b, 3, 'srv-1');
  expect(p.parameters['ch.3.eq.b4.gain']!.state).toBe('unknown');
  expect(p.parameters['ch.3.eq.b1.q']!.state).toBe('unknown');
  expect(() => parseProcessing(b, 2, 'srv-1')).toThrow();
  expect(() => parseProcessing(b, 3, 'other')).toThrow();
});
