import { describe, expect, it, vi } from 'vitest';
import { Ui16AuxHandshake } from '../src/mixer/ui16-aux-write.js';
import { createRouteGuard, prepareSupervisedGate, SupervisedRefusal, type SupervisedDeps, type ValidationRecord } from '../src/supervised-first-write-cli.js';
import type { RouteDecision } from '../src/mixer/observer-route.js';

/** Nenhuma consulta real, arquivo real, servidor ou transporte: tudo injetado. */
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1, reference: 'ui16-aux-2026-11-12-r1', validatedBy: 'Responsavel Teste', validatedAt: '2026-11-12T11:00:00.000Z',
  device: { model: 'ui16', ip: '192.168.1.50', firmware: 'fw-1.2.3' }, route: { transport: 'ethernet', interfaceIndex: 7 },
  checklist: { f0ChecklistCompleted: true, supervisorPresent: true, audioOutputsDisconnected: true, manualBackupDone: true, stereoLinkAbsentOnChannelAndAux: true, setdPublishesNewSampleConfirmed: true },
  ...over,
});
const decision = (passed: boolean): RouteDecision => ({ schemaVersion: 1, transport: 'ethernet', expectedInterfaceIndex: 7, selectedInterfaceIndex: passed ? 7 : 9, passed, reason: passed ? 'ok' : 'unexpected_interface' });
function deps(file: unknown, over: Partial<SupervisedDeps> = {}) {
  const audit: string[] = []; let now = NOW;
  const d: SupervisedDeps = {
    readFile: () => { if (file === undefined) throw new Error('ENOENT'); return typeof file === 'string' ? file : JSON.stringify(file); },
    fileSize: () => (file === undefined ? (() => { throw new Error('ENOENT'); })() : 1000), now: () => now,
    query: vi.fn(() => decision(true)), audit: (l) => audit.push(l), ...over,
  };
  return { d, audit, advance: (ms: number) => (now += ms) };
}
const run = (file: unknown, over: Partial<SupervisedDeps> = {}, argv = ['--validation-record', 'registro.json'], ip = '192.168.1.50') => {
  const x = deps(file, over); return { ...x, go: () => prepareSupervisedGate(argv, ip, x.d) };
};
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(SupervisedRefusal); return (e as SupervisedRefusal).code; } throw new Error('deveria recusar'); };

