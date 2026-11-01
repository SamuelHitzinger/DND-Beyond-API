[CmdletBinding()]
param([ValidateSet('all','cli')][string]$Suite='all')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$apiRoot = Split-Path -Parent $PSScriptRoot
$apiLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dotnet.lock.json') -Raw | ConvertFrom-Json
& (Join-Path $PSScriptRoot 'build-character-api.ps1')
$dotnet = Join-Path $apiRoot ('.tools/dotnet/' + $apiLock.sdkVersion + '/dotnet.exe')
$values = @{
  DOTNET_CLI_HOME=(Join-Path $apiRoot '.tools/dotnet-home'); NUGET_PACKAGES=(Join-Path $apiRoot '.tools/nuget-packages')
  DOTNET_CLI_TELEMETRY_OPTOUT='1'; DOTNET_NOLOGO='1'; DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
  CHARACTER_API_TEST_EXECUTABLE=(Join-Path $apiRoot ('dist/character-api/' + $apiLock.rid + '/CharacterBridge.exe'))
  CHARACTER_API_TEST_CLI=(Join-Path $apiRoot ('dist/character-api-cli/' + $apiLock.rid + '/character-api.exe'))
}
$saved = @{}
foreach ($name in $values.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process'); [Environment]::SetEnvironmentVariable($name,$values[$name],'Process') }
Push-Location $apiRoot
try {
  & $dotnet run --project backend/character-api.tests -c Release -- $Suite
  if ($LASTEXITCODE -ne 0) { throw 'Standalone API tests failed.' }
  if ($Suite -eq 'all') { & (Join-Path $apiRoot 'tests/character_api_package_test.ps1') -InstallerOnly }
  if ($Suite -eq 'all') { & (Join-Path $apiRoot 'tests/installed_api_test.ps1') }
} finally {
  Pop-Location
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
