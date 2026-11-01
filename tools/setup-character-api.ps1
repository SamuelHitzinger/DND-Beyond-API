[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dotnet.lock.json') -Raw | ConvertFrom-Json
$globalLock = Get-Content -LiteralPath (Join-Path $bridgeRoot 'global.json') -Raw | ConvertFrom-Json
if ($globalLock.sdk.version -cne $bridgeLock.sdkVersion -or $globalLock.sdk.rollForward -cne 'disable') {
  throw 'global.json does not match the bridge SDK lock.'
}
$cache = Join-Path $bridgeRoot '.tools/downloads'
$sdkDirectory = Join-Path $bridgeRoot ('.tools/dotnet/' + $bridgeLock.sdkVersion)
$archive = Join-Path $cache ('dotnet-sdk-' + $bridgeLock.sdkVersion + '-' + $bridgeLock.rid + '.zip')
New-Item -ItemType Directory -Path $cache -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
  $partial = $archive + '.partial'
  Write-Host ('Downloading locked .NET SDK ' + $bridgeLock.sdkVersion)
  Invoke-WebRequest -UseBasicParsing -Uri $bridgeLock.sdkUrl -OutFile $partial
  if ((Get-FileHash -LiteralPath $partial -Algorithm SHA512).Hash -ine $bridgeLock.sdkSha512) {
    throw 'SDK SHA512 mismatch; the download was not extracted.'
  }
  Move-Item -LiteralPath $partial -Destination $archive -Force
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash -ine $bridgeLock.sdkSha512) {
  throw 'Cached SDK SHA512 mismatch; the archive was not extracted.'
}
$installStamp = Join-Path $sdkDirectory '.bridge-sdk-sha512'
if (Test-Path -LiteralPath $installStamp) {
  if ((Get-Content -LiteralPath $installStamp -Raw).Trim() -ine $bridgeLock.sdkSha512) {
    throw 'Installed SDK stamp does not match the archive lock.'
  }
} else {
  # A completion stamp is written only after extraction and version checks.
  # Do not overwrite a completed SDK: its compiler server may hold DLLs open.
  New-Item -ItemType Directory -Path $sdkDirectory -Force | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $sdkDirectory -Force
}
$dotnet = Join-Path $sdkDirectory 'dotnet.exe'
$sdkEnvironment = @{
  DOTNET_CLI_HOME = (Join-Path $bridgeRoot '.tools/dotnet-home')
  NUGET_PACKAGES = (Join-Path $bridgeRoot '.tools/nuget-packages')
  DOTNET_NOLOGO = '1'
  DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
  DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE = 'true'
}
$savedEnvironment = @{}
foreach ($name in $sdkEnvironment.Keys) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $sdkEnvironment[$name], 'Process')
}
Push-Location $bridgeRoot
try {
  $version = & $dotnet --version
  if ($LASTEXITCODE -ne 0 -or $version -cne $bridgeLock.sdkVersion) { throw 'Installed SDK version mismatch.' }
  $runtimes = & $dotnet --list-runtimes
  if ($LASTEXITCODE -ne 0 -or -not ($runtimes -match ('^Microsoft.NETCore.App ' + [regex]::Escape($bridgeLock.runtimeVersion) + ' '))) {
    throw 'Locked runtime is missing from the SDK archive.'
  }
} finally {
  Pop-Location
  foreach ($name in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
}
Set-Content -LiteralPath $installStamp -Value $bridgeLock.sdkSha512 -Encoding ASCII
Write-Host ('Verified SDK ' + $version + ', runtime ' + $bridgeLock.runtimeVersion + '. Use ' + $dotnet)
