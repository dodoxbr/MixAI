import { isIP } from 'node:net';
import { z } from 'zod';

export type ObserverTransport = 'ethernet' | 'wifi';
export function isObserverPrivateIP(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
export const RouteDecisionSchema = z.object({
  schemaVersion: z.literal(1), transport: z.enum(['ethernet', 'wifi']),
  expectedInterfaceIndex: z.number().int().positive(), selectedInterfaceIndex: z.number().int().nonnegative(),
  passed: z.boolean(), reason: z.enum(['ok', 'invalid_target', 'snapshot_incomplete', 'interface_down', 'transport_mismatch',
    'route_via_usb_tether', 'unexpected_interface', 'target_not_on_link', 'overlapping_subnets', 'ambiguous_routes', 'query_unavailable']),
}).strict().refine((d) => d.passed ? d.reason === 'ok' && d.selectedInterfaceIndex === d.expectedInterfaceIndex : d.reason !== 'ok');

export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
const indexSchema = z.number().int().min(1).max(0xffffffff);
const metricSchema = z.number().int().min(0).max(0xffffffff);
const ipv4Schema = z.string().max(15).refine((s) => isIP(s) === 4);
const prefixSchema = z.number().int().min(0).max(32);
const destinationSchema = z.string().max(18).refine((s) => {
  const [address, prefix, extra] = s.split('/');
  return extra === undefined && isIP(address!) === 4 && /^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix ?? '');
});
/** Snapshot privado e efêmero. Somente a decisão sanitizada pode sair do preflight. */
export const WindowsRouteSnapshotSchema = z.object({
  interfaces: z.array(z.object({ InterfaceIndex: indexSchema, InterfaceMetric: metricSchema }).strict()).min(1).max(512),
  adapters: z.array(z.object({ ifIndex: indexSchema, Up: z.boolean(), Medium: z.number().int().min(0).max(255), Hardware: z.boolean(), UsbTether: z.boolean() }).strict()).min(1).max(512),
  addresses: z.array(z.object({ InterfaceIndex: indexSchema, IPAddress: ipv4Schema, PrefixLength: prefixSchema }).strict()).min(1).max(2048),
  routes: z.array(z.object({ InterfaceIndex: indexSchema, DestinationPrefix: destinationSchema, RouteMetric: metricSchema }).strict()).min(1).max(4096),
  selected: z.array(z.object({ InterfaceIndex: indexSchema }).strict()).min(1).max(2),
}).strict();
export type WindowsRouteSnapshot = z.infer<typeof WindowsRouteSnapshotSchema>;
function inPrefix(address: string, network: string, prefix: number): boolean {
  const integer = (ip: string) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
  const block = 2 ** (32 - prefix);
  return Math.floor(integer(address) / block) === Math.floor(integer(network) / block);
}

/** Único algoritmo de decisão, compartilhado pelo CLI e o guard de cada conexão. */
export function evaluateObserverRoute(raw: unknown, ip: string, transport: ObserverTransport, expected: number): RouteDecision {
  let selected = 0;
  const decide = (reason: RouteDecision['reason']): RouteDecision => RouteDecisionSchema.parse({
    schemaVersion: 1, transport, expectedInterfaceIndex: expected, selectedInterfaceIndex: selected, passed: reason === 'ok', reason,
  });
  if (!isObserverPrivateIP(ip)) return decide('invalid_target');
  const parsed = WindowsRouteSnapshotSchema.safeParse(raw);
  if (!parsed.success) return decide('snapshot_incomplete');
  const snapshot = parsed.data;
  const selectedIndices = new Set(snapshot.selected.map((a) => a.InterfaceIndex));
  if (selectedIndices.size !== 1) return decide('snapshot_incomplete');
  selected = snapshot.selected[0]!.InterfaceIndex;
  // Dados duplicados/incoerentes não podem escolher arbitrariamente a primeira NIC/métrica.
  if (new Set(snapshot.adapters.map((a) => a.ifIndex)).size !== snapshot.adapters.length ||
    new Set(snapshot.interfaces.map((a) => a.InterfaceIndex)).size !== snapshot.interfaces.length) return decide('snapshot_incomplete');
  const chosen = snapshot.adapters.find((a) => a.ifIndex === selected);
  const adapter = snapshot.adapters.find((a) => a.ifIndex === expected);
  if (!chosen || !adapter) return decide('snapshot_incomplete');
  if (!adapter.Up) return decide('interface_down');
  // Tether nunca é promovido a Ethernet/Wi-Fi, mesmo com índice igual ao esperado.
  if (chosen.UsbTether) return decide('route_via_usb_tether');
  if (selected !== expected) return decide('unexpected_interface');
  const kind = [1, 9].includes(chosen.Medium) ? 'wifi' : chosen.Medium === 14 && chosen.Hardware ? 'ethernet' : 'other';
  if (kind !== transport) return decide('transport_mismatch');
  const active = new Set(snapshot.adapters.filter((a) => a.Up).map((a) => a.ifIndex));
  const onlink = snapshot.addresses.filter((a) => active.has(a.InterfaceIndex) && a.PrefixLength > 0 && inPrefix(ip, a.IPAddress, a.PrefixLength));
  if (!onlink.some((a) => a.InterfaceIndex === expected)) return decide('target_not_on_link');
  if (new Set(onlink.map((a) => a.InterfaceIndex)).size > 1) return decide('overlapping_subnets');
  const matching = [];
  for (const route of snapshot.routes) {
    const [network, prefixText] = route.DestinationPrefix.split('/');
    const prefix = Number(prefixText);
    if (!active.has(route.InterfaceIndex) || !inPrefix(ip, network!, prefix)) continue;
    const metric = snapshot.interfaces.find((a) => a.InterfaceIndex === route.InterfaceIndex);
    if (!metric) return decide('snapshot_incomplete');
    matching.push({ index: route.InterfaceIndex, prefix, cost: route.RouteMetric + metric.InterfaceMetric });
  }
  matching.sort((a, b) => b.prefix - a.prefix || a.cost - b.cost);
  const best = matching[0];
  if (!best) return decide('snapshot_incomplete');
  const ties = new Set(matching.filter((r) => r.prefix === best.prefix && r.cost === best.cost).map((r) => r.index));
  if (ties.size > 1) return decide('ambiguous_routes');
  if (best.index !== selected) return decide('snapshot_incomplete');
  return decide('ok');
}
