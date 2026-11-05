import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/core/app.js';
import { parseChannels, parseConfig } from '../src/core/config.js';
import { ParamRegistry } from '../src/core/params.js';
import { paramKey, type ParamKey, type ParamValue } from '../src/core/revisions.js';
import { buildScene, diffValues, validateScene } from '../src/core/scene.js';
import { createMcpServer } from '../src/mcp/server.js';
import { LabMixer } from '../src/mixer/lab.js';
import { MASTER } from '../src/mixer/types.js';

const reg = new ParamRegistry({ model: 'ui16', inputs: 12, aux: 6 });
const UI16 = { model: 'ui16', inputs: 12, aux: 6 };

describe('estrutura de cenas (formato v2)', () => {
  it('cena gerada a partir do laboratório é válida e preserva -∞ e EQ', () => {
    const values = new Map<ParamKey, ParamValue>([
      [paramKey.level(1, MASTER), -8],
      [paramKey.level(2, MASTER), -Infinity],
      [paramKey.eqBand(4, 2, 'gain'), -3],
      [paramKey.hpf(1, 'freq'), 120],
    ]);
    const scene = buildScene({ id: 'ensaio-1', name: 'Ensaio', device: UI16, values, registry: reg, now: new Date(0) });
    expect(scene).toMatchObject({ schemaVersion: 2, kind: 'mixai-scene', validationStatus: 'UNVERIFIED' });
    expect(scene.params['ch.2.main.level']).toEqual({ value: '-inf', status: 'unknown' });
    expect(scene.params['ch.4.eq.b2.gain']).toEqual({ value: -3, status: 'incompatible' }); // EQ: só laboratório
    const v = validateScene(JSON.parse(JSON.stringify(scene)), reg, UI16);
    expect(v.ok).toBe(true);
    expect(v.values.get(paramKey.level(2, MASTER))).toBe(-Infinity);
  });

  it('validação recusa tipo, faixa e perfil errados, e lista chaves desconhecidas', () => {
    const base = buildScene({ id: 'cena-x1', name: 'X', device: UI16, values: new Map(), registry: reg });
    const bad = { ...base, params: { 'ch.1.eq.b1.gain': { value: 50 }, 'ch.1.main.mute': { value: 1 }, 'ch.40.main.level': { value: 0 } } };
    const v = validateScene(bad, reg, UI16);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/máximo/);
    expect(v.unknownKeys).toEqual(['ch.40.main.level']);
    const typed = validateScene({ ...base, params: { 'ch.1.main.mute': { value: 1 } } }, reg, UI16);
    expect(typed.errors.join(' ')).toMatch(/verdadeiro\/falso/);
    const other = validateScene({ ...base, deviceProfile: { model: 'ui24', inputs: 24, aux: 10 } }, reg, UI16);
    expect(other).toMatchObject({ ok: false, code: 'DEVICE_MISMATCH' });
    expect(validateScene({ kind: 'outra-coisa' }, reg, UI16).ok).toBe(false);
  });

  it('diff genérico: igual, diferente, desconhecido no estado atual e se é aplicável na mesa', () => {
    const current = new Map<ParamKey, ParamValue>([
      [paramKey.level(1, MASTER), -10],
      [paramKey.level(2, MASTER), -8.02],
    ]);
    const target = new Map<ParamKey, ParamValue>([
      [paramKey.level(1, MASTER), -6],
      [paramKey.level(2, MASTER), -8],
      [paramKey.level(3, MASTER), -5],
      [paramKey.eqBand(1, 1, 'gain'), 2],
    ]);
    const diff = diffValues((k) => current.get(k), target, reg);
    const byKey = Object.fromEntries(diff.map((d) => [d.key, [d.kind, d.applicableToMixer]]));
    expect(byKey).toEqual({
      'ch.1.main.level': ['different', true],
      'ch.2.main.level': ['equal', true],
      'ch.3.main.level': ['unknown_in_current', true],
      'ch.1.eq.b1.gain': ['unknown_in_current', false],
    });
  });
});

describe('compatibilidade MCP e console no modo laboratório', () => {
  it('as 11 tools continuam iguais e alteram o estado persistido', async () => {
    const labFile = join(mkdtempSync(join(tmpdir(), 'mixai-mcp-lab-')), 'lab.json');
    const app = await createApp({
      config: parseConfig({ mixer: { mode: 'lab' }, lab: { saveDebounceMs: 0 }, logs: { dir: null } }),
      channels: parseChannels({ channels: [{ number: 3, name: 'Voz Fred', aliases: ['fred'] }], aux: [{ number: 1, name: 'Fones', aliases: ['fone'] }] }),
      configDir: '.',
      logDir: null,
      labFile,
    });
    await app.mixer.connect();
    const server = createMcpServer(app.controller);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'teste', version: '1' });
    await Promise.all([server.connect(b), client.connect(a)]);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    const res = (await client.callTool({ name: 'set_aux_send', arguments: { channel: 'fred', aux: 'fone', delta_db: 2 } })) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]!.text).toContain('[OK] Voz Fred no Fones: -20 dB → -18 dB');
    await app.mixer.disconnect();

    const reopened = new LabMixer({ file: labFile });
    await reopened.connect();
    expect(reopened.read(paramKey.level(3, { kind: 'aux', aux: 1 }))).toEqual({ known: true, value: -18 });
  });
});