describe('inicialização supervisionada (fail-closed, sem servidor e sem rede)', () => {
  it('registro válido + rota ok: gate supervised_protocol aceito pelo handshake do #100 e auditado sem segredos', () => {
    const r = run(record()); const { gate, record: parsed } = r.go();
    expect(gate).toMatchObject({ validation: 'supervised_protocol', validationReference: 'ui16-aux-2026-11-12-r1', freshnessMs: 3000, confirmationTimeoutMs: 1500 });
    expect(gate.routeGuard()).toBe(true); expect(parsed.device.ip).toBe('192.168.1.50');
    expect(() => new Ui16AuxHandshake(gate, { now: () => 0, connected: () => true, link: () => 'READY', identified: () => true, monophonic: () => true, observation: () => undefined, send: () => undefined })).not.toThrow();
    expect(r.audit).toHaveLength(1);
    expect(JSON.parse(r.audit[0]!)).toMatchObject({ event: 'supervised_first_write_gate_prepared', reference: 'ui16-aux-2026-11-12-r1', firmware: 'fw-1.2.3' });
    expect(r.audit[0]).not.toMatch(/pin|token|secret|senha|password/i);
  });
  it.each([
    ['registro ausente', undefined, 'RECORD_UNREADABLE'],
    ['JSON inválido', '{ nao e json', 'RECORD_UNREADABLE'],
    ['campo extra (tentativa de autodeclarar)', record({ forceEnable: true }), 'RECORD_INVALID'],
    ['item do roteiro falso', record({ checklist: { ...(record().checklist as object), supervisorPresent: false } }), 'RECORD_INVALID'],
    ['item do roteiro ausente', record({ checklist: { f0ChecklistCompleted: true } }), 'RECORD_INVALID'],
    ['modelo diferente de ui16', record({ device: { model: 'ui24', ip: '192.168.1.50', firmware: 'x' } }), 'RECORD_INVALID'],
    ['referência curta', record({ reference: 'abc' }), 'RECORD_INVALID'],
    ['registro antigo (>24 h)', record({ validatedAt: '2026-11-10T11:00:00.000Z' }), 'RECORD_STALE'],
    ['data futura', record({ validatedAt: '2026-11-13T12:00:00.000Z' }), 'RECORD_STALE'],
    ['IP diferente do configurado', record({ device: { model: 'ui16', ip: '192.168.1.51', firmware: 'x' } }), 'DEVICE_MISMATCH'],
    ['IP público', record({ device: { model: 'ui16', ip: '8.8.8.8', firmware: 'x' } }), 'DEVICE_MISMATCH'],
  ])('recusa: %s', (_n, file, code) => {
    const r = run(file as unknown, {}, undefined, (file as { device?: { ip?: string } } | undefined)?.device?.ip === '8.8.8.8' ? '8.8.8.8' : '192.168.1.50');
    expect(refusal(r.go)).toBe(code); expect(r.audit).toEqual([]);
  });
  it('recusa quando a rota falha agora, sem auditar nem devolver gate', () => {
    const r = run(record(), { query: () => decision(false) });
    expect(refusal(r.go)).toBe('ROUTE_FAILED'); expect(r.audit).toEqual([]);
  });
  it('recusa quando a consulta de rota lança erro', () => {
    const r = run(record(), { query: () => { throw new Error('query_unavailable'); } });
    expect(refusal(r.go)).toBe('ROUTE_FAILED');
  });
  it.each([[[]], [['--validation-record']], [['--validation-record', 'a.json', '--enable']], [['--enable-real-write']], [['--force', 'x.json']]])('uso inválido %j não habilita nada', (argv) => {
    const r = run(record(), {}, argv as string[]); expect(refusal(r.go)).toBe('USAGE'); expect(r.audit).toEqual([]);
  });
  it('arquivo grande demais é recusado sem ser lido', () => {
    const read = vi.fn(() => JSON.stringify(record()));
    const r = run(record(), { fileSize: () => 100_000, readFile: read });
    expect(refusal(r.go)).toBe('RECORD_UNREADABLE'); expect(read).not.toHaveBeenCalled();
  });
  it('o guarda de rota é revalidado (cache de 1 s) e uma rota que cai fecha a escrita', () => {
    const query = vi.fn<SupervisedDeps['query']>(() => decision(true));
    const r = run(record(), { query }); const { gate } = r.go();
    expect(query).toHaveBeenCalledTimes(1); gate.routeGuard(); gate.routeGuard(); expect(query).toHaveBeenCalledTimes(1);
    query.mockReturnValue(decision(false)); r.advance(1500);
    expect(gate.routeGuard()).toBe(false); expect(query).toHaveBeenCalledTimes(2);
    query.mockImplementation(() => { throw new Error('boom'); }); r.advance(1500);
    expect(gate.routeGuard()).toBe(false);
    query.mockReturnValue(decision(true)); r.advance(1500);
    expect(gate.routeGuard()).toBe(true);
  });
  it('createRouteGuard trata decisão sem passed===true como falha', () => {
    const rec = run(record()).go().record as ValidationRecord;
    expect(createRouteGuard(rec, { now: () => 0, query: () => ({ ...decision(true), passed: false, reason: 'interface_down' }) })()).toBe(false);
  });
});

