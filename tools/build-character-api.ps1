[CmdletBinding()]
# -Runtime: win-x64 (default, the pinned lock), osx-arm64 / osx-x64 (macOS packages), linux-x64 (Unix tests in WSL only).
param([switch]$ReloadExtension, [ValidateSet('win-x64','osx-arm64','osx-x64','linux-x64')][string]$Runtime = 'win-x64')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$apiRoot = Split-Path -Parent $PSScriptRoot
$apiLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dotnet.lock.json') -Raw | ConvertFrom-Json
if ($ReloadExtension -and $Runtime -ne 'win-x64') { throw '-ReloadExtension replaces the installed Windows helper; use it only with win-x64.' }
$globalLock = Get-Content -LiteralPath (Join-Path $apiRoot 'global.json') -Raw | ConvertFrom-Json
if ($globalLock.sdk.version -cne $apiLock.sdkVersion -or $globalLock.sdk.rollForward -cne 'disable') { throw 'SDK locks disagree.' }
$dotnet = Join-Path $apiRoot ('.tools/dotnet/' + $apiLock.sdkVersion + '/dotnet.exe')
if (-not (Test-Path -LiteralPath $dotnet)) { throw 'Pinned SDK missing. Run tools/setup-character-api.ps1 for development.' }
$sdkEnvironment = @{
  DOTNET_CLI_HOME=(Join-Path $apiRoot '.tools/dotnet-home'); NUGET_PACKAGES=(Join-Path $apiRoot '.tools/nuget-packages')
  DOTNET_GENERATE_ASPNET_CERTIFICATE='false'; DOTNET_CLI_TELEMETRY_OPTOUT='1'; DOTNET_NOLOGO='1'; DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE='true'
}
$savedEnvironment = @{}
foreach ($name in $sdkEnvironment.Keys) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process'); [Environment]::SetEnvironmentVariable($name,$sdkEnvironment[$name],'Process') }
Push-Location $apiRoot
try {
  $version = & $dotnet --version
  if ($LASTEXITCODE -ne 0 -or $version.Trim() -cne $apiLock.sdkVersion) { throw 'Pinned SDK version mismatch.' }
  $destination = Join-Path $apiRoot ('dist/character-api/' + $Runtime)
  $cliDestination = Join-Path $apiRoot ('dist/character-api-cli/' + $Runtime)
  $suffix = if ($Runtime -like 'win-*') { '.exe' } else { '' }
  # Always publish to staging. A normal build never replaces a running helper.
  $stage = Join-Path $apiRoot ('dist/character-api-stage/' + $Runtime)
  & $dotnet publish backend/character-api -c Release -r $Runtime --self-contained true -p:PublishSingleFile=true -o $stage
  if ($LASTEXITCODE -ne 0) { throw 'Standalone API publish failed.' }
  $existing = Join-Path $destination ('CharacterBridge' + $suffix)
  if (@(Get-Process -Name CharacterBridge -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $existing }).Count) { throw 'Standalone API output is running; build remains in staging.' }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Get-ChildItem -LiteralPath $stage -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination $_.Name) -Force }
  & $dotnet publish backend/character-api-cli -c Release -r $Runtime --self-contained true -p:PublishSingleFile=true -o $cliDestination
  if ($LASTEXITCODE -ne 0) { throw 'Standalone CLI publish failed.' }
  if ($ReloadExtension) {
    . (Join-Path $PSScriptRoot 'installed-character-api.ps1')
    $registeredDestination = Get-InstalledCharacterApiDirectory
    & (Join-Path $PSScriptRoot 'reload-extension.ps1') -DelayMilliseconds 10000 -NoWait
    $registeredHelper = Join-Path $registeredDestination 'CharacterBridge.exe'
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    do {
      $running = @(Get-Process -Name CharacterBridge -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $registeredHelper })
      if (!$running.Count) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($running.Count) { throw 'Browser-owned helper did not exit; registered helper was not replaced.' }
    Get-ChildItem -LiteralPath $stage -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $registeredDestination $_.Name) -Force }
    & (Join-Path $PSScriptRoot 'reload-extension.ps1') -WaitOnly
  }
  Write-Host ('Published standalone GUI relay: ' + (Join-Path $destination ('CharacterBridge' + $suffix)))
  Write-Host ('Published standalone CLI: ' + (Join-Path $cliDestination ('character-api' + $suffix)))
} finally {
  Pop-Location
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
}
