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
