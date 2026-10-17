param(
  [switch]$Lan,
  [string]$PublicBaseUrl
)

$ErrorActionPreference = 'Stop'
$DemoRoot = Split-Path -Parent $PSScriptRoot
$OpenClawHome = 'D:\law\OpenClaw\state'
$EnvPath = Join-Path $DemoRoot '.env'

Set-Location $DemoRoot
$env:OPENCLAW_HOME = $OpenClawHome

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node -and (Test-Path -LiteralPath 'D:\node.exe')) {
  $NodePath = 'D:\node.exe'
} elseif ($Node) {
  $NodePath = $Node.Source
} else {
  throw 'Node.js not found. Ensure D:\node.exe or node is available.'
}

# Rebuild the live project environment from the configured OpenClaw state when needed.
# The Hooks token is never printed.
$needsEnv = $true
if (Test-Path -LiteralPath $EnvPath) {
  $envText = Get-Content -LiteralPath $EnvPath -Raw
  $isLive = [regex]::IsMatch($envText, '(?m)^GATEWAY_MODE=live\s*$')
  $hasHook = [regex]::IsMatch($envText, '(?m)^HOOK_TOKEN=(?!replace-with-your-hooks-token\s*$)[^\r\n#]+\s*$')
  $needsEnv = -not ($isLive -and $hasHook)
  $envText = $null
}
if ($needsEnv) {
  Write-Host 'Generating live ClawBot environment (secrets will not be shown)...' -ForegroundColor Yellow
  & $NodePath '.\scripts\make-env.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'make-env.mjs failed; the service was not started.' }
}

if ($Lan -or $PublicBaseUrl) {
  $env:HOST = '0.0.0.0'
  if (-not $PublicBaseUrl) {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
      Sort-Object RouteMetric | Select-Object -First 1
    if (-not $route) { throw 'No default network route. Specify -PublicBaseUrl explicitly.' }
    $LanIp = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
      Select-Object -First 1 -ExpandProperty IPAddress
    if (-not $LanIp) { throw 'No usable LAN IPv4 address. Specify -PublicBaseUrl explicitly.' }
    $PublicBaseUrl = "http://${LanIp}:8787"
  }
  $env:PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd('/')
} else {
  $env:HOST = '127.0.0.1'
  $env:PUBLIC_BASE_URL = 'http://127.0.0.1:8787'
}
$env:PORT = '8787'

try {
  $gw = Invoke-RestMethod -Uri 'http://127.0.0.1:18789/health' -TimeoutSec 3
  if ($gw.status -ne 'live') { Write-Warning 'OpenClaw Gateway is not live; real WeChat features may be unavailable.' }
  else { Write-Host 'OpenClaw Gateway: live' -ForegroundColor Green }
} catch {
  Write-Warning 'OpenClaw Gateway is unreachable at 127.0.0.1:18789. The web app will start, but live WeChat features will be unavailable.'
}

$existing = $null
try { $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 } catch { }
if ($existing) {
  if ($existing.ok -and $existing.cards -eq 78) {
    if ($existing.agentClassify -ne 1 -or $existing.agentApplications -ne 2) {
      throw 'An older ClawBot instance is already running without the current classify/direct-access routes. Stop its PowerShell window with Ctrl+C, then rerun this launcher.'
    }
    if ($existing.gateway -ne 'live') {
      throw 'A non-live ClawBot instance is already running. Stop its old PowerShell window with Ctrl+C, then rerun this launcher.'
    }
    Write-Host "ClawBot is already running: $($env:PUBLIC_BASE_URL)" -ForegroundColor Green
    Write-Host 'A second service instance will not be started.'
    exit 0
  }
  throw 'Port 8787 is occupied by another service.'
}

Write-Host "Starting ClawBot: $($env:PUBLIC_BASE_URL)" -ForegroundColor Cyan
if ($Lan) {
  Write-Host 'LAN binding is enabled. Use only on a trusted network; check the Windows private-network firewall rule if phones cannot connect.' -ForegroundColor Yellow
}
Write-Host 'Keep this PowerShell window open. Press Ctrl+C to stop the service.' -ForegroundColor DarkGray
& $NodePath '.\src\server.mjs'
exit $LASTEXITCODE
