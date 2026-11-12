#!/usr/bin/env node
/**
 * Inicialização SUPERVISIONADA do primeiro envio AUX REAL (PR #101). Fail-closed.
 *
 * Esta CLI é o único caminho que fornece o `FirstRealAuxGate` (validation:'supervised_protocol') ao `startServer`.
 * NÃO existe flag, variável de ambiente ou YAML que habilite a escrita sozinho: é preciso um REGISTRO DE VALIDAÇÃO FÍSICA
 * (arquivo JSON preenchido pelo responsável depois do roteiro de docs/ui16/FIRST-REAL-AUX.md) e uma rota Windows verificada
 * agora E a cada autorização/envio. Sem registro válido, o servidor NÃO sobe com a capacidade de escrita.
 * O registro é uma atestação administrativa: não é verificação automática de firmware nem de protocolo.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { FirstRealAuxGate } from './mixer/ui16-aux-write.js';
import { isObserverPrivateIP, queryWindowsObserverRoute, type ObserverTransport } from './mixer/observer-network.js';
import type { RouteDecision } from './mixer/observer-route.js';

export const SUPERVISED_HELP = `Primeiro envio AUX REAL — inicialização supervisionada (fail-closed).
npm run serve:supervised-aux -- --validation-record CAMINHO.json
O registro (JSON) é preenchido pelo responsável após o roteiro físico (docs/ui16/FIRST-REAL-AUX.md). Sem registro válido e rota
verificada, nada é habilitado e o servidor não sobe. Use "npm run serve:real" para o modo somente leitura.`;

const MAX_AGE_MS = 24 * 3_600_000; // o registro vale por uma sessão supervisionada: 24 h
export const ValidationRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reference: z.string().regex(/^[A-Za-z0-9._/-]{8,120}$/),
  validatedBy: z.string().regex(/^[\p{L}0-9 ._-]{2,60}$/u),
  validatedAt: z.string().datetime(),
  device: z.strictObject({ model: z.literal('ui16'), ip: z.string(), firmware: z.string().regex(/^[A-Za-z0-9._ -]{1,40}$/) }),
  route: z.strictObject({ transport: z.enum(['ethernet', 'wifi']), interfaceIndex: z.number().int().min(1).max(0xffffffff) }),
  checklist: z.strictObject({
    f0ChecklistCompleted: z.literal(true),
    supervisorPresent: z.literal(true),
    audioOutputsDisconnected: z.literal(true),
    manualBackupDone: z.literal(true),
    stereoLinkAbsentOnChannelAndAux: z.literal(true),
    setdPublishesNewSampleConfirmed: z.literal(true),
  }),
});
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

export interface SupervisedDeps {
  readFile(path: string): string;
  fileSize(path: string): number;
  now(): number;
  query(ip: string, transport: ObserverTransport, index: number): RouteDecision;
  audit(line: string): void;
}
export class SupervisedRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Rota consultada agora e revalidada a cada uso (cache de 1 s só para não disparar a consulta nativa em cada leitura). */
export function createRouteGuard(record: ValidationRecord, deps: Pick<SupervisedDeps, 'query' | 'now'>) {
  let at = -Infinity, ok = false;
  return () => {
    const t = deps.now();
    if (t - at >= 0 && t - at < 1000) return ok;
    try { ok = deps.query(record.device.ip, record.route.transport, record.route.interfaceIndex).passed === true; } catch { ok = false; }
    at = t; return ok;
  };
}

/** Valida tudo ANTES de qualquer conexão. Lança SupervisedRefusal; nunca devolve um gate parcial. */
export function prepareSupervisedGate(argv: string[], configuredIp: string, deps: SupervisedDeps): { gate: FirstRealAuxGate; record: ValidationRecord } {
  if (argv.length !== 2 || argv[0] !== '--validation-record' || !argv[1]) throw new SupervisedRefusal('USAGE', 'Informe somente --validation-record CAMINHO.json.');
  const path = resolve(argv[1]);
  let raw: unknown;
  try {
    if (deps.fileSize(path) > 8192) throw new Error();
    raw = JSON.parse(deps.readFile(path));
  } catch { throw new SupervisedRefusal('RECORD_UNREADABLE', 'Registro de validação física ausente, ilegível ou grande demais. Escrita REAL permanece desabilitada.'); }
  const parsed = ValidationRecordSchema.safeParse(raw);
  if (!parsed.success) throw new SupervisedRefusal('RECORD_INVALID', 'Registro de validação incompleto ou com campos não permitidos. Todos os itens do roteiro devem estar confirmados.');
  const record = parsed.data;
  const age = deps.now() - Date.parse(record.validatedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > MAX_AGE_MS) throw new SupervisedRefusal('RECORD_STALE', 'Registro de validação fora da janela de 24 h (ou com data futura). Refaça a validação supervisionada.');
  if (!isObserverPrivateIP(record.device.ip) || record.device.ip !== configuredIp) throw new SupervisedRefusal('DEVICE_MISMATCH', 'O IP do registro não é uma rede privada ou difere do IP configurado para a mesa.');
  const route = createRouteGuard(record, deps);
  if (!route()) throw new SupervisedRefusal('ROUTE_FAILED', 'A rota até a mesa não passou na verificação agora. Nada foi habilitado.');
  deps.audit(JSON.stringify({ event: 'supervised_first_write_gate_prepared', at: new Date(deps.now()).toISOString(), reference: record.reference,
    validatedBy: record.validatedBy, validatedAt: record.validatedAt, firmware: record.device.firmware, ip: record.device.ip,
    transport: record.route.transport, interfaceIndex: record.route.interfaceIndex }));
  return { record, gate: { validation: 'supervised_protocol', validationReference: record.reference, routeGuard: route, freshnessMs: 3000, confirmationTimeoutMs: 1500 } };
}

export const realDeps = (dataDir: string): SupervisedDeps => ({
  readFile: (p) => readFileSync(p, 'utf8'), fileSize: (p) => statSync(p).size, now: () => Date.now(), query: queryWindowsObserverRoute,
  audit: (line) => { const f = join(dataDir, 'ui16-supervised-validation.log'); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, line + '\n', 'utf8'); },
});

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(SUPERVISED_HELP); return 0; }
  const info = (m: string) => process.stderr.write(`[mixai-supervised] ${m}\n`);
  try {
    const { loadConfig } = await import('./core/config.js');
    const loaded = loadConfig();
    if (loaded.config.mixer.mode !== 'real' || loaded.config.mixer.model !== 'ui16') throw new SupervisedRefusal('MODE', 'Requer mixer.mode: real e model: ui16 na configuração.');
    const { gate, record } = prepareSupervisedGate(argv, loaded.config.mixer.ip, realDeps(loaded.dataDir ?? join(process.cwd(), 'data')));
    info(`validação ${record.reference} (${record.validatedBy}) aceita; rota verificada. Escrita limitada a UM fader de envio AUX por vez, com confirmação humana.`);
    const { startServer } = await import('./server/start.js');
    const server = await startServer(loaded, { firstRealAux: gate, log: info });
    for (const url of server.urls) info(`escutando em ${url}`);
    const stop = async () => { info('desligando e desabilitando o gate...'); await server.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return undefined;
  } catch (e) {
    if (e instanceof SupervisedRefusal) { info(`RECUSADO (${e.code}): ${e.message}`); return 1; }
    info('RECUSADO: falha ao iniciar; o gate não foi habilitado.'); return 1;
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) void main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code; });
