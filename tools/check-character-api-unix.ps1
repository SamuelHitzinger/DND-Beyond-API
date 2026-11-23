[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$MacPackageZip, [string]$Distribution = 'Ubuntu')
# Unix checks without a Mac, in WSL: builds linux-x64 helper, CLI and test runner from the same source, then runs
#  1. the helper test suite (native relay, HTTP, owner-only http.json, the published helper started with the origin
#     argument only, as Chrome does on macOS, and the CLI), and
#  2. tests/macos_installer_test.sh on the given macOS package zip (its macOS binaries swapped for the Linux builds).
# Not covered: Gatekeeper, codesign, Chrome or Brave on a real Mac (see .github/workflows/macos.yml).
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$apiRoot = Split-Path -Parent $PSScriptRoot
$apiLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dotnet.lock.json') -Raw | ConvertFrom-Json
$MacPackageZip = (Resolve-Path -LiteralPath $MacPackageZip).Path
& (Join-Path $PSScriptRoot 'build-character-api.ps1') -Runtime linux-x64
$dotnet = Join-Path $apiRoot ('.tools/dotnet/' + $apiLock.sdkVersion + '/dotnet.exe')
$values = @{ DOTNET_CLI_HOME=(Join-Path $apiRoot '.tools/dotnet-home'); NUGET_PACKAGES=(Join-Path $apiRoot '.tools/nuget-packages'); DOTNET_CLI_TELEMETRY_OPTOUT='1'; DOTNET_NOLOGO='1' }
$saved = @{}
foreach ($name in $values.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process'); [Environment]::SetEnvironmentVariable($name,$values[$name],'Process') }
Push-Location $apiRoot
try {
  & $dotnet publish backend/character-api.tests -c Release -r linux-x64 --self-contained true -o dist/character-api-tests/linux-x64
  if ($LASTEXITCODE -ne 0) { throw 'Test runner publish failed.' }
} finally {
  Pop-Location
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
function ConvertTo-WslPath([string]$path) { $full = [IO.Path]::GetFullPath($path); return '/mnt/' + $full.Substring(0,1).ToLowerInvariant() + $full.Substring(2).Replace('\','/') }
# Copied into the Linux file system: /mnt/c does not keep Unix permissions, which these tests check.
$script = @'
set -euo pipefail
R=$(mktemp -d /tmp/character-api-unix.XXXXXX); trap 'rm -rf "$R"' EXIT
cp -r "$1/dist/character-api-tests/linux-x64" "$R/tests"
cp "$1/dist/character-api/linux-x64/CharacterBridge" "$1/dist/character-api-cli/linux-x64/character-api" "$1/tests/macos_installer_test.sh" "$R/"
cp "$2" "$R/package.zip"
chmod +x "$R/CharacterBridge" "$R/character-api" "$R/tests/CharacterApi.Tests"
CHARACTER_API_TEST_EXECUTABLE="$R/CharacterBridge" CHARACTER_API_TEST_CLI="$R/character-api" "$R/tests/CharacterApi.Tests"
bash "$R/macos_installer_test.sh" "$R/package.zip" "$R/CharacterBridge" "$R/character-api"
'@
$scriptFile = Join-Path ([IO.Path]::GetTempPath()) ('character-api-unix-' + [guid]::NewGuid().ToString('N') + '.sh')
[IO.File]::WriteAllText($scriptFile, $script.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
try {
  & wsl.exe -d $Distribution -- bash (ConvertTo-WslPath $scriptFile) (ConvertTo-WslPath $apiRoot) (ConvertTo-WslPath $MacPackageZip)
  if ($LASTEXITCODE -ne 0) { throw 'Unix checks failed.' }
} finally { Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue }
