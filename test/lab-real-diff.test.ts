import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareLabReal, exportLabRealComparison, portraitFromScene, portraitFromSnapshot } from '../src/core/lab-real-diff.js';
import { ParamRegistry } from '../src/core/params.js';
import { paramKey, type ParamKey, type ParamValue, RevisionTracker } from '../src/core/revisions.js';
import { buildScene } from '../src/core/scene.js';
import { StateHub, type MixerStateSnapshot } from '../src/core/state.js';
import { RealMixer } from '../src/mixer/real.js';
import { MASTER } from '../src/mixer/types.js';
import { createFakeUi, stateMessages } from './support/fake-ui-socket.js';
import { FIXTURE_TIME, known, labRealFixture } from './support/lab-real-fixtures.js';

const key = 'ch.1.main.level';
const row = (input = labRealFixture(), k = key) => compareLabReal(input).rows.find((r) => r.key === k)!;

describe('E8A: comparação pura de retratos fictícios', () => {
  it('classifica a união de chaves sem confundir ausência, desconhecido, mute e níveis', () => {
    const report = compareLabReal(labRealFixture());
    const statuses = Object.fromEntries(report.rows.map((r) => [r.key, r.kind]));
    expect(statuses).toEqual({
      'ch.1.main.level': 'equal', 'ch.1.main.mute': 'different', 'ch.2.main.level': 'equal', 'ch.2.main.mute': 'equal',
      'ch.1.aux.1.level': 'different', 'ch.1.aux.1.mute': 'different', 'master.level': 'equal',
      'ch.3.main.level': 'unknown', 'ch.4.main.level': 'missing_in_real', 'ch.5.main.level': 'missing_in_lab',
      'ch.1.eq.b1.gain': 'unsupported', 'ch.1.eq.hpf.freq': 'unsupported', 'ch.1.eq.hpf.slope': 'unsupported',
      'ch.1.eq.bypass': 'unsupported', 'ch.99.main.level': 'unsupported',
    });
    expect(report.totals).toEqual({ equal: 4, different: 3, unknown: 1, unsupported: 5,
      missing_in_lab: 1, missing_in_real: 1, device_mismatch: 0 });
    expect(report.applicable).toBe(false);
    expect(report.hardwareVerified).toBe(false);
    expect(report.rows.every((r) => r.applicable === false)).toBe(true);
  });

  it.each([
    [-10, -10.049, 'equal'], [-10, -10.051, 'different'],
    ['-inf', '-inf', 'equal'], ['-inf', -90, 'different'], [-90, '-inf', 'different'],
  ] as const)('LAB %s × REAL %s → %s, sem substituir −∞ por zero', (lab, real, kind) => {
    const f = labRealFixture(); f.lab.params[key] = known(lab); f.real.params[key] = known(real);
    const r = row(f);
    expect(r.kind).toBe(kind);
    expect(r.deltaDB).toBe(lab === '-inf' || real === '-inf' ? null : Number((lab - real).toFixed(6)));
    const json = JSON.parse(exportLabRealComparison(f));
    expect(json.rows.find((x: {key: string}) => x.key === key).lab.value).toBe(lab);
  });

  it('informa teto excedido sem limitar o LAB nem esconder a diferença', () => {
    const f = labRealFixture(); f.lab.params[key] = known(3); f.real.params[key] = known(-2);
    f.ceilings = { channel: -1, aux: -15, master: -3 };
    expect(row(f)).toMatchObject({ kind: 'different', lab: { value: 3 }, real: { value: -2 },
      deltaDB: 5, ceiling: -1, aboveCeiling: { lab: true, real: false }, applicable: false });
    expect(row(f, 'ch.1.aux.1.level')).toMatchObject({ ceiling: -15, aboveCeiling: { lab: false, real: true } });
    expect(row(f, 'master.level').ceiling).toBe(-3);
    expect(row(f, 'ch.1.main.mute').ceiling).toBeNull();
  });

  it.each(['model', 'inputs', 'aux'] as const)('bloqueia comparação por perfil incompatível: %s', (field) => {
    const f = labRealFixture();
    if (field === 'model') f.real.device.model = 'ui24'; else f.real.device[field]++;
    const report = compareLabReal(f);
    expect(report.deviceCompatible).toBe(false);
    expect(report.rows.every((r) => r.kind === 'device_mismatch' && !r.applicable && r.deltaDB === null)).toBe(true);
  });

  it('modelos desconhecidos iguais não tornam um perfil suportado', () => {
    const f = labRealFixture(); f.lab.device.model = f.real.device.model = 'unknown-model';
    expect(compareLabReal(f).deviceCompatible).toBe(false);
    expect(row(f).kind).toBe('device_mismatch');
  });

  it('iguais acima do teto continuam sinalizados, sem clamp ou autorização', () => {
    const f = labRealFixture(); f.lab.params[key] = known(3); f.real.params[key] = known(3);
    expect(row(f)).toMatchObject({ kind: 'equal', aboveCeiling: { lab: true, real: true }, applicable: false });
  });

  it('capturas no limite da idade são legíveis; LAB stale e dois desconhecidos não são iguais', () => {
    const f = labRealFixture(); f.comparedAt = '2026-11-06T10:00:30.000Z';
    expect(row(f).kind).toBe('equal');
    f.lab.freshness = 'stale'; expect(row(f).reason).toBe('stale');
    f.lab.freshness = 'fresh';
    f.lab.params[key]!.value = f.real.params[key]!.value = { status: 'unknown' };
    expect(row(f)).toMatchObject({ kind: 'unknown', lab: { value: null }, real: { value: null } });
  });

  it.each(['ch.0.main.level', 'ch.13.main.level', 'ch.1.aux.0.level', 'ch.1.aux.7.level'])('rejeita suporte fora dos números do perfil: %s', (k) => {
    const f = labRealFixture(); f.lab.params[k] = known(-6); f.real.params[k] = known(-6);
    expect(row(f, k).kind).toBe('unsupported');
  });

  it('AUX de perfil não prova bus/saída física: suporte explícito desconhecido ou recusado prevalece', () => {
    const f = labRealFixture(); const k = 'ch.1.aux.6.level';
    f.lab.params[k] = known(-6); f.real.params[k] = { ...known(-6), support: 'unknown' };
    expect(row(f, k)).toMatchObject({ kind: 'unknown', reason: 'support_unknown' });
    f.real.params[k]!.support = 'unsupported';
    expect(row(f, k).kind).toBe('unsupported');
  });

  it.each(['stale', 'expired', 'future', 'lost', 'stopped', 'syncing', 'unavailable'] as const)('não compara leitura antiga/inacessível: %s', (caseName) => {
    const f = labRealFixture();
    if (caseName === 'stale') f.real.freshness = 'stale';
    else if (caseName === 'expired') f.comparedAt = '2026-11-06T10:00:30.001Z';
    else if (caseName === 'future') f.real.capturedAt = '2026-11-06T10:01:00.000Z';
    else if (caseName === 'unavailable') f.real.available = false;
    else f.real.link = caseName === 'lost' ? 'LOST' : caseName === 'stopped' ? 'STOPPED' : 'SYNCING';
    expect(row(f).kind).toBe('unknown');
    expect(row(f).deltaDB).toBeNull();
    expect(row(f).lab.value).toBe(-10); // valor retido com motivo, nunca apresentado como igualdade atual
  });

  it('DEGRADED permite só os valores conhecidos; unknown/unavailable não equivalem a zero/false', () => {
    const f = labRealFixture(); f.real.link = 'DEGRADED_READ_ONLY';
    expect(row(f).kind).toBe('equal');
    f.real.params[key] = { ...known(0), value: { status: 'unknown' } };
    f.lab.params[key] = known(0);
    expect(row(f)).toMatchObject({ kind: 'unknown', real: { status: 'unknown', value: null } });
    f.real.params[key]!.value = { status: 'unavailable' };
    expect(row(f)).toMatchObject({ kind: 'unknown', reason: 'unavailable' });
  });

  it.each([known(true), known(11), known('-inf')])('valida tipo/faixa por parâmetro sem coerção: %j', (bad) => {
    const f = labRealFixture(); const k = bad.value.status === 'known' && bad.value.value === '-inf' ? 'ch.1.main.mute' : key;
    f.real.params[k] = bad;
    expect(row(f, k)).toMatchObject({ kind: 'unknown', reason: 'invalid_value', real: { value: null, status: 'invalid' } });
  });

  it('não compara revisões entre processos; rejeita revisão do parâmetro maior que a global', () => {
    const f = labRealFixture(); f.real.revision = 100; f.real.params[key]!.revision = 99;
    expect(row(f)).toMatchObject({ kind: 'equal', lab: { revision: 2 }, real: { revision: 99 } });
    f.real.params[key]!.revision = 101;
    expect(row(f).reason).toBe('invalid_value');
  });

  it('é determinístico, não modifica entradas e mantém todos os estados no relatório sanitizado', () => {
    const f = labRealFixture(); const before = structuredClone(f);
    const extra = f.real as typeof f.real & { token: string; ip: string };
    extra.token = 'SENSITIVE_SENTINEL'; extra.ip = 'SENSITIVE_IP';
    Object.assign(f.real.params[key]!, { actor: 'SENSITIVE_ACTOR' });
    const copy = structuredClone(f);
    const a = exportLabRealComparison(f), b = exportLabRealComparison(f);
    expect(a).toBe(b); expect(f).toEqual(copy);
    expect(a).not.toMatch(/SENSITIVE|token|actor/);
    const report = JSON.parse(a);
    expect(report.real.capturedAt).toBe(FIXTURE_TIME);
    expect(report.rows.length).toBe(Object.keys({ ...before.lab.params, ...before.real.params }).length);
    const markdown = exportLabRealComparison(f, 'markdown');
    expect(markdown).toContain('−∞'); expect(markdown).toContain('missing_in_real');
    expect(markdown).toContain('Nenhum item é aplicável'); expect(markdown).not.toMatch(/SENSITIVE/);
  });

  it.each([NaN, Infinity, -Infinity, null, 'senha-secreta'])('recusa valores wire inválidos sem ecoar conteúdo: %s', (bad) => {
    const f = labRealFixture(); (f.real.params[key]!.value as {value: unknown}).value = bad;
    expect(() => exportLabRealComparison(f)).toThrow(/^E8A_INVALID_PORTRAIT: retrato inválido$/);
  });

  it('valida origem, timestamps, chaves e opções sem carregar rede nem dados livres no relatório', () => {
    const f = labRealFixture(); f.real.mode = 'lab'; expect(() => compareLabReal(f)).toThrow('E8A_INVALID_ORIGIN');
    f.real.mode = 'real'; f.real.capturedAt = 'ontem'; expect(() => compareLabReal(f)).toThrow('E8A_INVALID_PORTRAIT');
    f.real.capturedAt = FIXTURE_TIME; f.real.params['token-secret'] = known(0); expect(() => compareLabReal(f)).toThrow('E8A_INVALID_PORTRAIT');
    delete f.real.params['token-secret']; f.maxAgeMs = -1; expect(() => compareLabReal(f)).toThrow('E8A_INVALID_OPTIONS');
  });
});

