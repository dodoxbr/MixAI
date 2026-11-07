import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WINDOWS_ROUTE_QUERY } from '../src/mixer/observer-network.js';
import { evaluateObserverRoute, WindowsRouteSnapshotSchema } from '../src/mixer/observer-route.js';

// Somente nesta fixture: shadow dos cinco cmdlets. Não consulta a rede do runner.
const fixtures = String.raw`
function Get-NetIPInterface { param($AddressFamily)
  [pscustomobject]@{InterfaceIndex=8;InterfaceMetric=20}
  [pscustomobject]@{InterfaceIndex=9;InterfaceMetric=20}
  [pscustomobject]@{InterfaceIndex=10;InterfaceMetric=10}
}
function Get-NetAdapter {
  [pscustomobject]@{ifIndex=8;Status='Up';NdisPhysicalMedium=9;HardwareInterface=$true;InterfaceDescription='Fixture Wi-Fi'}
  [pscustomobject]@{ifIndex=9;Status='Up';NdisPhysicalMedium=14;HardwareInterface=$true;InterfaceDescription='Fixture USB Gigabit'}
  [pscustomobject]@{ifIndex=10;Status='Up';NdisPhysicalMedium=14;HardwareInterface=$true;InterfaceDescription='Android Remote NDIS'}
  [pscustomobject]@{ifIndex=11;Status='Up';NdisPhysicalMedium=14;HardwareInterface=$true;InterfaceDescription='Apple Mobile Device Ethernet'}
}
function Get-NetIPAddress { param($AddressFamily)
  [pscustomobject]@{InterfaceIndex=8;IPAddress='10.10.1.20';PrefixLength=24;AddressState='Preferred'}
  [pscustomobject]@{InterfaceIndex=9;IPAddress='192.168.50.20';PrefixLength=24;AddressState='Preferred'}
  [pscustomobject]@{InterfaceIndex=10;IPAddress='192.168.42.20';PrefixLength=24;AddressState='Preferred'}
}
function Get-NetRoute { param($AddressFamily,$PolicyStore)
  [pscustomobject]@{InterfaceIndex=8;DestinationPrefix='10.10.1.0/24';RouteMetric=0}
  [pscustomobject]@{InterfaceIndex=9;DestinationPrefix='192.168.50.0/24';RouteMetric=0}
  [pscustomobject]@{InterfaceIndex=10;DestinationPrefix='0.0.0.0/0';RouteMetric=0}
}
function Find-NetRoute { param($RemoteIPAddress)
  if ($RemoteIPAddress -eq '10.10.1.1') { [pscustomobject]@{InterfaceIndex=8}; [pscustomobject]@{InterfaceIndex=8} }
  elseif ($RemoteIPAddress -eq '192.168.50.10') { [pscustomobject]@{InterfaceIndex=9} }
  else { throw 'Fixture target refused' }
}
`.trim();

it.skipIf(process.platform !== 'win32')('Restricted bloqueia .ps1, mas permite a consulta fixa com fixtures sem mudar política da máquina', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-f0e-policy-'));
  // Restrição apenas no ambiente dos filhos de teste. Nunca Set-ExecutionPolicy/registro/GPO.
  const env = { ...process.env, PSExecutionPolicyPreference: 'Restricted' };
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 262144, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extra },
  });
  try {
    const policy = run(['-Command', 'Get-ExecutionPolicy']);
    expect(policy.error).toBeUndefined(); expect(policy.stderr).toBe('');
    expect(policy.status).toBe(0); expect(policy.stdout.trim()).toBe('Restricted');
    const script = join(dir, 'blocked.ps1'); writeFileSync(script, "Write-Output 'MUST_NOT_EXECUTE'");
    const blocked = run(['-File', script]);
    expect(blocked.status).not.toBe(0); expect(blocked.stdout).not.toContain('MUST_NOT_EXECUTE');
    expect(blocked.stderr).toMatch(/PSSecurityException|UnauthorizedAccess/);
    for (const [transport, ip, index] of [['wifi', '10.10.1.1', 8], ['ethernet', '192.168.50.10', 9]] as const) {
      // Mesmo coletor fixo de produção; prefixo controlado é exclusivo deste teste.
      const query = run(['-Command', fixtures + '\n' + WINDOWS_ROUTE_QUERY], { MIXAI_F0_ROUTE_TARGET: ip });
      expect(query.error).toBeUndefined(); expect(query.status).toBe(0); expect(query.stderr).toBe('');
      const snapshot = WindowsRouteSnapshotSchema.parse(JSON.parse(query.stdout.replace(/^\uFEFF/, '')));
      expect(snapshot.adapters.find(a => a.ifIndex === 10)?.UsbTether).toBe(true);
      expect(snapshot.adapters.find(a => a.ifIndex === 11)?.UsbTether).toBe(true);
      expect(evaluateObserverRoute(snapshot, ip, transport, index)).toMatchObject({ passed: true, reason: 'ok', transport });
      expect(query.stdout).not.toMatch(/InterfaceDescription|Fixture Wi-Fi|NDIS|SSID|MAC/);
    }
    expect(run(['-Command', 'Get-ExecutionPolicy']).stdout.trim()).toBe('Restricted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);