/** Categoria pa_level (primeira escrita de PA): registro v2 com canais explícitos; `pending` só no protocolo inicial. */
const recordV2 = (over: Record<string, unknown> = {}, checklist: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 2, category: 'pa_level', channels: [3], reference: 'ui16-pa-2026-11-12-r1', validatedBy: 'Responsavel Teste', validatedAt: '2026-11-12T11:00:00.000Z',
  device: { model: 'ui16', ip: '192.168.1.50', firmware: 'fw-1.2.3' }, route: { transport: 'ethernet', interfaceIndex: 7 },
  checklist: { f0ChecklistCompleted: true, supervisorPresent: true, audioOutputsDisconnected: true, manualBackupDone: true, stereoLinkAbsentOnChannelAndAux: true, setdPublishesNewSampleConfirmed: 'pending', ...checklist },
  ...over,
});
const PA = ['--validation-record', 'registro.json', '--category', 'pa_level'];
describe('--category pa_level (fail-closed, sem servidor e sem rede)', () => {
  it('registro v2 + --category pa_level: gate escopado ao CH3, evidência live_connection, publicação pendente declarada e auditada', () => {
    const r = run(recordV2(), {}, PA); const { gate, category } = r.go();
    expect(category).toBe('pa_level');
    expect(gate).toMatchObject({ validation: 'supervised_protocol', freshnessMs: 3000, confirmationTimeoutMs: 1500, evidence: 'live_connection', maxObservationAgeMs: 300_000, channels: [3], setdPublication: 'pending' });
    expect(() => new Ui16AuxHandshake(undefined, { now: () => 0, connected: () => true, link: () => 'READY', identified: () => true, monophonic: () => true, observation: () => undefined, send: () => undefined }, { pa_level: gate })).not.toThrow();
    expect(JSON.parse(r.audit[0]!)).toMatchObject({ event: 'supervised_first_write_gate_prepared', category: 'pa_level', channels: [3], setdPublication: 'pending', evidence: 'live_connection', schemaVersion: 2 });
    expect(r.audit[0]).not.toMatch(/pin|token|secret|senha|password/i);
  });
  it('a janela de 3 s não foi afrouxada: a CLI continua entregando freshnessMs 3000 e timeout de 1,5 s', () => {
    expect(run(recordV2(), {}, PA).go().gate).toMatchObject({ freshnessMs: 3000, confirmationTimeoutMs: 1500 });
  });
  it('setdPublishesNewSampleConfirmed "confirmed" também é aceito no v2 e fica registrado como confirmed', () => {
    expect(run(recordV2({}, { setdPublishesNewSampleConfirmed: 'confirmed' }), {}, PA).go().gate.setdPublication).toBe('confirmed');
  });
  it('o padrão continua aux_level e entrega gate sem escopo de canal, com a mesma evidência', () => {
    const { gate, category } = run(record()).go();
    expect(category).toBe('aux_level'); expect(gate.channels).toBeUndefined(); expect(gate.setdPublication).toBe('confirmed');
  });
  it.each([
    ['v2 pa_level sem --category (sem herança silenciosa)', recordV2(), undefined, 'CATEGORY_MISMATCH'],
    ['v1 (AUX) com --category pa_level', record(), PA, 'CATEGORY_MISMATCH'],
    ['v2 aux_level pedido como pa_level', recordV2({ category: 'aux_level' }), PA, 'CATEGORY_MISMATCH'],
    ['v2 pa_level pedido como aux_level', recordV2(), ['--validation-record', 'registro.json', '--category', 'aux_level'], 'CATEGORY_MISMATCH'],
    ['v1 com pendente (pending só no v2)', record({ checklist: { ...(record().checklist as object), setdPublishesNewSampleConfirmed: 'pending' } }), undefined, 'RECORD_INVALID'],
    ['v2 sem canais', recordV2({ channels: [] }), PA, 'RECORD_INVALID'],
    ['v2 com canal repetido', recordV2({ channels: [3, 3] }), PA, 'RECORD_INVALID'],
    ['v2 com canal fora de 1..12', recordV2({ channels: [13] }), PA, 'RECORD_INVALID'],
    ['v2 com categoria desconhecida', recordV2({ category: 'master_level' }), PA, 'RECORD_INVALID'],
    ['v2 com item do roteiro falso', recordV2({}, { audioOutputsDisconnected: false }), PA, 'RECORD_INVALID'],
    ['v2 com valor inventado em setd...', recordV2({}, { setdPublishesNewSampleConfirmed: 'maybe' }), PA, 'RECORD_INVALID'],
    ['v2 com campo extra (tentativa de habilitar outra categoria)', recordV2({ enableAll: true }), PA, 'RECORD_INVALID'],
    ['v2 antigo (>24 h)', recordV2({ validatedAt: '2026-11-10T11:00:00.000Z' }), PA, 'RECORD_STALE'],
    ['v2 com IP diferente do configurado', recordV2({ device: { model: 'ui16', ip: '192.168.1.51', firmware: 'x' } }), PA, 'DEVICE_MISMATCH'],
  ])('recusa: %s', (_n, file, argv, code) => {
    const r = run(file as unknown, {}, argv as string[] | undefined); expect(refusal(r.go)).toBe(code); expect(r.audit).toEqual([]);
  });
  it('recusa quando a rota falha agora, sem auditar nem devolver gate', () => {
    const r = run(recordV2(), { query: () => decision(false) }, PA); expect(refusal(r.go)).toBe('ROUTE_FAILED'); expect(r.audit).toEqual([]);
  });
  it.each([[['--validation-record', 'a.json', '--category']], [['--validation-record', 'a.json', '--category', 'master_level']], [['--validation-record', 'a.json', '--category', 'pa_level', '--enable']], [['--category', 'pa_level', '--validation-record', 'a.json']], [['--validation-record', '--category', 'pa_level']]])('uso inválido %j não habilita nada', (argv) => {
    const r = run(recordV2(), {}, argv as string[]); expect(refusal(r.go)).toBe('USAGE'); expect(r.audit).toEqual([]);
  });
});