describe('adaptação dos formatos existentes sem mudar E5/E7A', () => {
  it('cena E5 preserva −∞, EQ fica unsupported mesmo que a cena declare compatible', () => {
    const f = labRealFixture(); const registry = new ParamRegistry(f.lab.device);
    const values = new Map<ParamKey, ParamValue>([[key, -Infinity], [paramKey.eqBand(1, 1, 'gain'), 3]]);
    const scene = buildScene({ id: 'e8a-scene', name: 'NOME-SECRETO', description: 'TOKEN-SECRETO',
      device: f.lab.device, values, registry, now: new Date('2020-01-01T00:00:00.000Z') });
    scene.params['ch.1.eq.b1.gain']!.status = 'compatible';
    f.lab = portraitFromScene(scene); f.real.params[key] = known('-inf');
    expect(row(f).kind).toBe('equal'); // cena antiga é alvo arquivado, não captura vencida
    expect(row(f, 'ch.1.eq.b1.gain').kind).toBe('unsupported');
    expect(exportLabRealComparison(f)).not.toMatch(/SECRETO|NOME/);
    expect(f.lab.revision).toBeNull();
  });

  it('snapshot existente codifica −Infinity, mantém unavailable e elimina actor', () => {
    const f = labRealFixture(); const snap: MixerStateSnapshot = { schemaVersion: 1, mode: 'real', link: 'READY',
      available: true, revision: 10, params: { [key]: { value: { status: 'known', value: -Infinity }, revision: 2, actor: 'external' } } };
    const p = portraitFromSnapshot(snap, { device: f.real.device, origin: 'fixture', capturedAt: FIXTURE_TIME, freshness: 'fresh' });
    expect(p.params[key]).toEqual({ value: { status: 'known', value: '-inf' }, revision: 2, support: 'unknown' });
    expect(JSON.stringify(p)).not.toContain('actor');
    snap.params[key]!.value = { status: 'unavailable' };
    expect(portraitFromSnapshot(snap, { device: f.real.device, origin: 'fixture', capturedAt: FIXTURE_TIME, freshness: 'fresh' }).params[key]!.value.status).toBe('unavailable');
  });
});

