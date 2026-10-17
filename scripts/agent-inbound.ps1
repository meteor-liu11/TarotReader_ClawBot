param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PeerId,

  [string]$Text = '',

  [string]$AccountId = '',

  [switch]$ApplyWaitlist
)

$ErrorActionPreference = 'Stop'
$BaseUrl = 'http://127.0.0.1:8787'

try {
  $health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health" -TimeoutSec 4
  if (-not $health.ok -or $health.cards -ne 78 -or $health.agentApplications -ne 2) {
    throw 'ClawBot health check failed.'
  }

  if ($ApplyWaitlist) {
    $payload = @{ peerId = $PeerId; channel = 'openclaw-weixin' }
    if (-not [string]::IsNullOrWhiteSpace($AccountId)) { $payload.accountId = $AccountId }
    $json = $payload | ConvertTo-Json -Depth 8 -Compress
    $result = Invoke-RestMethod -Method Post `
      -Uri "$BaseUrl/api/agent/apply" `
      -ContentType 'application/json; charset=utf-8' `
      -Body $json `
      -TimeoutSec 10
    if ($null -eq $result -or $result.ok -ne $true -or $result.status -ne 'approved' -or $result.allowlisted -ne $true -or
        [string]::IsNullOrWhiteSpace([string]$result.reply)) {
      throw 'Waitlist application was not confirmed by the server.'
    }
    [ordered]@{ ok = $result.ok; status = $result.status; reply = $result.reply } |
      ConvertTo-Json -Depth 6 -Compress
    return
  }

  if ([string]::IsNullOrWhiteSpace($Text)) { throw 'Text is required unless -ApplyWaitlist is used.' }

  $payload = @{
    text = $Text
    peerId = $PeerId
    channel = 'openclaw-weixin'
  }
  if (-not [string]::IsNullOrWhiteSpace($AccountId)) {
    $payload.accountId = $AccountId
  }

  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  $result = Invoke-RestMethod -Method Post `
    -Uri "$BaseUrl/api/agent/inbound" `
    -ContentType 'application/json; charset=utf-8' `
    -Body $json `
    -TimeoutSec 10

  if ($null -eq $result) { throw 'Inbound API returned an empty response.' }
  if ($result.allowed -eq $true -and $result.intent -eq 'divination') {
    if ([string]::IsNullOrWhiteSpace([string]$result.link)) {
      throw 'Divination response did not contain the server-issued link.'
    }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$result.link, [UriKind]::Absolute, [ref]$uri)) {
      throw 'Server-issued link is not an absolute URL.'
    }
    if ($uri.AbsolutePath -notmatch '^/s/[^/]+$') {
      throw 'Server-issued link does not point to a ClawBot session.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$result.reply) -or
        -not ([string]$result.reply).Contains([string]$result.link)) {
      throw 'Server reply does not contain its session link.'
    }
  }

  [ordered]@{
    allowed = $result.allowed
    intent = $result.intent
    link = $result.link
    reply = $result.reply
    spreadId = $result.spreadId
  } | ConvertTo-Json -Depth 6 -Compress
} catch {
  $errorType = $_.Exception.GetType().Name
  Write-Error "Agent service call failed ($errorType). Do not claim an application, draw, or link succeeded."
  exit 1
}
