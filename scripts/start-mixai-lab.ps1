<#
.SYNOPSIS
  Sobe o MixAI em LABORATORIO no Windows, com a base de conhecimento local.

.DESCRIPTION
  1. Verifica o Docker Desktop (so se a base usa PostgreSQL).
  2. Verifica/sobe o PostgreSQL com pgvector (apenas o servico "postgres" do docker-compose).
  3. Verifica/sobe o Ollama nativo.
  4. Confirma que os modelos configurados (embeddings e conversa) estao instalados.
  5. Inicia o servidor MixAI em modo LAB (sempre --lab; este script NAO tem opcao REAL).
  6. Executa os healthchecks e mostra a URL local.

  Seguranca: nunca executa serve:real, nunca habilita LAN, nunca fala com a mesa fisica e nao imprime
  senhas, PINs nem tokens. Servicos so em 127.0.0.1.

  Uso (sem alterar a politica de execucao do Windows; o bypass vale so para este processo):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-mixai-lab.ps1
    npm run lab:start

.PARAMETER CheckOnly
  So verifica e informa; nao inicia nenhum servico nem o servidor.

.PARAMETER Build
  Recompila o servidor e a interface antes de iniciar (por padrao so compila se faltar o dist/).

.PARAMETER WaitSeconds
  Tempo maximo de espera por cada servico (padrao 90).
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$Build,
  [ValidateRange(10, 600)][int]$WaitSeconds = 90
)

# Continue: comandos nativos (docker, ollama) escrevem em stderr sem derrubar o script; cada verificacao trata o proprio erro.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Port = 8790
$Failures = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$Message) { Write-Host "[mixai] $Message" }
function Write-Ok([string]$Message)   { Write-Host "[ ok ] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[aviso] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[falha] $Message" -ForegroundColor Red; $Failures.Add($Message) }

function Wait-Until([scriptblock]$Test, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { if (& $Test) { return $true } } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

# Processos de segundo plano (servidor e Ollama) nascem pelo WMI (Win32_Process.Create): assim NAO herdam os
# handles do chamador, e um pipeline como "script | Select-String" termina quando o script termina. A saida
# deles vai para arquivos em logs/ (sem senhas: o servidor nao imprime segredos).
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
function Start-Detached([string]$File, [string[]]$Arguments, [string]$LogName) {
  $quoted = @($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $out = Join-Path $Root "logs\$LogName.out.log"
  $err = Join-Path $Root "logs\$LogName.err.log"
  $line = 'cmd.exe /d /c ""{0}" {1} >>"{2}" 2>>"{3}""' -f $File, $quoted, $out, $err
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $Root }
  if ($result.ReturnValue -ne 0) { throw ("Nao foi possivel iniciar {0} (codigo {1})." -f $LogName, $result.ReturnValue) }
}

function Get-Json([string]$Url, [int]$TimeoutSec = 5) {
  Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec -Headers @{ Accept = 'application/json' } -ErrorAction Stop
}

# --- Node e build -----------------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Fail 'Node.js nao encontrado no PATH (requer Node 22 ou superior).'; exit 1 }
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npm) { Write-Fail 'npm.cmd nao encontrado no PATH.'; exit 1 }

$needsServer = $Build -or -not (Test-Path 'dist\serve.js')
$needsWeb = $Build -or -not (Test-Path 'dist\web\browser\index.html')
if (($needsServer -or $needsWeb) -and -not $CheckOnly) {
  if ($needsServer) { Write-Step 'Compilando o servidor (npm run build)...'; & npm.cmd run build | Out-Host; if ($LASTEXITCODE -ne 0) { Write-Fail 'Falha ao compilar o servidor.'; exit 1 } }
  if ($needsWeb) { Write-Step 'Compilando a interface (npm run build:web)...'; & npm.cmd run build:web | Out-Host; if ($LASTEXITCODE -ne 0) { Write-Fail 'Falha ao compilar a interface.'; exit 1 } }
} elseif ($needsServer -or $needsWeb) {
  Write-Warn 'dist/ incompleto: rode sem -CheckOnly (ou com -Build) para compilar.'
}

