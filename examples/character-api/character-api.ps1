<#
  .\character-api.ps1 GET /v1/character/summary
  .\character-api.ps1 POST /v1/character/hp/damage -BodyFile change.json
  A request is sent exactly once. Never automatically retry an unknown write.
#>
[CmdletBinding()]
param(
  [ValidateSet('GET','POST','PUT','PATCH','DELETE')][string]$Method = 'GET',
  [string]$Path = '/v1/status',
  [string]$BodyFile
)
$ErrorActionPreference = 'Stop'
try {
  # $IsMacOS exists only in PowerShell 6+ (Windows PowerShell 5.1 under Set-StrictMode would fail on it).
  $base = if ((Test-Path variable:IsMacOS) -and $IsMacOS) { Join-Path $HOME 'Library/Application Support' } else { $env:LOCALAPPDATA }
  $config = Get-Content -LiteralPath (Join-Path $base 'TabletopVR/character-bridge/v2/http.json') -Raw | ConvertFrom-Json
  $address = [Uri]$config.url
  if ($address.Scheme -cne 'http' -or $address.Host -cne '127.0.0.1' -or $address.UserInfo) { throw 'Invalid local API address.' }
  if (-not $Path.StartsWith('/v1/') -and $Path -cne '/openapi.json') { throw 'Use /v1/... or /openapi.json.' }
  $parameters = @{ Uri=($config.url + $Path); Method=$Method; Headers=@{Authorization=('Bearer ' + $config.token)}; TimeoutSec=75 }
  if ($BodyFile) {
    $body = Get-Content -LiteralPath $BodyFile -Raw
    $null = $body | ConvertFrom-Json
    $parameters.ContentType = 'application/json'
    $parameters.Body = $body
  }
  Invoke-RestMethod @parameters | ConvertTo-Json -Depth 100
} catch {
  $failure = @{error='api_unavailable'}
  if ($Method -cne 'GET') { $failure.state='unknown'; $failure.reason='Do not retry automatically; read current state first.' }
  $failure | ConvertTo-Json
  exit 1
}
