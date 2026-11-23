[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackageDirectory, [Parameter(Mandatory=$true)][ValidateSet('osx-arm64','osx-x64')][string]$Runtime)
# Content checks for a macOS package, run on Windows before zipping. The installer and the Unix code paths of the
# helper are exercised separately in WSL by tests/macos_installer_test.sh; nothing here runs on an actual Mac.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw ('FAIL ' + $message) } }
$required = @('CharacterBridge','character-api','Install.command','Uninstall.command','setup.sh','README.md','docs/character-extension.md','docs/character-http-api.md','docs/character-share.md','docs/character-http-api.openapi.json','protocol/extension-identity.json','licenses/runtime/dotnet-10.0.14/LICENSE.TXT','licenses/runtime/dotnet-10.0.14/THIRD-PARTY-NOTICES.TXT')
foreach ($name in $required) { Assert (Test-Path -LiteralPath (Join-Path $PackageDirectory $name) -PathType Leaf) ('required package file ' + $name) }
foreach ($name in @('CharacterBridge.exe','character-api.exe','Install.cmd','Install.ps1','registration.ps1')) { Assert (-not (Test-Path -LiteralPath (Join-Path $PackageDirectory $name))) ('no Windows file ' + $name) }
# 64-bit Mach-O for the right CPU, with a code signature load command (Apple silicon refuses unsigned programs).
$cpu = @{ 'osx-arm64' = 0x0100000c; 'osx-x64' = 0x01000007 }[$Runtime]
foreach ($name in @('CharacterBridge','character-api')) {
  $reader = New-Object IO.BinaryReader([IO.File]::OpenRead((Join-Path $PackageDirectory $name)))
  try {
    Assert ($reader.ReadUInt32() -eq [uint32]4277009103) ('64-bit Mach-O ' + $name)   # 0xfeedfacf (a bare hex literal is a negative Int32)
    Assert ($reader.ReadInt32() -eq $cpu) ('CPU type ' + $Runtime + ' ' + $name)
    $reader.ReadInt32() | Out-Null; $reader.ReadUInt32() | Out-Null
    $commands = $reader.ReadUInt32(); $reader.ReadUInt32() | Out-Null; $reader.ReadUInt32() | Out-Null; $reader.ReadUInt32() | Out-Null
    $signed = $false
    for ($i = 0; $i -lt $commands; $i++) {
      $start = $reader.BaseStream.Position; $command = $reader.ReadUInt32(); $size = $reader.ReadUInt32()
      if ($command -eq 0x1d) { $signed = $true }
      $reader.BaseStream.Position = $start + $size
    }
    Assert $signed ('code signature present ' + $name)
  } finally { $reader.Dispose() }
}
foreach ($name in @('Install.command','Uninstall.command','setup.sh')) {
  $bytes = [IO.File]::ReadAllBytes((Join-Path $PackageDirectory $name))
  Assert ($bytes -notcontains 13) ('LF line endings ' + $name)
  Assert ([Text.Encoding]::ASCII.GetString($bytes, 0, 11) -ceq '#!/bin/bash') ('bash script ' + $name)
}
$extension = Join-Path $PackageDirectory 'extensions/dndbeyond'
$allowed = @('manifest.json','background.js','identity.js','local-api.js','http-read.js','account-characters.js','web-share.js','share-sheet.js','share-relay.js','share-apply.js','script-api.js','sheet-api.js','script-rolls.js','character-summary.js','ui/picker.html','ui/picker.js','ui/picker.css','ui/picker-client.js','ui/setup.html','ui/setup.js','ui/share.html','ui/share.js','ui/shared-sites.js')
$actual = @(Get-ChildItem -LiteralPath $extension -Recurse -File | ForEach-Object { $_.FullName.Substring($extension.Length+1).Replace('\','/') })
Assert (@(Compare-Object $allowed $actual).Count -eq 0) 'extension contains exactly the runtime files'
foreach ($file in @(Get-ChildItem -LiteralPath $PackageDirectory -Recurse -File -Force)) {
  Assert ($file.Name -notin @('http.json','root.json','clients.json','journal.json','.character-bridge-registration.json')) 'no private artifacts'
  Assert ($file.Extension -notin @('.pdb','.dmp','.log','.cs','.dll','.exe')) 'no dev or Windows artifacts'
  if ($file.Extension -in @('.json','.js','.html','.css','.md','.py','.ps1','.sh','.command','.txt')) {
    Assert ([IO.File]::ReadAllText($file.FullName).Replace('\','/').IndexOf($repo.Replace('\','/'),[StringComparison]::OrdinalIgnoreCase) -lt 0) 'no developer workspace paths in public package text'
  }
}
Write-Host ('PASS macOS package contents (' + $Runtime + '): Mach-O CPU and signature, LF installers, exact extension files, no private or Windows files.')