# --- Configuracao efetiva (sem segredos) ------------------------------------------------------
$probe = @"
import('./dist/core/config.js').then(m => {
  const c = m.loadConfig().config;
  const k = c.knowledge;
  console.log(JSON.stringify({
    enabled: k.enabled, store: k.store, collection: k.collection, search: k.search,
    pgPort: k.postgres.port, ollamaUrl: k.ollama.url, embedModel: k.ollama.embedModel, chatModel: k.ollama.chatModel,
    narrative: k.ollama.narrative, lan: c.server.lan.enabled, mode: c.mixer.mode, port: m.serverPort(c)
  }));
}).catch(e => { console.error('config: ' + String(e.message).split('\n')[0].slice(0, 120)); process.exit(2); });
"@
$cfg = $null
try { $cfg = (& node -e $probe) | ConvertFrom-Json } catch { }
if (-not $cfg) { Write-Fail 'Nao foi possivel ler a configuracao (rode "npm run build" e confira config/config.local.yaml).'; exit 1 }
if ($cfg.port) { $Port = [int]$cfg.port }
Write-Step ("Configuracao: base {0}{1} | embeddings {2} | conversa {3} | resumo do modelo {4}" -f $cfg.store, $(if ($cfg.collection -ne 'default') { " (colecao $($cfg.collection))" } else { '' }), $cfg.embedModel, $cfg.chatModel, $(if ($cfg.narrative) { 'ligado' } else { 'desligado' }))
if ($cfg.lan) { Write-Warn 'server.lan esta habilitado na configuracao local. Este script nao altera isso; confira se o Wi-Fi atual e o da banda.' }