/** Guarda de rota NÃO bloqueante: a consulta síncrona do Windows (~2 s) congelava a entrada do socket dentro de autorização/envio. */
import { createBackgroundRouteGuard } from '../src/supervised-first-write-cli.js';
import { queryWindowsObserverRouteAsync } from '../src/mixer/observer-network.js';
describe('guarda de rota em segundo plano (fail-closed, sem bloquear)', () => {
  const rec = () => run(recordV2(), {}, PA).go().record;
  const mk = (over: { passed?: boolean; fail?: boolean; hang?: boolean } = {}) => {
    let now = 1_000; let calls = 0; const state = { ...over }; const pending: Array<(d: RouteDecision) => void> = [];
    const queryAsync = vi.fn(() => { calls++; if (state.hang) return new Promise<RouteDecision>((res) => pending.push(res)); return state.fail ? Promise.reject(new Error('x')) : Promise.resolve(decision(state.passed !== false)); });
    const g = createBackgroundRouteGuard(rec(), { now: () => now, queryAsync }, { ttlMs: 6000, intervalMs: 1000 });
    return { g, state, queryAsync, advance: (ms: number) => (now += ms), calls: () => calls, release: () => pending.splice(0).forEach((r) => r(decision(true))) };
  };
  it('guard() jamais consulta o Windows: só lê a última decisão', () => {
    const t = mk(); for (let i = 0; i < 50; i++) t.g.guard(); expect(t.queryAsync).not.toHaveBeenCalled(); expect(t.g.guard()).toBe(true);
  });
  it('decisão vale só o TTL: sem atualização, fecha (fail-closed)', () => {
    const t = mk(); t.advance(5900); expect(t.g.guard()).toBe(true); t.advance(200); expect(t.g.guard()).toBe(false);
  });
  it('start() atualiza em segundo plano; rota reprovada fecha na hora e recupera na verificação seguinte', async () => {
    vi.useFakeTimers();
    try {
      const t = mk(); t.g.start(); await vi.advanceTimersByTimeAsync(0); expect(t.queryAsync).toHaveBeenCalledTimes(1); expect(t.g.guard()).toBe(true);
      t.state.passed = false; t.advance(1000); await vi.advanceTimersByTimeAsync(1000); expect(t.g.guard()).toBe(false);
      t.state.passed = true; t.advance(1000); await vi.advanceTimersByTimeAsync(1000); expect(t.g.guard()).toBe(true);
      t.g.stop(); const n = t.calls(); await vi.advanceTimersByTimeAsync(5000); expect(t.calls()).toBe(n);
    } finally { vi.useRealTimers(); }
  });
  it('falha da consulta (erro) fecha imediatamente; nunca mantém "ok" antigo', async () => {
    vi.useFakeTimers();
    try { const t = mk({ fail: true }); t.g.start(); await vi.advanceTimersByTimeAsync(0); expect(t.g.guard()).toBe(false); t.g.stop(); } finally { vi.useRealTimers(); }
  });
  it('consultas não se sobrepõem (uma em voo por vez) e uma consulta travada deixa a decisão expirar', async () => {
    vi.useFakeTimers();
    try {
      const t = mk({ hang: true }); t.g.start(); await vi.advanceTimersByTimeAsync(3500); expect(t.calls()).toBe(1);
      t.advance(7000); expect(t.g.guard()).toBe(false); t.g.stop();
    } finally { vi.useRealTimers(); }
  });
  it('prepareSupervisedGate com queryAsync entrega a guarda não bloqueante e mantém a verificação síncrona inicial', () => {
    const queryAsync = vi.fn(async () => decision(true)); const query = vi.fn(() => decision(true));
    const r = run(recordV2(), { query, queryAsync }, PA).go();
    expect(r.routeGuard).toBeDefined(); expect(query).toHaveBeenCalledTimes(1); // inicialização síncrona
    for (let i = 0; i < 20; i++) r.gate.routeGuard();
    expect(query).toHaveBeenCalledTimes(1); expect(queryAsync).not.toHaveBeenCalled();
  });
  it('rota reprovada na inicialização continua recusando, mesmo com queryAsync', () => {
    const r = run(recordV2(), { query: () => decision(false), queryAsync: async () => decision(true) }, PA); expect(refusal(r.go)).toBe('ROUTE_FAILED');
  });
  it('a consulta assíncrona valida os argumentos sem executar nada (IP público, índice, transporte)', async () => {
    await expect(queryWindowsObserverRouteAsync('8.8.8.8', 'wifi', 19)).rejects.toThrow('F0D_WINDOWS_ROUTE_CHECK_REQUIRED');
    await expect(queryWindowsObserverRouteAsync('10.10.1.1', 'wifi', 0)).rejects.toThrow('F0D_WINDOWS_ROUTE_CHECK_REQUIRED');
    await expect(queryWindowsObserverRouteAsync('10.10.1.1', 'bluetooth' as never, 19)).rejects.toThrow('F0D_WINDOWS_ROUTE_CHECK_REQUIRED');
  });
});
