import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eqGuides, eqGuideContext, eqValues, compareEqGuide } from '../src/knowledge/sound-engineer/eq-guides.js';
import { eqFilters, magnitudeDB, plotFrequency } from '../src/core/eq-response.js';
import { ParamRegistry } from '../src/core/params.js';
import type { ParamKey } from '../src/core/revisions.js';
import { LabMixer } from '../src/mixer/lab.js';
import { OPERATOR_PIN, MUSICIAN_PIN, startTestServer, wsClient } from './server-support.js';

const registry = new ParamRegistry({ model: 'ui16', inputs: 12, aux: 6 });
const valuesFor = (i: number, channel = 1) => Object.fromEntries(Object.entries(eqValues(eqGuides[i]!.model)).map(([k, v]) => [`ch.${channel}.eq.${k}`, v]));

describe('editorial LAB EQ guide catalog', () => {
  it('covers the six sources with unique IDs, rationale, contraindications and resolvable knowledge references', () => {
    expect(eqGuides.map(g => g.id).sort()).toEqual(['cavaco', 'pandeiro', 'surdo', 'tanta', 'violao', 'vozes']);
    for (const guide of eqGuides) {
      expect(guide.purpose.length).toBeGreaterThan(20);
      expect(guide.rationale.length).toBeGreaterThan(20);
      expect(guide.contraindication.length).toBeGreaterThan(20);
      const context = eqGuideContext(guide);
      expect(context.instrument.instrument).toBe(guide.id);
      expect(context.references.length).toBeGreaterThan(0);
      for (const ref of context.references) expect(ref.url).toMatch(/^https:\/\//);
    }
  });
  it.each(eqGuides)('$name uses only the 15 registered simulated EQ parameters and conservative cuts', guide => {
    const entries = Object.entries(eqValues(guide.model));
    expect(entries).toHaveLength(15);
    for (const [key, value] of entries) {
      const k = `ch.1.eq.${key}` as ParamKey;
      expect(registry.validate(k, value)).toBeUndefined();
      expect(registry.get(k)).toMatchObject({ capability: 'simulated_only', applicableToMixer: false });
    }
    expect(guide.model.bands).toHaveLength(4);
    expect(guide.model.hpf.slope).toBe(12);
    for (const band of guide.model.bands) {
      expect(band.gain).toBeGreaterThanOrEqual(-2);
      expect(band.gain).toBeLessThanOrEqual(0);
    }
    const filters = eqFilters(guide.model);
    for (let i = 0; i <= 400; i++) expect(Number.isFinite(magnitudeDB(filters, plotFrequency(i / 400)))).toBe(true);
  });
  it('compares every parameter, including HPF and bypass; never mutates the actual state or catalog', () => {
    const target = eqGuides[0]!.model;
    const current = structuredClone(target);
    current.bands[0]!.gain = 1;
    current.hpf.slope = 36;
    current.bypass = true;
    const before = structuredClone(current);
    const rows = compareEqGuide(current, target);
    expect(rows).toHaveLength(15);
    expect(rows.filter(r => r.current !== r.proposed).map(r => r.key)).toEqual(['b1.gain', 'hpf.slope', 'bypass']);
    expect(rows.find(r => r.key === 'bypass')).toMatchObject({ current: true, proposed: false });
    expect(current).toEqual(before);
    expect(magnitudeDB(eqFilters(current), 80)).toBe(0);
    expect(magnitudeDB(eqFilters(target), 80)).toBeLessThan(-3);
  });
});

type Lab = Awaited<ReturnType<typeof startTestServer>>;
const labs: Lab[] = [];
const clients: Awaited<ReturnType<typeof wsClient>>[] = [];
afterEach(async () => {
  clients.splice(0).forEach(c => c.close());
  for (const l of labs.splice(0)) await l.server.close();
});
async function setup() {
  const l = await startTestServer();
  labs.push(l);
  return { l, op: await l.login(OPERATOR_PIN) };
}
const readValues = (l: Lab, values: Record<string, unknown>) => Object.fromEntries(Object.keys(values).map(k => [k, l.mixer.read(k as ParamKey)]));

describe('guides through existing LAB command path', () => {
  it('all guides apply as one undo batch via HTTP/WS, preserve other channels/levels, persist and save into a scene', async () => {
    const { l, op } = await setup();
    const c = await wsClient(l.base, op);
    clients.push(c);
    await c.next(m => m.type === 'snapshot');
    const other = readValues(l, { 'ch.2.eq.b1.gain': 0, 'ch.1.main.level': 0, 'ch.1.main.mute': 0, 'master.level': 0 });
    for (let i = 0; i < eqGuides.length; i++) {
      const values = valuesFor(i);
      const before = readValues(l, values);
      const command = { type: 'set_lab_eq', channel: 1, values };
      const result = i % 2 ? (await c.request({ type: 'command', command })).result : (await l.command(op, command)).json.result;
      expect(result.ok).toBe(true);
      for (const [key, value] of Object.entries(values)) expect(l.mixer.read(key as ParamKey)).toEqual({ known: true, value });
      expect((await l.command(op, { type: 'undo' })).json.result.ok).toBe(true);
      expect(readValues(l, values)).toEqual(before);
    }
    const values = valuesFor(0);
    await l.command(op, { type: 'set_lab_eq', channel: 1, values });
    (l.mixer as LabMixer).flush();
    const restored = new LabMixer({ file: l.loaded.labFile });
    await restored.connect();
    for (const [key, value] of Object.entries(values)) expect(restored.read(key as ParamKey)).toEqual({ known: true, value });
    await restored.disconnect();
    const save = (await l.command(op, { type: 'scene_save', name: 'Guia cavaco LAB' })).json.result;
    expect(save.ok).toBe(true);
    const exported = (await l.command(op, { type: 'scene_export', id: save.data.scene.id })).json.result;
    expect(exported.ok).toBe(true);
    const scene = JSON.parse(exported.data.json);
    for (const [key, value] of Object.entries(values)) expect(scene.params[key]).toEqual({ value, status: 'incompatible' });
    expect(readValues(l, other)).toEqual(other);
  });
  it('musician/agent denied over HTTP and WS; REAL mode denied at server and controller with no writes', async () => {
    const { l, op } = await setup();
    const command = { type: 'set_lab_eq', channel: 1, values: valuesFor(0) };
    const write = vi.spyOn(l.mixer, 'write');
    for (const token of [await l.login(MUSICIAN_PIN), readFileSync(`${l.dir}/agent-lab.token`, 'utf8')]) {
      expect((await l.command(token, command)).json.result.code).toBe('FORBIDDEN');
      const c = await wsClient(l.base, token);
      clients.push(c);
      await c.next(m => m.type === 'snapshot');
      expect((await c.request({ type: 'command', command })).result.code).toBe('FORBIDDEN');
    }
    Object.defineProperty(l.server.core, 'mode', { value: 'real', configurable: true });
    const c = await wsClient(l.base, op);
    clients.push(c);
    await c.next(m => m.type === 'snapshot');
    expect((await l.command(op, command)).json.result.code).toBe('MODE_MISMATCH');
    expect((await c.request({ type: 'command', command })).result.code).toBe('MODE_MISMATCH');
    Object.defineProperty(l.mixer, 'mode', { value: 'real', configurable: true });
    expect((await l.controller.editLabEq(1, command.values)).code).toBe('MODE_MISMATCH');
    Object.defineProperty(l.mixer, 'mode', { value: 'lab', configurable: true });
    expect(write).not.toHaveBeenCalled();
  });
});
