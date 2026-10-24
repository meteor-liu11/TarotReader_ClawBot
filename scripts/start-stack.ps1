param(
  [switch]$LocalOnly,
  [switch]$Lan,
  [switch]$NoLan,
  [string]$PublicBaseUrl,
  [string]$PagesBaseUrl = 'https://meteor-liu11.github.io/TarotReader_ClawBot/',
  [ValidateRange(10, 300)]
  [int]$GatewayWaitSeconds = 90,
  [ValidateRange(20, 180)]
  [int]$TunnelWaitSeconds = 90
)

$ErrorActionPreference = 'Stop'
$DemoRoot = Split-Path -Parent $PSScriptRoot
$OpenClawRoot = 'D:\law\OpenClaw'
$OpenClawHome = Join-Path $OpenClawRoot 'state'
$OpenClawEntry = Join-Path $OpenClawRoot 'node_modules\openclaw\openclaw.mjs'
$GatewayLauncher = Join-Path $PSScriptRoot 'start-gateway.ps1'
$BotLauncher = Join-Path $PSScriptRoot 'start-local.ps1'
$FeatureInstaller = Join-Path $PSScriptRoot 'install-inbound-guard.ps1'
$PublicProxyScript = Join-Path $PSScriptRoot 'public-proxy.mjs'
$GuardSourceRoot = Join-Path $DemoRoot 'agent\inbound-guard'
$GatewayHealthUrl = 'http://127.0.0.1:18789/health'
$ProxyHealthUrl = 'http://127.0.0.1:8788/_local-health'
$NodePath = 'D:\node.exe'
$ProxyProcess = $null
$TunnelProcess = $null

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
foreach ($required in @($GatewayLauncher, $BotLauncher, $FeatureInstaller, $PublicProxyScript)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required startup file not found: $required" }
}

if ($NoLan) {
  if ($Lan -or $PublicBaseUrl) { throw '-NoLan cannot be combined with -Lan or -PublicBaseUrl.' }
  $LocalOnly = $true
}
if ($LocalOnly -and ($Lan -or $PublicBaseUrl)) {
  throw '-LocalOnly is loopback-only. Use scripts/start-local.ps1 -Lan for a separate LAN-only test.'
}
if (-not $LocalOnly -and ($Lan -or $PublicBaseUrl)) {
  throw 'Public Pages mode keeps the backend loopback-only. Use scripts/start-local.ps1 -Lan for a separate LAN-only test.'
}

Set-Location $DemoRoot
$env:OPENCLAW_HOME = $OpenClawHome

Write-Host 'Ensuring HTTP Hooks and tarot draw-link routing ...' -ForegroundColor Cyan
$featureArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $FeatureInstaller + '"'), '-SkipSkillSync')
& $PowerShellPath @featureArgs
if ($LASTEXITCODE -ne 0) {
  throw 'Draw-link prerequisites are not ready. Review the Hooks and plugin messages above.'
}

function Get-GatewayHealth {
  try { return Invoke-RestMethod -Uri $GatewayHealthUrl -TimeoutSec 3 } catch { return $null }
}

function Find-Cloudflared {
  $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command cloudflared -ErrorAction SilentlyContinue }
  if ($command) { return $command.Source }
  foreach ($programFiles in @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }) {
    foreach ($relative in @('Cloudflare\cloudflared.exe', 'Cloudflare\cloudflared\cloudflared.exe')) {
      $installed = Join-Path $programFiles $relative
      if (Test-Path -LiteralPath $installed) { return $installed }
    }
  }
  $bundled = Join-Path $DemoRoot 'tools\cloudflared.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  return $null
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
  $gatewayArgs = @(
    '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $GatewayLauncher + '"')
  )
  $gatewayProcess = Start-Process -FilePath $PowerShellPath -ArgumentList $gatewayArgs -PassThru

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
  if (-not (Test-Path -LiteralPath $WorkRoot)) { New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null }
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($GuardHashStamp, $currentGuardHash, $utf8NoBom)
}
Write-Host 'Tarot draw-link guard hooks are active: message_received + before_dispatch.' -ForegroundColor Green

