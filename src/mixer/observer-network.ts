import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { join } from 'node:path';
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

/** Consulta Windows somente leitura, antes de CADA socket. Não executa conexão/probe. */
export function confirmWindowsObserverRoute(root: string, ip: string, transport: ObserverTransport, index: number): boolean {
  if (process.platform !== 'win32' || !isObserverPrivateIP(ip) || !Number.isInteger(index) || index < 1) throw new Error('F0D_WINDOWS_ROUTE_CHECK_REQUIRED');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts', 'ui16-route-preflight.ps1'),
      '-TargetIp', ip, '-Transport', transport, '-InterfaceIndex', String(index)],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error();
    const output = result.stdout;
    const decision = RouteDecisionSchema.safeParse(JSON.parse(output.replace(/^\uFEFF/, '')));
    if (!decision.success || decision.data.transport !== transport || decision.data.expectedInterfaceIndex !== index) throw new Error();
    return decision.data.passed;
  } catch { throw new Error('F0D_ROUTE_PREFLIGHT_FAILED'); } // nunca ecoa stderr, endereços ou caminhos
}