describe('biblioteca real com WebSocket falso: comparação não conecta nem escreve', () => {
  afterEach(() => vi.restoreAllMocks());
  it('lê um snapshot fornecido, exporta relatório, zero SETD/SETS/LOAD/SAVE e zero chamadas de escrita', async () => {
    const key1 = paramKey.level(1, MASTER);
    const fake = createFakeUi({ initialState: () => stateMessages({ channels: [1], aux: [] }) });
    const mixer = new RealMixer({ ip: 'e8a.invalid', webSocketCtor: fake.Ctor, readOnly: true,
      requiredKeys: [key1], watchedKeys: [key1], connectTimeoutMs: 1000 });
    try {
      await mixer.connect(); // somente o teste coleta no socket falso; comparador recebe só dados
      const write = vi.spyOn(mixer, 'write'), load = vi.spyOn(mixer, 'loadSnapshot'), connect = vi.spyOn(mixer, 'connect');
      const registry = new ParamRegistry(mixer.capabilities());
      const hub = new StateHub(mixer, new RevisionTracker(), registry);
      const snapshot = hub.snapshot([key1]);
      const f = labRealFixture(); f.real = portraitFromSnapshot(snapshot, { device: f.real.device,
        origin: 'fake_socket', capturedAt: FIXTURE_TIME, freshness: 'fresh', support: { [key1]: 'supported' as const } });
      const before = structuredClone(snapshot);
      expect(row(f).kind).toBe('equal');
      expect(JSON.parse(exportLabRealComparison(f)).applicable).toBe(false);
      exportLabRealComparison(f, 'markdown');
      expect(snapshot).toEqual(before);
      expect(write).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
      expect(fake.sockets).toHaveLength(1);
      expect(fake.sockets.flatMap((s) => s.commands())).toEqual([]);
    } finally { await mixer.disconnect(); }
    expect(fake.alive()).toHaveLength(0);
  });
});
