# Somente consulta; executar em PowerShell normal, sem elevacao.
[CmdletBinding()]
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'

function Protect-Address([string]$Address) {
    $parts = $Address.Split('/')
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$ip)) { return '[endereco omitido]' }
    if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return '[IPv6 omitido]' }
    $b = $ip.GetAddressBytes()
    $private = $b[0] -eq 10 -or $b[0] -eq 127 -or $b[0] -eq 0 -or
        ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or
        ($b[0] -eq 192 -and $b[1] -eq 168) -or ($b[0] -eq 169 -and $b[1] -eq 254)
    if ($private) { return $Address }
    return '[IPv4 publico omitido]'
}

if ($SelfTest) {
    foreach ($address in @('10.0.0.2', '172.16.0.1', '172.31.255.254', '192.168.1.2/24', '169.254.1.1', '127.0.0.1', '0.0.0.0/0')) {
        if ((Protect-Address $address) -ne $address) { throw 'Falha na sanitizacao de IPv4 local.' }
    }
    foreach ($address in @('8.8.8.8', '172.32.0.1', '200.1.1.2', '2001:db8::1', 'host-secreto')) {
        if ((Protect-Address $address) -eq $address) { throw 'Falha: endereco nao local exposto.' }
    }
    Write-Output 'Preflight sanitization: PASS (sem consultas de rede)'
    exit 0
}
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Este diagnostico requer Windows. Nenhuma consulta foi executada.'
}

$report = [ordered]@{
    kind = 'mixai-yoga-preflight-readonly'
    schemaVersion = 1
    platform = 'Windows'
    nodeVersion = $null
    nodeSupported = $false
    adapters = @()
    ipv4 = @()
    routes = @()
    listeners = @()
    labLoopback8790 = $false
    warnings = @()
    manualPending = @('Identificar USB-C/RJ45 e Wi-Fi no Yoga', 'Conferir rotas/interfaces sem sobreposicao', 'Internet e celulares no Wi-Fi', 'F0 fisico somente leitura')
}
try {
    $node = Get-Command node -CommandType Application
    $version = (& $node.Source --version | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.\d+\.\d+$') {
        $report.nodeVersion = $version
        $report.nodeSupported = [int]$Matches[1] -ge 22
    }
} catch { $report.warnings += 'Node indisponivel; instalar manualmente Node >=22.' }
try {
    $report.adapters = @(Get-NetAdapter | ForEach-Object {
        # Sem nome personalizado, descricao livre, MAC, hostname ou SSID.
        $kind = if ($_.InterfaceDescription -match 'Wi-Fi|Wireless|802\.11') { 'Wi-Fi' }
                elseif ($_.InterfaceDescription -match 'USB|Ethernet|GbE|LAN') { 'Ethernet/USB (confirmar)' }
                else { 'Outro (confirmar)' }
        [pscustomobject]@{ ifIndex = $_.ifIndex; type = $kind; status = [string]$_.Status; linkSpeed = [string]$_.LinkSpeed }
    })
} catch { $report.warnings += 'Adaptadores indisponiveis nesta sessao; conferir manualmente por ifIndex.' }
try {
    $report.ipv4 = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {
        [pscustomobject]@{ ifIndex = $_.InterfaceIndex; ip = Protect-Address $_.IPAddress; prefixLength = $_.PrefixLength; state = [string]$_.AddressState }
    })
} catch { $report.warnings += 'IPv4 indisponivel nesta sessao.' }
try {
    $report.routes = @(Get-NetRoute -AddressFamily IPv4 | Sort-Object InterfaceIndex,DestinationPrefix | ForEach-Object {
        [pscustomobject]@{ ifIndex = $_.InterfaceIndex; destination = Protect-Address $_.DestinationPrefix; nextHop = Protect-Address $_.NextHop; metric = $_.RouteMetric }
    })
} catch { $report.warnings += 'Rotas indisponiveis nesta sessao.' }
try {
    $report.listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(8790,8791) } | ForEach-Object {
        [pscustomobject]@{ address = Protect-Address $_.LocalAddress; port = $_.LocalPort }
    })
} catch { $report.warnings += 'Portas indisponiveis nesta sessao.' }
$client = New-Object System.Net.Sockets.TcpClient
try {
    # Unica tentativa ativa: TCP local ao LAB padrao. Sem HTTP, DNS ou destino remoto.
    $task = $client.ConnectAsync('127.0.0.1', 8790)
    if ($task.Wait(500)) { $report.labLoopback8790 = $client.Connected }
} catch { $report.labLoopback8790 = $false }
finally { $client.Dispose() }
$report | ConvertTo-Json -Depth 6
if (-not $report.nodeSupported) { exit 1 }
