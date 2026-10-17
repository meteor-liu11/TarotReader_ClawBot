param(
  [switch]$SkipSkillSync
)

$ErrorActionPreference = 'Stop'

$DemoRoot = Split-Path -Parent $PSScriptRoot
$OpenClawRoot = 'D:\law\OpenClaw'
$OpenClawHome = Join-Path $OpenClawRoot 'state'
$ConfigPath = Join-Path $OpenClawHome '.openclaw\openclaw.json'
$OpenClawEntry = Join-Path $OpenClawRoot 'node_modules\openclaw\openclaw.mjs'
$NodePath = 'D:\node.exe'
$SkillRoot = Join-Path $DemoRoot 'agent'
$PluginRoot = Join-Path $SkillRoot 'inbound-guard'

if (-not (Test-Path -LiteralPath $NodePath)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { $NodePath = $node.Source }
  else { throw 'Node.js not found. Ensure D:\node.exe or node is available.' }
}
if (-not (Test-Path -LiteralPath $OpenClawEntry)) {
  throw "OpenClaw CLI entry not found: $OpenClawEntry"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "OpenClaw config not found: $ConfigPath"
}
if (-not (Test-Path -LiteralPath $PluginRoot)) {
  throw "Inbound guard source not found: $PluginRoot"
}

$env:OPENCLAW_HOME = $OpenClawHome
Set-Location $OpenClawRoot

# Preserve the existing hook token and every existing agent allowlist entry.
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$hooks = $config.hooks
if ($null -eq $hooks -or [string]::IsNullOrWhiteSpace([string]$hooks.token)) {
  throw 'OpenClaw hooks.token is missing. No token value was read to the console.'
}

$agentIds = @()
if ($null -ne $hooks.allowedAgentIds) {
  foreach ($agentId in @($hooks.allowedAgentIds)) {
    if ($agentId -is [string] -and -not [string]::IsNullOrWhiteSpace($agentId)) {
      if ($agentIds -notcontains $agentId) { $agentIds += $agentId }
    }
  }
}

$hooksPatch = [ordered]@{ hooks = [ordered]@{} }
if ($hooks.enabled -ne $true) {
  $hooksPatch.hooks['enabled'] = $true
}

if ($agentIds -notcontains 'tarot') {
  $agentIds += 'tarot'
  $hooksPatch.hooks['allowedAgentIds'] = [string[]]$agentIds
}

if ($hooksPatch.hooks.Count -gt 0) {
  $WorkRoot = Join-Path $DemoRoot '.work'
  if (-not (Test-Path -LiteralPath $WorkRoot)) {
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
  }
  $HooksPatchPath = Join-Path $WorkRoot 'openclaw-hooks.patch.json5'
  $patchText = ConvertTo-Json -InputObject $hooksPatch -Depth 8
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($HooksPatchPath, $patchText, $utf8NoBom)
  Write-Host 'Applying OpenClaw HTTP Hooks configuration patch ...' -ForegroundColor Cyan
  & $NodePath $OpenClawEntry config patch --file $HooksPatchPath
  if ($LASTEXITCODE -ne 0) { throw 'Could not apply the HTTP Hooks configuration patch.' }
} else {
  Write-Host 'OpenClaw HTTP Hooks are already enabled for tarot.' -ForegroundColor Green
}

if (-not $SkipSkillSync) {
  Write-Host 'Syncing the updated tarot skill to the tarot Agent ...' -ForegroundColor Cyan
  & $NodePath $OpenClawEntry skills install $SkillRoot --agent tarot --as tarot-divination --force
  if ($LASTEXITCODE -ne 0) { throw 'Skill synchronization failed.' }
}

$pluginStatus = ''
$inspectOutput = & $NodePath $OpenClawEntry plugins inspect tarot-inbound-guard --json 2>$null
$inspectExit = $LASTEXITCODE
if ($inspectExit -eq 0) {
  $inspectText = ($inspectOutput | Out-String).Trim()
  try {
    $pluginReport = $inspectText | ConvertFrom-Json
    if ($null -ne $pluginReport.status) { $pluginStatus = [string]$pluginReport.status }
    elseif ($null -ne $pluginReport.plugin -and $null -ne $pluginReport.plugin.status) {
      $pluginStatus = [string]$pluginReport.plugin.status
    }
  } catch {
    throw 'OpenClaw returned an unreadable plugin inspection report; no plugin state was changed.'
  }
}

$needsEnable = $false
if ($inspectExit -ne 0 -or $pluginStatus -in @('missing', 'not-installed', 'not_found')) {
  Write-Host 'Installing the reviewed local inbound guard from E: ...' -ForegroundColor Cyan
  Write-Host 'OpenClaw may request capability consent. Review its prompt; this script does not auto-approve it.' -ForegroundColor Yellow
  & $NodePath $OpenClawEntry plugins install --link $PluginRoot --force
  if ($LASTEXITCODE -ne 0) { throw 'Plugin installation did not complete. If consent was declined, no guard was enabled.' }
  $needsEnable = $true
} elseif ($pluginStatus -eq 'disabled') {
  $needsEnable = $true
} elseif ($pluginStatus -in @('enabled', 'loaded')) {
  Write-Host 'Inbound guard is already enabled; skipping reinstall.' -ForegroundColor Green
} else {
  throw "Unexpected inbound guard status '$pluginStatus'. Run plugins inspect tarot-inbound-guard --json and review the result."
}

if ($needsEnable) {
  Write-Host 'Enabling tarot-inbound-guard ...' -ForegroundColor Cyan
  & $NodePath $OpenClawEntry plugins enable tarot-inbound-guard
  if ($LASTEXITCODE -ne 0) { throw 'Plugin enablement failed. Review any OpenClaw capability or policy prompt.' }
}

Write-Host ''
Write-Host 'HTTP Hooks are enabled for tarot and the inbound guard is configured.' -ForegroundColor Green
Write-Host 'Verify the running Gateway registration with: openclaw plugins inspect tarot-inbound-guard --runtime --json' -ForegroundColor DarkGray
Write-Host 'The startup launcher performs this preflight before starting ClawBot.' -ForegroundColor DarkGray
