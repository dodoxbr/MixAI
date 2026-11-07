import { spawnSync } from 'node:child_process';
import { evaluateObserverRoute, isObserverPrivateIP, type ObserverTransport, type RouteDecision } from './observer-route.js';
export { evaluateObserverRoute, isObserverPrivateIP, RouteDecisionSchema, WindowsRouteSnapshotSchema, type ObserverTransport } from './observer-route.js';

/** Código local fixo: somente cmdlets de consulta e projeção; nenhuma entrada vira código.
 * Restricted permite comandos nativos, mas bloqueia arquivos .ps1. Se GPO/AppLocker/
 * linguagem restrita também impedir a consulta, falha fechada, sem fallback/bypass.
 */
export const WINDOWS_ROUTE_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[ordered]@{
  interfaces = @(Get-NetIPInterface -AddressFamily IPv4 | Select-Object InterfaceIndex, InterfaceMetric)
  adapters = @(Get-NetAdapter | Select-Object ifIndex,
    @{n='Up';e={$_.Status -eq 'Up'}},
    @{n='Medium';e={[int]$_.NdisPhysicalMedium}},
    @{n='Hardware';e={$_.HardwareInterface -eq $true}},
    @{n='UsbTether';e={$_.InterfaceDescription -match 'RNDIS|Remote.*NDIS|tether|mobile.*(ethernet|broadband)'}})
  addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred' | Select-Object InterfaceIndex, IPAddress, PrefixLength)
  routes = @(Get-NetRoute -AddressFamily IPv4 -PolicyStore ActiveStore | Select-Object InterfaceIndex, DestinationPrefix, RouteMetric)
  selected = @(Find-NetRoute -RemoteIPAddress $env:MIXAI_F0_ROUTE_TARGET | Select-Object InterfaceIndex)
} | ConvertTo-Json -Depth 4 -Compress
`.trim();

/** Consulta local Windows, antes de CADA socket. Não executa conexão/probe ou arquivo. */
export function queryWindowsObserverRoute(ip: string, transport: ObserverTransport, index: number): RouteDecision {
  if (process.platform !== 'win32' || !isObserverPrivateIP(ip) || !['wifi', 'ethernet'].includes(transport) || !Number.isSafeInteger(index) || index < 1 || index > 0xffffffff) throw new Error('F0D_WINDOWS_ROUTE_CHECK_REQUIRED');
  try {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ROUTE_QUERY],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 262_144, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MIXAI_F0_ROUTE_TARGET: ip } });
    if (result.error || result.status !== 0 || result.signal || result.stderr.trim()) throw new Error();
    return evaluateObserverRoute(JSON.parse(result.stdout.replace(/^\uFEFF/, '')), ip, transport, index);
  } catch { throw new Error('F0D_ROUTE_PREFLIGHT_FAILED'); } // nunca ecoa stderr, endereços ou caminhos
}

/** Mantém a assinatura do F0D; root não é mais usado para executar arquivos. */
export function confirmWindowsObserverRoute(_root: string, ip: string, transport: ObserverTransport, index: number): boolean {
  return queryWindowsObserverRoute(ip, transport, index).passed;
}
