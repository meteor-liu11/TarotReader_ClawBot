param(
  [switch]$NoLan,
  [string]$PublicBaseUrl,
  [ValidateRange(10, 300)]
  [int]$GatewayWaitSeconds = 90
)

$ErrorActionPreference = 'Stop'
$DemoRoot = Split-Path -Parent $PSScriptRoot
$OpenClawRoot = 'D:\law\OpenClaw'
$OpenClawHome = Join-Path $OpenClawRoot 'state'
$OpenClawEntry = Join-Path $OpenClawRoot 'node_modules\openclaw\openclaw.mjs'
$GatewayLauncher = Join-Path $PSScriptRoot 'start-gateway.ps1'
$BotLauncher = Join-Path $PSScriptRoot 'start-local.ps1'
$FeatureInstaller = Join-Path $PSScriptRoot 'install-inbound-guard.ps1'
$GuardSourceRoot = Join-Path $DemoRoot 'agent\inbound-guard'
$GatewayHealthUrl = 'http://127.0.0.1:18789/health'
$NodePath = 'D:\node.exe'

$PowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $PowerShell) { throw 'Windows PowerShell (powershell.exe) was not found.' }
$PowerShellPath = $PowerShell.Source

if (-not (Test-Path -LiteralPath $OpenClawEntry)) {
  throw "OpenClaw CLI entry not found: $OpenClawEntry"
}
if (-not (Test-Path -LiteralPath $NodePath)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { $NodePath = $node.Source }
  else { throw 'Node.js not found. Ensure D:\node.exe or node is available.' }
}
if (-not (Test-Path -LiteralPath $GatewayLauncher)) {
  throw "Gateway launcher not found: $GatewayLauncher"
}
if (-not (Test-Path -LiteralPath $BotLauncher)) {
  throw "ClawBot launcher not found: $BotLauncher"
}
if (-not (Test-Path -LiteralPath $FeatureInstaller)) {
  throw "Link feature installer not found: $FeatureInstaller"
}

Set-Location $DemoRoot
$env:OPENCLAW_HOME = $OpenClawHome

Write-Host 'Ensuring HTTP Hooks and tarot draw-link routing ...' -ForegroundColor Cyan
$featureArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $FeatureInstaller, '-SkipSkillSync')
& $PowerShellPath @featureArgs
if ($LASTEXITCODE -ne 0) {
  throw 'Draw-link prerequisites are not ready. Review the Hooks and plugin messages above.'
}

function Get-GatewayHealth {
  try {
    return Invoke-RestMethod -Uri $GatewayHealthUrl -TimeoutSec 3
  } catch {
    return $null
  }
}

$gatewayStartedByScript = $false
$gatewayHealth = Get-GatewayHealth
if ($gatewayHealth) {
  if ($gatewayHealth.status -ne 'live') {
    throw 'Gateway responds but is not live. Inspect its existing PowerShell window; do not start a second Gateway.'
  }
  Write-Host 'OpenClaw Gateway is already live.' -ForegroundColor Green
} else {
  Write-Host 'Gateway is offline; opening a dedicated PowerShell window on D: ...' -ForegroundColor Yellow
  $gatewayProcess = Start-Process -FilePath $PowerShellPath -ArgumentList @(
    '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $GatewayLauncher
  ) -PassThru

  $deadline = (Get-Date).AddSeconds($GatewayWaitSeconds)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if ($gatewayProcess.HasExited) {
      throw "Gateway launcher exited early (process $($gatewayProcess.Id)). Inspect its PowerShell window."
    }
    $gatewayHealth = Get-GatewayHealth
    if ($gatewayHealth -and $gatewayHealth.status -eq 'live') {
      $ready = $true
      $gatewayStartedByScript = $true
      break
    }
  }
  if (-not $ready) {
    throw "Gateway did not become healthy within $GatewayWaitSeconds seconds. Inspect the separate Gateway window; ClawBot was not started."
  }
  Write-Host 'OpenClaw Gateway is live.' -ForegroundColor Green
}

$GuardSourceFiles = @(
  (Join-Path $GuardSourceRoot 'index.mjs'),
  (Join-Path $GuardSourceRoot 'openclaw.plugin.json'),
  (Join-Path $GuardSourceRoot 'package.json')
)
foreach ($sourceFile in $GuardSourceFiles) {
  if (-not (Test-Path -LiteralPath $sourceFile)) { throw "Guard source file not found: $sourceFile" }
}
$currentGuardHash = ($GuardSourceFiles | ForEach-Object {
  (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
}) -join ':'
$WorkRoot = Join-Path $DemoRoot '.work'
$GuardHashStamp = Join-Path $WorkRoot 'tarot-inbound-guard.sourcehash'
$previousGuardHash = ''
if (Test-Path -LiteralPath $GuardHashStamp) {
  $previousGuardHash = (Get-Content -LiteralPath $GuardHashStamp -Raw).Trim()
}

$sourceChanged = $currentGuardHash -ne $previousGuardHash
if ($sourceChanged -and -not $gatewayStartedByScript) {
  throw 'Guard source changed while Gateway was already running. This Windows install cannot perform online plugin reload because OpenClaw hit a symlink EPERM. Stop the existing Gateway window with Ctrl+C, then rerun start-clawbot.bat so a fresh Gateway loads the E: source.'
}
$runtimeOutput = & $NodePath $OpenClawEntry plugins inspect tarot-inbound-guard --runtime --json 2>$null
$runtimeExit = $LASTEXITCODE
$runtimeText = ($runtimeOutput | Out-String)
if ($runtimeExit -ne 0 -or $runtimeText -notmatch 'before_dispatch' -or $runtimeText -notmatch 'message_received') {
  throw 'Inbound guard did not register message_received and before_dispatch. Do not use online plugin reload on this Windows install; stop the Gateway window with Ctrl+C and rerun start-clawbot.bat for a cold start.'
}
if ($sourceChanged -or -not (Test-Path -LiteralPath $GuardHashStamp)) {
  if (-not (Test-Path -LiteralPath $WorkRoot)) {
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
  }
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($GuardHashStamp, $currentGuardHash, $utf8NoBom)
}
Write-Host 'Tarot draw-link guard hooks are active: message_received + before_dispatch.' -ForegroundColor Green

Write-Host "Starting ClawBot from $DemoRoot in this window ..." -ForegroundColor Cyan
$botArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $BotLauncher)
if ($PublicBaseUrl) {
  $botArgs += @('-Lan', '-PublicBaseUrl', $PublicBaseUrl)
} elseif (-not $NoLan) {
  $botArgs += '-Lan'
}
& $PowerShellPath @botArgs
if ($LASTEXITCODE -ne 0) {
  throw "ClawBot launcher exited with code $LASTEXITCODE."
}
