import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eqFilters, magnitudeDB, peakCoefficients, plotFrequency, plotPosition, type EqResponse } from '../src/core/eq-response.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';
import { LabMixer } from '../src/mixer/lab.js';
import { ServerCore } from '../src/server/core.js';
import type { ParamKey } from '../src/core/revisions.js';

const neutral = (): EqResponse => ({
  bands: [120, 500, 2000, 8000].map((freq) => ({ freq, q: 1, gain: 0 })),
  hpf: { freq: 20, slope: 12 },
  bypass: false,
});
describe('RBJ estimated EQ', () => {
  it('zero gain and disabled HPF are flat, including endpoints', () => {
    for (const f of [20, 120, 1000, 8000, 22050]) expect(magnitudeDB(eqFilters(neutral()), f)).toBeCloseTo(0, 7);
  });
  it.each([-20, -6, 6, 20])('central peak equals %s dB', (gain) => {
    for (const freq of [20, 1000, 22050])
      for (const q of [0.05, 1, 15]) {
        expect(magnitudeDB([peakCoefficients({ freq, q, gain })], freq)).toBeCloseTo(gain, 6);
      }
  });
  it.each([12, 24, 36])('Butterworth %s dB/oct is -3.0103 dB at cutoff', (slope) => {
    const eq = neutral();
    eq.hpf = { freq: 100, slope };
    expect(magnitudeDB(eqFilters(eq), 100)).toBeCloseTo(-3.0102999566, 6);
    expect(magnitudeDB(eqFilters(eq), 25)).toBeLessThan(-slope * 1.9);
  });
  it('bypass flattens both bands and HPF; log mapping round trips', () => {
    const eq = neutral();
    eq.bands[0]!.gain = 20;
    eq.hpf.freq = 1000;
    eq.bypass = true;
    expect(magnitudeDB(eqFilters(eq), 20)).toBe(0);
    for (const f of [20, 500, 22050]) expect(plotFrequency(plotPosition(f))).toBeCloseTo(f, 8);
  });
});

type Lab = Awaited<ReturnType<typeof startTestServer>>;
const labs: Lab[] = [];
const sockets: Awaited<ReturnType<typeof wsClient>>[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const l of labs.splice(0)) await l.server.close();
});
async function setup() {
  const l = await startTestServer();
  labs.push(l);
  return { l, op: await l.login(OPERATOR_PIN) };
}
const gain = 'ch.1.eq.b1.gain';
const read = (l: Lab, key = gain) => {
  const r = l.mixer.read(key as ParamKey);
  if (!r.known) throw new Error('unknown');
  return r;
};