# --- 1 e 2: Docker Desktop e PostgreSQL --------------------------------------------------------
$docker = (Get-Command docker -ErrorAction SilentlyContinue)
if (-not $docker) {
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
  if (Test-Path $candidate) { $env:Path += ";$(Split-Path $candidate)"; $docker = Get-Command docker -ErrorAction SilentlyContinue }
}
if ($cfg.enabled -and $cfg.store -eq 'postgres') {
  if (-not $docker) { Write-Fail 'Docker nao encontrado (instale o Docker Desktop ou use knowledge.store: file).' }
  else {
    $engineUp = $false
    try { & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null; $engineUp = ($LASTEXITCODE -eq 0) } catch { }
    if (-not $engineUp -and -not $CheckOnly) {
      $desktop = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'
      if (-not (Test-Path $desktop)) { $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }
      if (Test-Path $desktop) {
        Write-Step 'Iniciando o Docker Desktop...'
        Start-Process -FilePath $desktop -WindowStyle Minimized
        $engineUp = Wait-Until { & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null; $LASTEXITCODE -eq 0 } $WaitSeconds
      }
    }
    if (-not $engineUp) { Write-Fail 'O motor do Docker nao esta em execucao.' }
    else {
      Write-Ok ('Docker Desktop: motor ativo ({0})' -f ((& docker --version) -replace '^Docker version ', ''))
      if (-not (Test-Path '.env')) { Write-Fail 'Arquivo .env ausente (crie a partir de .env.example com MIXAI_PG_PASSWORD).' }
      else {
        $state = (& docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' postgres 2>$null) -join ' '
        if ($state -notmatch 'running') {
          if ($CheckOnly) { Write-Fail 'PostgreSQL parado (rode sem -CheckOnly para iniciar).' }
          else {
            Write-Step 'Iniciando o PostgreSQL (docker compose up -d postgres)...'
            & docker compose up -d postgres 2>&1 | Out-Null
          }
        }
        if (-not $CheckOnly -or $state -match 'running') {
          $healthy = Wait-Until { ((& docker compose ps --format '{{.Health}}' postgres 2>$null) -join ' ') -match 'healthy' } $WaitSeconds
          if ($healthy) { Write-Ok 'PostgreSQL com pgvector: saudavel (somente em 127.0.0.1)' } else { Write-Fail 'PostgreSQL nao ficou saudavel a tempo.' }
        }
      }
    }
  }
} elseif ($cfg.enabled) { Write-Ok 'Base em arquivo local: Docker nao e necessario.' }
else { Write-Warn 'knowledge.enabled esta desligado: o MixAI usa so o motor deterministico.' }

# --- 3 e 4: Ollama e modelos configurados ------------------------------------------------------
if ($cfg.enabled) {
  $tagsUrl = ($cfg.ollamaUrl.TrimEnd('/')) + '/api/tags'
  $up = $false
  try { Get-Json $tagsUrl 3 | Out-Null; $up = $true } catch { }
  if (-not $up -and -not $CheckOnly) {
    $exe = (Get-Command ollama -ErrorAction SilentlyContinue)
    $path = if ($exe) { $exe.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
    if (Test-Path $path) {
      Write-Step 'Iniciando o Ollama (ollama serve)...'
      Start-Detached $path @('serve') 'ollama'
      $up = Wait-Until { Get-Json $tagsUrl 3 | Out-Null; $true } $WaitSeconds
    }
  }
  if (-not $up) { Write-Fail 'Ollama indisponivel (o diagnostico segue pelo motor deterministico, sem busca semantica).' }
  else {
    $names = @((Get-Json $tagsUrl 5).models | ForEach-Object { $_.name })
    $has = { param($m) ($names -contains $m) -or ($names -contains "$m`:latest") -or (-not $m.Contains(':') -and ($names | Where-Object { $_.Split(':')[0] -eq $m })) }
    Write-Ok ("Ollama ativo ({0} modelo(s))" -f $names.Count)
    foreach ($pair in @(@('embeddings', $cfg.embedModel, $true), @('conversa', $cfg.chatModel, [bool]$cfg.narrative))) {
      if (& $has $pair[1]) { Write-Ok ("Modelo de {0} disponivel: {1}" -f $pair[0], $pair[1]) }
      elseif ($pair[2]) { Write-Fail ("Modelo de {0} ausente: rode ollama pull {1}" -f $pair[0], $pair[1]) }
      else { Write-Warn ("Modelo de {0} ausente ({1}); o resumo esta desligado, entao nao e necessario." -f $pair[0], $pair[1]) }
    }
  }
}

if ($CheckOnly) {
  if ($Failures.Count) { Write-Host ''; Write-Host ("{0} problema(s) encontrado(s)." -f $Failures.Count) -ForegroundColor Red; exit 1 }
  Write-Ok 'Verificacao concluida (nada foi iniciado).'
  exit 0
}

# --- 5: servidor MixAI em LAB -----------------------------------------------------------------
$helloUrl = "http://127.0.0.1:$Port/api/hello"
$running = $null
try { $running = Get-Json $helloUrl 3 } catch { }
if ($running) {
  if ($running.mode -ne 'lab') { Write-Fail "Ja existe um servidor MixAI na porta $Port em modo '$($running.mode)', nao LAB. Nada foi alterado; encerre-o e rode de novo."; exit 1 }
  Write-Ok "Servidor MixAI ja esta em execucao em modo LAB (porta $Port)."
} else {
  Write-Step 'Iniciando o servidor MixAI em LABORATORIO (node dist/serve.js --lab)...'
  Start-Detached $node.Source @('dist/serve.js', '--lab') 'serve-lab'
  $ready = Wait-Until { (Get-Json $helloUrl 3).mode -eq 'lab' } $WaitSeconds
  if (-not $ready) { Write-Fail "O servidor nao respondeu a tempo. Veja logs\serve-lab.err.log."; }
}

# --- 6: healthchecks --------------------------------------------------------------------------
try {
  $hello = Get-Json $helloUrl 5
  if ($hello.mode -eq 'lab') { Write-Ok 'Servidor: responde e esta em modo LAB (sem conexao com a mesa fisica).' }
  else { Write-Fail "Servidor em modo inesperado: $($hello.mode)." }
} catch { Write-Fail 'Servidor nao responde em /api/hello.' }

if ($cfg.enabled) {
  Write-Step 'Verificando a base de conhecimento (npm run knowledge -- doctor)...'
  $doctor = & node dist/knowledge-cli.js doctor 2>&1
  $doctor | ForEach-Object { Write-Host "       $_" }
  if ($LASTEXITCODE -ne 0 -or ($doctor -join ' ') -match 'com problema|indisponivel|indisponível') { Write-Warn 'A base reportou problema: o diagnostico continua pelo motor deterministico.' }
}

Write-Host ''
if ($Failures.Count) { Write-Host ("{0} problema(s): {1}" -f $Failures.Count, ($Failures -join ' | ')) -ForegroundColor Red; exit 1 }
Write-Ok "MixAI em LABORATORIO pronto: http://127.0.0.1:$Port"
Write-Host '       Entre com o PIN de operador. Nenhum comando e enviado a mesa fisica.'
exit 0