try {
  if ($LocalOnly) {
    $env:PUBLIC_H5_BASE_URL = ''
    $env:PUBLIC_API_BASE_URL = ''
    $env:PAGES_ORIGIN = ''
    Write-Host 'Local-only mode selected; no public tunnel will be started.' -ForegroundColor Yellow
  } else {
    $page = [Uri]$PagesBaseUrl
    if (-not $page.IsAbsoluteUri -or $page.Scheme -ne 'https' -or $page.UserInfo -or $page.Query -or $page.Fragment) {
      throw 'PagesBaseUrl must be a clean HTTPS page URL, for example https://meteor-liu11.github.io/TarotReader_ClawBot/.'
    }
    $cloudflaredPath = Find-Cloudflared
    if (-not $cloudflaredPath) {
      throw 'cloudflared was not found. Install it using Cloudflare Windows instructions at https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ , then rerun start-clawbot.bat.'
    }

    try {
      $existingApp = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2
      if ($existingApp.ok) {
        throw 'A ClawBot service is already using port 8787. Stop the old service window with Ctrl+C before starting a fresh tunnel.'
      }
    } catch {
      if ($_.Exception.Message -like 'A ClawBot service is already using port 8787*') { throw }
    }
    try {
      $existingProxy = Invoke-RestMethod -Uri $ProxyHealthUrl -TimeoutSec 2
      if ($existingProxy.ok) { throw 'An old public API proxy is already using port 8788. Close its previous start window or stop its node.exe process, then retry.' }
    } catch {
      if ($_.Exception.Message -like 'An old public API proxy is already using port 8788*') { throw }
    }

    if (-not (Test-Path -LiteralPath $WorkRoot)) { New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null }
    $pagesOrigin = $page.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
    $env:PAGES_ORIGIN = $pagesOrigin
    $env:PUBLIC_PROXY_HOST = '127.0.0.1'
    $env:PUBLIC_PROXY_PORT = '8788'
    $env:PUBLIC_PROXY_UPSTREAM_HOST = '127.0.0.1'
    $env:PUBLIC_PROXY_UPSTREAM_PORT = '8787'

    $proxyOut = Join-Path $WorkRoot 'public-proxy.out.log'
    $proxyErr = Join-Path $WorkRoot 'public-proxy.err.log'
    Remove-Item -LiteralPath $proxyOut, $proxyErr -Force -ErrorAction SilentlyContinue
    $ProxyProcess = Start-Process -FilePath $NodePath -ArgumentList @('"' + $PublicProxyScript + '"') `
      -WorkingDirectory $DemoRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $proxyOut -RedirectStandardError $proxyErr

    $proxyDeadline = (Get-Date).AddSeconds(15)
    $proxyReady = $false
    while ((Get-Date) -lt $proxyDeadline) {
      Start-Sleep -Milliseconds 500
      if ($ProxyProcess.HasExited) { break }
      try {
        $proxyHealth = Invoke-RestMethod -Uri $ProxyHealthUrl -TimeoutSec 2
        if ($proxyHealth.ok) { $proxyReady = $true; break }
      } catch { }
    }
    if (-not $proxyReady) {
      $detail = if (Test-Path -LiteralPath $proxyErr) { Get-Content -LiteralPath $proxyErr -Raw } else { 'no proxy log' }
      throw "Filtered local API proxy did not start. $detail"
    }

    $tunnelOut = Join-Path $WorkRoot 'cloudflared.out.log'
    $tunnelErr = Join-Path $WorkRoot 'cloudflared.err.log'
    Remove-Item -LiteralPath $tunnelOut, $tunnelErr -Force -ErrorAction SilentlyContinue
    $TunnelProcess = Start-Process -FilePath $cloudflaredPath `
      -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8788') `
      -WorkingDirectory $DemoRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr

    $tunnelDeadline = (Get-Date).AddSeconds($TunnelWaitSeconds)
    $tunnelUrl = $null
    while ((Get-Date) -lt $tunnelDeadline) {
      Start-Sleep -Seconds 1
      if ($TunnelProcess.HasExited) { break }
      $logText = ''
      foreach ($logFile in @($tunnelOut, $tunnelErr)) {
        if (Test-Path -LiteralPath $logFile) {
          try { $logText += [System.IO.File]::ReadAllText($logFile) + "`n" } catch { }
        }
      }
      $match = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com', 'IgnoreCase')
      if ($match.Success) { $tunnelUrl = $match.Value.TrimEnd('/'); break }
    }
    if (-not $tunnelUrl) {
      $detail = ''
      foreach ($logFile in @($tunnelOut, $tunnelErr)) {
        if (Test-Path -LiteralPath $logFile) {
          try { $detail += [System.IO.File]::ReadAllText($logFile) } catch { }
        }
      }
      throw "Cloudflare Quick Tunnel did not provide a URL within $TunnelWaitSeconds seconds. Check Internet access/cloudflared. Log: $detail"
    }

    $env:PUBLIC_H5_BASE_URL = $page.AbsoluteUri
    if (-not $env:PUBLIC_H5_BASE_URL.EndsWith('/')) { $env:PUBLIC_H5_BASE_URL += '/' }
    $env:PUBLIC_API_BASE_URL = $tunnelUrl
    $env:HOST = '127.0.0.1'
    $env:PUBLIC_BASE_URL = 'http://127.0.0.1:8787'
    Write-Host "GitHub Pages H5: $($env:PUBLIC_H5_BASE_URL)" -ForegroundColor Green
    Write-Host "Temporary API tunnel: $tunnelUrl" -ForegroundColor Yellow
    Write-Host 'The Gateway (18789) and app (8787) remain loopback-only; only the filtered API proxy uses the tunnel.' -ForegroundColor DarkGray
  }

  Write-Host "Starting ClawBot from $DemoRoot in this window ..." -ForegroundColor Cyan
  $gatewayHealth = Get-GatewayHealth
  if (-not $gatewayHealth -or $gatewayHealth.status -ne 'live') {
    throw 'OpenClaw Gateway stopped before ClawBot startup. Inspect the Gateway window and rerun this launcher.'
  }
  $botArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $BotLauncher + '"'))
  & $PowerShellPath @botArgs
  if ($LASTEXITCODE -ne 0) { throw "ClawBot launcher exited with code $LASTEXITCODE." }
} finally {
  foreach ($process in @($TunnelProcess, $ProxyProcess)) {
    if ($process -and -not $process.HasExited) {
      try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
}
