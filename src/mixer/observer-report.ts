import { z } from 'zod';
import { asParamKey, parseKey, type ParamKey } from '../core/revisions.js';
import { ParamRegistry } from '../core/params.js';

const registry = new ParamRegistry({ model: 'ui16', inputs: 12, aux: 6 });
export const MAX_OBSERVER_BYTES = 256 * 1024;
export const ObserverKeySchema = z.string().max(40).refine((text) => {
  const k = asParamKey(text);
  return text === text.trim() && !!k && registry.get(k)?.capability === 'library_verified';
});
export const ScopeSchema = z.object({
  channels: z.array(z.number().int().min(1).max(12)).min(1).max(12),
  aux: z.array(z.number().int().min(1).max(6)).max(6).default([]),
  master: z.boolean().default(false),
}).strict().refine((s) => new Set(s.channels).size === s.channels.length && new Set(s.aux).size === s.aux.length);
export type ObserverScope = z.infer<typeof ScopeSchema>;
const Link = z.enum(['DISCONNECTED', 'CONNECTING', 'SYNCING', 'DEGRADED_READ_ONLY', 'READY', 'LOST', 'STOPPED']);
export const StopReasonSchema = z.enum(['operator', 'duration', 'connect_failed', 'recovery_timeout', 'event_limit', 'outbound_blocked', 'invalid_sample', 'supervisor_stopped', 'output_error', 'route_mismatch']);
export type ObserverStopReason = z.infer<typeof StopReasonSchema>;
const Reading = z.discriminatedUnion('state', [
  z.object({ state: z.literal('observed'), value: z.union([z.number().finite(), z.boolean(), z.literal('-inf')]) }).strict(),
  z.object({ state: z.literal('unknown'), reason: z.enum(['not_received', 'invalid_value']) }).strict(),
  z.object({ state: z.literal('unavailable') }).strict(),
]);
export type ObserverReading = z.infer<typeof Reading>;
const Sample = z.object({ key: ObserverKeySchema, reading: Reading }).strict().superRefine((s, ctx) => {
  if (s.reading.state !== 'observed') return;
  const k = asParamKey(s.key)!;
  const value = s.reading.value === '-inf' ? -Infinity : s.reading.value;
  if (registry.validate(k, value)) ctx.addIssue({ code: 'custom', message: 'invalid reading' });
});
const base = { index: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(), generation: z.number().int().nonnegative() };
export const ObserverEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('link'), link: Link }).strict(),
  z.object({ ...base, type: z.literal('parameter'), origin: z.enum(['external', 'resync']), sample: Sample }).strict(),
  z.object({ ...base, type: z.literal('snapshot'), link: Link, complete: z.boolean(), samples: z.array(Sample).max(181) }).strict(),
  z.object({ ...base, type: z.literal('safety'), reason: z.enum(['outbound_blocked', 'invalid_sample', 'route_mismatch']) }).strict(),
  z.object({ ...base, type: z.literal('end'), reason: StopReasonSchema, link: z.literal('DISCONNECTED') }).strict(),
]);
export type ObserverEvent = z.infer<typeof ObserverEventSchema>;
const Counters = z.object({
  link: z.number().int().nonnegative(), parameter: z.number().int().nonnegative(), snapshot: z.number().int().nonnegative(),
  safety: z.number().int().nonnegative(), end: z.number().int().nonnegative(), duplicatesSuppressed: z.number().int().nonnegative(),
}).strict();
const ObserverReportBase = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), kind: z.literal('mixai-f0c-readonly-evidence'),
  appVersion: z.string().max(32).regex(/^\d+\.\d+\.\d+$/), libraryVersion: z.literal('7.1.0'),
  source: z.enum(['fake_websocket', 'manual_device_stream']),
  readOnly: z.literal(true), hardwareValidation: z.literal('pending'), configuredModel: z.literal('ui16'),
  auxPhysicalSupport: z.literal('not_verified'), scope: ScopeSchema,
  excludedCapabilities: z.tuple([z.literal('eq_hpf_simulated_only'), z.literal('preamp_phantom_not_monitored'), z.literal('physical_aux_routing_unverified')]),
  ended: z.boolean(), elapsedMs: z.number().int().nonnegative(),
  maxEvents: z.number().int().min(8).max(2000), stopReason: StopReasonSchema.nullable(),
  counters: Counters, events: z.array(ObserverEventSchema).max(2000),
}).strict();
function checkEvidence(r: z.infer<typeof ObserverReportBase>, ctx: z.RefinementCtx) {
  const issue = () => ctx.addIssue({ code: 'custom', message: 'inconsistent evidence' });
  if (Buffer.byteLength(JSON.stringify(r)) > MAX_OBSERVER_BYTES) issue();
  const keys = observerKeys(r.scope);
  if (r.events.length > r.maxEvents) issue();
  for (const [i, e] of r.events.entries()) {
    if (e.index !== i || e.elapsedMs > r.elapsedMs || (i > 0 && e.elapsedMs < r.events[i - 1]!.elapsedMs)) issue();
    if (i > 0 && (e.generation < r.events[i - 1]!.generation || e.generation > r.events[i - 1]!.generation + 1)) issue();
    if (e.type === 'parameter' && !keys.includes(e.sample.key as ParamKey)) issue();
    if (e.type === 'snapshot') {
      if (e.samples.map((s) => s.key).join('|') !== keys.join('|')) issue();
      if (e.complete !== e.samples.every((s) => s.reading.state === 'observed')) issue();
      if (!['READY', 'DEGRADED_READ_ONLY'].includes(e.link) && e.samples.some((s) => s.reading.state !== 'unavailable')) issue();
    }
  }
  for (const type of ['link', 'parameter', 'snapshot', 'safety', 'end'] as const) {
    if (r.counters[type] !== r.events.filter((e) => e.type === type).length) issue();
  }
  const last = r.events.at(-1);
  if (r.ended ? last?.type !== 'end' || last.reason !== r.stopReason || r.counters.end !== 1 : r.stopReason !== null || r.counters.end !== 0) issue();
}
export const LegacyObserverReportSchema = ObserverReportBase.extend({ schemaVersion: z.literal(1) }).superRefine(checkEvidence);
export const ObserverReportSchema = ObserverReportBase.extend({
  schemaVersion: z.literal(2), transport: z.enum(['ethernet', 'wifi']),
  routeCheck: z.enum(['each_connection_gate', 'legacy_ethernet_declaration', 'simulated']),
}).superRefine((r, ctx) => {
  checkEvidence(r, ctx);
  if (r.routeCheck === 'legacy_ethernet_declaration' && r.transport !== 'ethernet' ||
    (r.source === 'fake_websocket') !== (r.routeCheck === 'simulated')) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent transport provenance' });
  }
});
export type ObserverReport = z.infer<typeof ObserverReportSchema>;
export type ObserverEvidence = ObserverReport | z.infer<typeof LegacyObserverReportSchema>;