describe('LAB EQ commands', () => {
  it('HTTP edit synchronizes two WS clients; reset and undo are single batches; restart persists', async () => {
    const { l, op } = await setup();
    const a = await wsClient(l.base, op),
      b = await wsClient(l.base, op);
    sockets.push(a, b);
    await Promise.all([a.next((m) => m.type === 'snapshot'), b.next((m) => m.type === 'snapshot')]);
    const values = { [gain]: 6, 'ch.1.eq.b1.q': 0.06, 'ch.1.eq.hpf.freq': 100, 'ch.1.eq.hpf.slope': 36, 'ch.1.eq.bypass': true };
    expect((await l.command(op, { type: 'set_lab_eq', channel: 1, values })).json.result.ok).toBe(true);
    const [ea, eb] = await Promise.all([a.next((m) => m.type === 'event'), b.next((m) => m.type === 'event')]);
    expect(ea.event).toEqual(eb.event);
    expect(ea.event.changes).toHaveLength(5);
    expect(a.sync.state).toEqual(b.sync.state);
    (l.mixer as LabMixer).flush();
    const restored = new LabMixer({ file: l.loaded.labFile });
    await restored.connect();
    for (const [k, value] of Object.entries(values)) expect(restored.read(k as ParamKey)).toEqual({ known: true, value });
    await restored.disconnect();
    expect((await l.command(op, { type: 'reset_lab_eq', channel: 1 })).json.result.ok).toBe(true);
    expect(read(l).value).toBe(0);
    expect(read(l, 'ch.1.eq.bypass').value).toBe(false);
    await l.command(op, { type: 'undo' });
    for (const [k, value] of Object.entries(values)) expect(read(l, k).value).toBe(value);
    await l.command(op, { type: 'undo' });
    expect(read(l).value).toBe(0);
    expect(read(l, 'ch.1.eq.b1.q').value).toBe(1);
  });
  it('rejects whole invalid batches, cross-channel and non-EQ keys; accepts registry endpoints', async () => {
    const { l, op } = await setup();
    for (const [key, value] of Object.entries({
      'ch.1.eq.b1.freq': 19,
      'ch.1.eq.b1.q': 0.049,
      'ch.1.eq.b1.gain': 20.01,
      'ch.1.eq.hpf.freq': 1001,
      'ch.1.eq.hpf.slope': 18,
      'ch.1.eq.bypass': 1,
      'ch.2.eq.b1.gain': 5,
      'master.level': 0,
    })) {
      const revision = l.controller.state.snapshot().revision;
      expect((await l.command(op, { type: 'set_lab_eq', channel: 1, values: { [gain]: 6, [key]: value } })).json.result.code).toBe(
        'INVALID',
      );
      expect(l.controller.state.snapshot().revision).toBe(revision);
    }
    for (const [key, value] of Object.entries({
      'ch.1.eq.b1.freq': 22050,
      'ch.1.eq.b1.q': 0.05,
      'ch.1.eq.b1.gain': -20,
      'ch.1.eq.hpf.freq': 1000,
      'ch.1.eq.hpf.slope': 24,
    })) {
      expect((await l.command(op, { type: 'set_lab_eq', channel: 1, values: { [key]: value } })).json.result.ok).toBe(true);
    }
    expect((await l.command(op, { type: 'set_lab_eq', channel: 1, values: {} })).json.result.code).toBe('INVALID');
    expect((await l.command(op, { type: 'reset_lab_eq', channel: 12 })).json.result.code).toBe('INVALID');
  });
  it('musician and agent cannot forge EQ via HTTP or WS', async () => {
    const { l } = await setup();
    for (const token of [await l.login(MUSICIAN_PIN), readFileSync(`${l.dir}/agent-lab.token`, 'utf8')]) {
      const c = await wsClient(l.base, token);
      sockets.push(c);
      await c.next((m) => m.type === 'snapshot');
      for (const command of [
        { type: 'set_lab_eq', channel: 1, values: { [gain]: 6 } },
        { type: 'reset_lab_eq', channel: 1 },
      ]) {
        expect((await l.command(token, command)).json.result.code).toBe('FORBIDDEN');
        c.ws.send(JSON.stringify({ type: 'command', requestId: command.type, command }));
        expect((await c.next((m) => m.type === 'result' && m.requestId === command.type)).result.code).toBe('FORBIDDEN');
      }
    }
    expect(read(l).value).toBe(0);
  });
  it('REAL server and REAL adapter each independently deny EQ before writes', async () => {
    const { l, op } = await setup();
    const write = vi.spyOn(l.mixer, 'write');
    const core = new ServerCore(l.controller, l.mixer, 'real', l.server.core.auth, l.server.app.log, { musicianAux: 1 });
    const p = { id: 'operator-test', role: 'operator' as const, label: 'test' };
    for (const command of [
      { type: 'set_lab_eq', channel: 1, values: { [gain]: 6 } },
      { type: 'reset_lab_eq', channel: 1 },
    ]) {
      expect((await core.execute(p, { requestId: command.type, command })).result.code).toBe('MODE_MISMATCH');
    }
    Object.defineProperty(l.server.core, 'mode', { value: 'real', configurable: true });
    const c = await wsClient(l.base, op);
    sockets.push(c);
    await c.next((m) => m.type === 'snapshot');
    for (const command of [
      { type: 'set_lab_eq', channel: 1, values: { [gain]: 6 } },
      { type: 'reset_lab_eq', channel: 1 },
    ]) {
      expect((await l.command(op, command)).json.result.code).toBe('MODE_MISMATCH');
      c.send({ type: 'command', requestId: command.type, command });
      expect((await c.next((m) => m.type === 'result' && m.requestId === command.type)).result.code).toBe('MODE_MISMATCH');
    }
    Object.defineProperty(l.server.core, 'mode', { value: 'lab', configurable: true });
    Object.defineProperty(l.mixer, 'mode', { value: 'real', configurable: true });
    expect((await l.controller.editLabEq(1, { [gain]: 6 })).code).toBe('MODE_MISMATCH');
    Object.defineProperty(l.mixer, 'mode', { value: 'lab', configurable: true });
    expect(write).not.toHaveBeenCalled();
  });
});
