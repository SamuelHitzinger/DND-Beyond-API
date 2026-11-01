[CmdletBinding()]
param([switch]$WaitOnly, [switch]$NoWait, [ValidateRange(0,20000)][int]$DelayMilliseconds = 300, [int]$TimeoutSeconds = 40)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$discovery = Join-Path $env:LOCALAPPDATA 'TabletopVR/character-bridge/v2/http.json'
$initial = Get-Content -LiteralPath $discovery -Raw | ConvertFrom-Json
if (!$WaitOnly) {
  # Send exactly once; only connection/status reads are retried below.
  $reply = Invoke-RestMethod -Method Post -Uri ($initial.url + '/dev/reload-extension') -Headers @{Authorization=('Bearer ' + $initial.token)} -ContentType application/json -Body (@{delayMs=$DelayMilliseconds} | ConvertTo-Json -Compress) -TimeoutSec 10
  if ($reply.state -cne 'reloading') { throw 'Extension did not acknowledge reload.' }
}
if ($NoWait) { return }
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
  try {
    $current = Get-Content -LiteralPath $discovery -Raw | ConvertFrom-Json
    if ($WaitOnly -or $current.url -cne $initial.url) {
      $status = Invoke-RestMethod -Uri ($current.url + '/v1/status') -Headers @{Authorization=('Bearer ' + $current.token)} -TimeoutSec 2
      if ($status.browser -ceq 'connected') { Write-Host 'PASS extension reconnected; HTTP API ready.'; return }
    }
  } catch { }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Extension did not reconnect before the timeout. No reload or character write was retried.'
