# F0D: consulta de rota/interface; sem probes, SSID, MAC, senha ou alteracoes de rede.
[CmdletBinding()]
param([string]$TargetIp = '', [string]$Transport = '', [int]$InterfaceIndex = 0, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'

function Test-PrivateTarget([string]$Value) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $b = $parsed.GetAddressBytes()
    return $b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or
        ($b[0] -eq 192 -and $b[1] -eq 168) -or ($b[0] -eq 169 -and $b[1] -eq 254)
}
function Test-Prefix([string]$Address, [string]$Network, [int]$Prefix) {
    if ($Prefix -lt 0 -or $Prefix -gt 32) { return $false }
    $a = $null; $n = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$a) -or -not [System.Net.IPAddress]::TryParse($Network, [ref]$n)) { return $false }
    $ab = $a.GetAddressBytes(); $nb = $n.GetAddressBytes()
    if ($ab.Length -ne 4 -or $nb.Length -ne 4) { return $false }
    for ($i=0; $i -lt 4; $i++) {
        $bits = [Math]::Min(8, [Math]::Max(0, $Prefix - 8*$i))
        $mask = 255 - ((1 -shl (8-$bits))-1)
        if (($ab[$i] -band $mask) -ne ($nb[$i] -band $mask)) { return $false }
    }
    return $true
}
function Get-AdapterKind($Adapter) {
    if ([int]$Adapter.NdisPhysicalMedium -in @(1,9)) { return 'wifi' }
    if ($Adapter.InterfaceDescription -match 'RNDIS|Remote.*NDIS|tether|mobile.*(ethernet|broadband)') { return 'usb_tether' }
    if ([int]$Adapter.NdisPhysicalMedium -eq 14 -and $Adapter.HardwareInterface -eq $true) { return 'ethernet' }
    return 'other'
}
function Test-RouteSnapshot([string]$Target, [string]$Mode, [int]$Expected, [int]$Selected, $Adapters, $Addresses, $Routes) {
    if (-not (Test-PrivateTarget $Target) -or $Mode -notin @('ethernet','wifi') -or $Expected -le 0) { return 'invalid_target' }
    $chosen = @($Adapters | Where-Object { $_.Index -eq $Selected })
    $expectedAdapter = @($Adapters | Where-Object { $_.Index -eq $Expected })
    if ($chosen.Count -ne 1 -or $expectedAdapter.Count -ne 1) { return 'snapshot_incomplete' }
    if (-not $expectedAdapter[0].Up) { return 'interface_down' }
    if ($Selected -ne $Expected) {
        if ($chosen[0].Kind -eq 'usb_tether') { return 'route_via_usb_tether' }
        return 'unexpected_interface'
    }
    if ($chosen[0].Kind -ne $Mode) { return 'transport_mismatch' }
    $active = @($Adapters | Where-Object Up | ForEach-Object Index)
    $onlink = @($Addresses | Where-Object { $_.Index -in $active -and $_.Prefix -gt 0 -and (Test-Prefix $Target $_.IP $_.Prefix) })
    if (@($onlink | Where-Object { $_.Index -eq $Expected }).Count -eq 0) { return 'target_not_on_link' }
    if (@($onlink | Select-Object -ExpandProperty Index -Unique).Count -gt 1) { return 'overlapping_subnets' }
    foreach ($route in $Routes) {
        if ($route.Index -in $active -and (Test-Prefix $Target $route.Network $route.Prefix)) {
            $owner = @($Adapters | Where-Object { $_.Index -eq $route.Index })
            if ($owner.Count -ne 1 -or $null -eq $owner[0].Metric -or $null -eq $route.Metric) { return 'snapshot_incomplete' }
        }
    }
    $matching = @($Routes | Where-Object { $_.Index -in $active -and (Test-Prefix $Target $_.Network $_.Prefix) } | ForEach-Object {
        $r = $_; $adapter = $Adapters | Where-Object { $_.Index -eq $r.Index } | Select-Object -First 1
        [pscustomobject]@{ Index=$r.Index; Prefix=$r.Prefix; Cost=([long]$r.Metric + [long]$adapter.Metric) }
    } | Sort-Object @{Expression='Prefix';Descending=$true},Cost)
    if ($matching.Count -eq 0) { return 'snapshot_incomplete' }
    $best = $matching[0]
    $ties = @($matching | Where-Object { $_.Prefix -eq $best.Prefix -and $_.Cost -eq $best.Cost } | Select-Object -ExpandProperty Index -Unique)
    if ($ties.Count -gt 1) { return 'ambiguous_routes' }
    if ($best.Index -ne $Selected) { return 'snapshot_incomplete' }
    return 'ok'
}
if ($SelfTest) {
    # So fixtures: nunca chama Find-NetRoute/Get-NetAdapter ou um destino real.
    $adapters = @([pscustomobject]@{Index=7;Kind='wifi';Up=$true;Metric=20}, [pscustomobject]@{Index=8;Kind='ethernet';Up=$true;Metric=20}, [pscustomobject]@{Index=9;Kind='usb_tether';Up=$true;Metric=10})
    $addresses = @([pscustomobject]@{Index=7;IP='10.10.1.20';Prefix=24}, [pscustomobject]@{Index=8;IP='192.168.50.20';Prefix=24}, [pscustomobject]@{Index=9;IP='192.168.42.20';Prefix=24})
    $routes = @([pscustomobject]@{Index=7;Network='10.10.1.0';Prefix=24;Metric=0}, [pscustomobject]@{Index=8;Network='192.168.50.0';Prefix=24;Metric=0}, [pscustomobject]@{Index=9;Network='0.0.0.0';Prefix=0;Metric=0})
    if ((Test-RouteSnapshot '10.10.1.1' 'wifi' 7 7 $adapters $addresses $routes) -ne 'ok') { throw 'Wi-Fi fixture failed' }
    if ((Test-RouteSnapshot '192.168.50.10' 'ethernet' 8 8 $adapters $addresses $routes) -ne 'ok') { throw 'Ethernet fixture failed' }
    if ((Test-RouteSnapshot '10.10.1.1' 'wifi' 7 9 $adapters $addresses $routes) -ne 'route_via_usb_tether') { throw 'Tether rejection failed' }
    if ((Test-RouteSnapshot '10.10.1.1' 'ethernet' 7 7 $adapters $addresses $routes) -ne 'transport_mismatch') { throw 'Kind rejection failed' }
    if ((Test-RouteSnapshot '10.10.2.1' 'wifi' 7 7 $adapters $addresses $routes) -ne 'target_not_on_link') { throw 'Subnet rejection failed' }
    $overlap = @($addresses) + [pscustomobject]@{Index=9;IP='10.10.1.21';Prefix=24}
    if ((Test-RouteSnapshot '10.10.1.1' 'wifi' 7 7 $adapters $overlap $routes) -ne 'overlapping_subnets') { throw 'Overlap rejection failed' }
    $ties = @($routes) + [pscustomobject]@{Index=9;Network='10.10.1.0';Prefix=24;Metric=10}
    if ((Test-RouteSnapshot '10.10.1.1' 'wifi' 7 7 $adapters $addresses $ties) -ne 'ambiguous_routes') { throw 'Ambiguous rejection failed' }
    if ((Test-RouteSnapshot '8.8.8.8' 'wifi' 7 7 $adapters $addresses $routes) -ne 'invalid_target') { throw 'Public rejection failed' }
    $adapters[0].Up=$false
    if ((Test-RouteSnapshot '10.10.1.1' 'wifi' 7 7 $adapters $addresses $routes) -ne 'interface_down') { throw 'Down rejection failed' }
    foreach ($kind in @(@(9,'secret','wifi'),@(14,'Android Remote NDIS','usb_tether'),@(14,'Apple Mobile Device Ethernet','usb_tether'),@(14,'USB Gigabit','ethernet'),@(0,'Unknown','other'))) {
        if ((Get-AdapterKind ([pscustomobject]@{NdisPhysicalMedium=$kind[0];InterfaceDescription=$kind[1];HardwareInterface=$true})) -ne $kind[2]) { throw 'Adapter classifier failed' }
    }
    Write-Output 'F0D route self-test: PASS (fixtures only; no network query)'
    exit 0
}
$result = [ordered]@{schemaVersion=1;transport=$Transport;expectedInterfaceIndex=$InterfaceIndex;selectedInterfaceIndex=0;passed=$false;reason='query_unavailable'}
if (-not (Test-PrivateTarget $TargetIp) -or $Transport -notin @('ethernet','wifi') -or $InterfaceIndex -le 0) { $result.reason='invalid_target' }
elseif ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    try {
        $metrics = @(Get-NetIPInterface -AddressFamily IPv4)
        $adapters = @(Get-NetAdapter | ForEach-Object {
            $index = $_.ifIndex; $metric = $metrics | Where-Object InterfaceIndex -eq $index | Select-Object -First 1
            [pscustomobject]@{Index=$index;Kind=(Get-AdapterKind $_);Up=($_.Status -eq 'Up');Metric=$metric.InterfaceMetric}
        })
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred' | ForEach-Object { [pscustomobject]@{Index=$_.InterfaceIndex;IP=$_.IPAddress;Prefix=$_.PrefixLength} })
        $routes = @(Get-NetRoute -AddressFamily IPv4 -PolicyStore ActiveStore | ForEach-Object {
            $p = $_.DestinationPrefix.Split('/'); [pscustomobject]@{Index=$_.InterfaceIndex;Network=$p[0];Prefix=[int]$p[1];Metric=$_.RouteMetric}
        })
        $choice = @(Find-NetRoute -RemoteIPAddress $TargetIp)
        $indices = @($choice | Select-Object -ExpandProperty InterfaceIndex -Unique)
        if ($indices.Count -eq 1) {
            $result.selectedInterfaceIndex = [int]$indices[0]
            $result.reason = Test-RouteSnapshot $TargetIp $Transport $InterfaceIndex $result.selectedInterfaceIndex $adapters $addresses $routes
            $result.passed = $result.reason -eq 'ok'
        } else { $result.reason='snapshot_incomplete' }
    } catch { $result.reason='query_unavailable' }
}
$result | ConvertTo-Json -Compress
if (-not $result.passed) { exit 1 }
