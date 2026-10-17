$ErrorActionPreference = 'Stop'

$OpenClawRoot = 'D:\law\OpenClaw'
$OpenClawHome = Join-Path $OpenClawRoot 'state'
$OpenClawEntry = Join-Path $OpenClawRoot 'node_modules\openclaw\openclaw.mjs'
$NodePath = 'D:\node.exe'

if (-not (Test-Path -LiteralPath $NodePath)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { $NodePath = $node.Source }
  else { throw 'Node.js not found. Ensure D:\node.exe or node is available.' }
}
if (-not (Test-Path -LiteralPath $OpenClawEntry)) {
  throw "OpenClaw CLI entry not found: $OpenClawEntry"
}
if (-not (Test-Path -LiteralPath $OpenClawHome)) {
  throw "OpenClaw state directory not found: $OpenClawHome"
}

Set-Location $OpenClawRoot
$env:OPENCLAW_HOME = $OpenClawHome
Write-Host 'Starting OpenClaw Gateway from D:\law\OpenClaw ...' -ForegroundColor Cyan
Write-Host 'Keep this window open. Press Ctrl+C to stop the Gateway.' -ForegroundColor DarkGray

# --allow-unconfigured is required by this installation's existing local profile.
& $NodePath $OpenClawEntry gateway run --allow-unconfigured
exit $LASTEXITCODE