export function observerKeys(scope: ObserverScope): ParamKey[] {
  const keys: ParamKey[] = scope.master ? ['master.level'] : [];
  for (const ch of [...scope.channels].sort((a, b) => a - b)) {
    keys.push(`ch.${ch}.main.level`, `ch.${ch}.main.mute`);
    for (const aux of [...scope.aux].sort((a, b) => a - b)) keys.push(`ch.${ch}.aux.${aux}.level`, `ch.${ch}.aux.${aux}.mute`);
  }
  return keys;
}
export function observerLabel(key: ParamKey): string {
  const p = parseKey(key);
  if (p.kind === 'master') return 'MASTER';
  if (p.kind !== 'channel') return 'não suportado';
  return `CH ${p.channel} · ${p.aux ? `AUX ${p.aux} (bus, saída não verificada)` : 'PA'} · ${p.param}`;
}
export function parseObserverReport(input: unknown): ObserverEvidence {
  const r = z.union([ObserverReportSchema, LegacyObserverReportSchema]).safeParse(input);
  if (!r.success) throw new Error('F0C_INVALID_REPORT');
  return r.data;
}
export function parseCurrentObserverReport(input: unknown): ObserverReport {
  const r = ObserverReportSchema.safeParse(input);
  if (!r.success) throw new Error('F0C_INVALID_REPORT');
  return r.data;
}
export function exportObserverReport(input: unknown, format: 'json' | 'markdown'): string {
  const r = parseObserverReport(input);
  if (format === 'json') return JSON.stringify(r, null, 2) + '\n';
  if (format !== 'markdown') throw new Error('F0C_INVALID_FORMAT');
  const show = (s: z.infer<typeof Sample>) => `${observerLabel(s.key as ParamKey)}: ${s.reading.state === 'observed' ? s.reading.value === '-inf' ? '−∞' : String(s.reading.value) : s.reading.state === 'unknown' ? `unknown (${s.reading.reason})` : 'unavailable'}`;
  return ['# F0C — evidências somente leitura', '', `Fonte: ${r.source}; MixAI ${r.appVersion}; biblioteca ${r.libraryVersion}.`,
    `Transporte: ${r.schemaVersion === 2 ? r.transport : 'não registrado (formato legado v1)'}; preflight: ${r.schemaVersion === 2 ? r.routeCheck : 'não registrado'}.`,
    'Hardware/firmware e saídas AUX: validação pendente. Origem external não identifica quem operou.',
    `Encerrado: ${r.ended}; motivo: ${r.stopReason ?? 'em andamento'}; duração relativa: ${r.elapsedMs} ms.`,
    `Contadores: ${JSON.stringify(r.counters)}. Limite: ${r.maxEvents} eventos.`, '',
    '| # | t+ ms | Geração | Evento | Evidência |', '| --- | --- | --- | --- | --- |',
    ...r.events.map((e) => `| ${e.index} | ${e.elapsedMs} | ${e.generation} | ${e.type} | ${
      e.type === 'link' ? e.link : e.type === 'parameter' ? `${e.origin}: ${show(e.sample)}` : e.type === 'snapshot' ? `${e.link}; completo=${e.complete}; ${e.samples.map(show).join('; ')}` : e.reason} |`),
    '', 'Checklist manual: [ ] PA/HA800/fones desconectados [ ] modelo/firmware/IP e interface selecionada conferidos [ ] comparar UI oficial e eventos [ ] revisar arquivo antes de anexar.',
    'Sem payload bruto, áudio, nomes da mesa/rede, IP, PIN ou tokens. Contadores refletem notificações observadas, não todos os frames.', '',
  ].join('\n');
}
