[CmdletBinding()]
param([string]$OutputDirectory, [string]$ZipPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$apiRoot = Split-Path -Parent $PSScriptRoot
$apiLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dotnet.lock.json') -Raw | ConvertFrom-Json
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $apiRoot ('dist/packages/character-api-windows-x64-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ((Test-Path -LiteralPath $OutputDirectory) -and @(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count) { throw 'Use a new or empty output directory; packages never merge with existing files.' }
if (-not $ZipPath) { $ZipPath = $OutputDirectory + '.zip' }
$ZipPath = [IO.Path]::GetFullPath($ZipPath)
if (Test-Path -LiteralPath $ZipPath) { throw 'ZIP already exists; choose a new output path.' }
& node (Join-Path $PSScriptRoot 'build-extension.js') --check
if ($LASTEXITCODE -ne 0) { throw 'Extension runtime or identity validation failed.' }
$copies = [ordered]@{
  ('dist/character-api/' + $apiLock.rid + '/CharacterBridge.exe')='CharacterBridge.exe'
  ('dist/character-api-cli/' + $apiLock.rid + '/character-api.exe')='character-api.exe'
  'docs/character-api-package.md'='README.md'
  'docs/character-extension.md'='docs/character-extension.md'
  'docs/character-http-api.md'='docs/character-http-api.md'
  'docs/character-share.md'='docs/character-share.md'
  'docs/character-http-api.openapi.json'='docs/character-http-api.openapi.json'
  'protocol/extension-identity.json'='protocol/extension-identity.json'
}
foreach ($name in @('Install.cmd','Install.ps1','Uninstall.cmd','Uninstall.ps1','registration.ps1')) { $copies['tools/character-api-install/' + $name]=$name }
foreach ($name in @('manifest.json','background.js','identity.js','local-api.js','http-read.js','account-characters.js','web-share.js','share-sheet.js','share-relay.js','share-apply.js','script-api.js','sheet-api.js','script-rolls.js','character-summary.js','ui/picker.html','ui/picker.js','ui/picker.css','ui/picker-client.js','ui/setup.html','ui/setup.js','ui/share.html','ui/share.js','ui/shared-sites.js')) { $copies['extensions/dndbeyond/' + $name]='extensions/dndbeyond/' + $name }
foreach ($name in @('LICENSE.TXT','THIRD-PARTY-NOTICES.TXT')) { $relative='licenses/runtime/dotnet-' + $apiLock.runtimeVersion + '/' + $name; $copies[$relative]=$relative }
# Only public, checked-in script examples. Never recurse over arbitrary captures.
foreach ($name in @('character-api.ps1','character_api.py')) { $copies['examples/character-api/' + $name]='examples/' + $name }
foreach ($source in $copies.Keys) {
  if (-not (Test-Path -LiteralPath (Join-Path $apiRoot $source) -PathType Leaf)) { throw ('Required public package input missing: ' + $source) }
}
foreach ($source in $copies.Keys) {
  $destination = Join-Path $OutputDirectory $copies[$source]
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $apiRoot $source) -Destination $destination
}
& (Join-Path $apiRoot 'tests/character_api_package_test.ps1') -PackageDirectory $OutputDirectory
New-Item -ItemType Directory -Path (Split-Path -Parent $ZipPath) -Force | Out-Null
Compress-Archive -Path (Join-Path $OutputDirectory '*') -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Host ('Standalone package: ' + $OutputDirectory)
Write-Host ('Distributable ZIP: ' + $ZipPath)
