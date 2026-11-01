[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$testRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $testRoot 'tools/installed-character-api.ps1')
$sandbox=Join-Path $testRoot ('artifacts/installed api lookup ' + [guid]::NewGuid().ToString('N'))
$installed=Join-Path $sandbox 'API installed with spaces'
New-Item -ItemType Directory -Path $installed -Force | Out-Null
$helper=Join-Path $installed 'CharacterBridge.exe'
[IO.File]::WriteAllText($helper,'lookup fixture only')
$manifestPath=Join-Path $installed 'com.tabletopvr.character_bridge.json'
$manifest=[ordered]@{name='com.tabletopvr.character_bridge';type='stdio';path=$helper;allowed_origins=@('chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/')}
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath
if ((Get-InstalledCharacterApiDirectory -ManifestPath $manifestPath) -cne $installed) { throw 'Installed API directory was not used.' }
foreach ($invalid in @('origin','outside','missing')) {
  $changed=@{}+$manifest
  if($invalid -eq 'origin'){$changed.allowed_origins=@('chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/')}
  if($invalid -eq 'outside'){$changed.path=Join-Path $sandbox 'CharacterBridge.exe'}
  if($invalid -eq 'missing'){$changed.path=Join-Path $installed 'Missing.exe'}
  $changed | ConvertTo-Json | Set-Content -LiteralPath $manifestPath
  $refused=$false
  try{Get-InstalledCharacterApiDirectory -ManifestPath $manifestPath | Out-Null}catch{$refused=$true}
  if(-not $refused){throw ('Invalid installed host accepted: '+$invalid)}
}
Write-Host 'PASS installed API lookup: permanent folder with spaces; no source-tree fallback; invalid hosts refused.'
