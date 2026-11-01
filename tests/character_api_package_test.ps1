[CmdletBinding()]
param([string]$PackageDirectory, [switch]$InstallerOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
function Assert($condition,[string]$message) { if (-not $condition) { throw ('FAIL: ' + $message) } }
function Refuses([scriptblock]$action,[string]$message) { $rejected=$false; try { & $action | Out-Null } catch { $rejected=$true }; Assert $rejected $message }
$sandbox = Join-Path $repo ('artifacts/character api package test ' + [guid]::NewGuid().ToString('N'))
$copy = Join-Path $sandbox 'Permanent folder with spaces'
New-Item -ItemType Directory -Path $copy -Force | Out-Null
$state = @{ Keys=@{}; Writes=0; FailAt=0 }
$adapter = @{
  Read={ param($path) if ($state.Keys.ContainsKey($path)) { return $state.Keys[$path] }; return $null }.GetNewClosure()
  Write={ param($path,$value) $state.Writes++; if ($state.Writes -eq $state.FailAt) { throw 'injected write failure' }; $state.Keys[$path]=$value }.GetNewClosure()
  Delete={ param($path) $state.Writes++; if ($state.Writes -eq $state.FailAt) { throw 'injected delete failure' }; $state.Keys.Remove($path) }.GetNewClosure()
}
try {
  if ($PackageDirectory) { Copy-Item -Path (Join-Path $PackageDirectory '*') -Destination $copy -Recurse }
  else {
    $assets = Join-Path $repo 'tools/character-api-install'
    Assert (Test-Path -LiteralPath (Join-Path $assets 'Install.ps1')) 'standalone installer is implemented'
    Copy-Item -Path (Join-Path $assets '*') -Destination $copy -Recurse
    New-Item -ItemType Directory -Path (Join-Path $copy 'protocol') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'protocol/extension-identity.json') -Destination (Join-Path $copy 'protocol/extension-identity.json')
    [IO.File]::WriteAllText((Join-Path $copy 'CharacterBridge.exe'),'isolated helper stand-in')
  }
  $install = Join-Path $copy 'Install.ps1'; $uninstall = Join-Path $copy 'Uninstall.ps1'
  $plan = & $install -DryRun -RegistryAdapter $adapter
  Assert ($state.Writes -eq 0 -and -not (Test-Path -LiteralPath $plan.ManifestPath)) 'dry-run has no mutations'
  Assert ($plan.InstallDirectory -ceq $copy) 'installer defaults to permanent package path with spaces'
  Assert ($plan.RegistryPaths.Count -eq 1 -and $plan.RegistryPaths[0] -ceq 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tabletopvr.character_bridge') 'Chrome and Brave share Chrome per-user registration'
  Assert ($plan.AllowedOrigins.Count -eq 1 -and $plan.AllowedOrigins[0] -ceq 'chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/') 'fixed exact origin'
  $manifest = $plan.ManifestJson | ConvertFrom-Json
  Assert ($manifest.path -ceq (Join-Path $copy 'CharacterBridge.exe')) 'adjacent self-contained GUI helper'
  $applied = & $install -RegistryAdapter $adapter
  Assert ([IO.File]::ReadAllText($plan.ManifestPath) -ceq $plan.ManifestJson) 'actual registration writes planned manifest'
  Assert ($state.Keys[$plan.RegistryPaths[0]].Default -ceq $plan.ManifestPath) 'in-memory registry points to portable path'
  & $install -RegistryAdapter $adapter | Out-Null
  $originalManifest = [IO.File]::ReadAllText($plan.ManifestPath)
  $modifiedManifest = $originalManifest | ConvertFrom-Json
  $modifiedManifest.allowed_origins = @('chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/')
  [IO.File]::WriteAllText($plan.ManifestPath,($modifiedManifest | ConvertTo-Json -Depth 8))
  Refuses { & $install -DryRun -RegistryAdapter $adapter } 'different manifest origin is still refused'
  $modifiedManifest.allowed_origins = 'chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/'
  [IO.File]::WriteAllText($plan.ManifestPath,($modifiedManifest | ConvertTo-Json -Depth 8))
  Refuses { & $install -DryRun -RegistryAdapter $adapter } 'manifest array cannot be replaced with a scalar'
  [IO.File]::WriteAllText($plan.ManifestPath,$originalManifest)
  $other = Join-Path $sandbox 'other copy'
  Copy-Item -LiteralPath $copy -Destination $other -Recurse
  Refuses { & (Join-Path $other 'Install.ps1') -RegistryAdapter $adapter } 'copied receipt cannot take over original'
  $owned = $state.Keys[$plan.RegistryPaths[0]]
  $state.Keys[$plan.RegistryPaths[0]] = [pscustomobject]@{ Default='C:\Other\host.json'; Owner='other'; ExtraValues=@(); SubKeys=@() }
  Refuses { & $install -RegistryAdapter $adapter } 'unowned registry is preserved'
  Refuses { & $uninstall -RegistryAdapter $adapter } 'unowned registry cannot be removed'
  $state.Keys[$plan.RegistryPaths[0]] = $owned
  [IO.File]::WriteAllText((Join-Path $copy 'keep.txt'),'unrelated user data')
  & $uninstall -RegistryAdapter $adapter | Out-Null
  Assert ($state.Keys.Count -eq 0 -and -not (Test-Path -LiteralPath $plan.ManifestPath)) 'owned registration and generated files removed'
  Assert ([IO.File]::ReadAllText((Join-Path $copy 'keep.txt')) -ceq 'unrelated user data') 'uninstall preserves extracted files and user data'
  $state.FailAt = $state.Writes + 1
  Refuses { & $install -RegistryAdapter $adapter } 'injected registry write failure'
  Assert ($state.Keys.Count -eq 0 -and -not (Test-Path -LiteralPath $plan.ManifestPath)) 'failed install rolls back files and registry'
  Write-Host 'PASS isolated installer plans, ownership, spaces, idempotence, uninstall and rollback (no real registry writes).'
  # Retain files written by the invoking PowerShell edition so the Windows 5.1
  # entrypoint also proves cross-edition repair/ownership checks, not just a
  # first installation with no receipt.
  $state.FailAt = 0
  & $install -RegistryAdapter $adapter | Out-Null
  # Exercise exactly the Windows PowerShell 5.1 -File entrypoint used by the
  # double-click launchers. In-process & invocation initializes parameter
  # defaults differently and previously missed an empty $PSScriptRoot default.
  # Replace only registry access in this isolated copy, keeping the actual
  # entrypoints, path validation and registration planner intact.
  Add-Content -LiteralPath (Join-Path $copy 'registration.ps1') -Value @'
function Get-BridgeRegistryAdapter {
  return @{ Read={param($path) return $null}; Write={throw 'Unexpected registry mutation'}; Delete={throw 'Unexpected registry mutation'} }
}
'@
  foreach ($entry in @('Install','Uninstall')) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $start.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $copy ($entry + '.ps1')) + '" -DryRun'
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $process = [Diagnostics.Process]::Start($start)
    try {
      $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
      Assert ($process.WaitForExit(10000)) ('Windows PowerShell -File exits: ' + $entry)
      Assert ($process.ExitCode -eq 0) ('Windows PowerShell -File default path: ' + $entry + '; ' + $stderr.Result)
      Assert ($stdout.Result.Contains('CharacterBridge.exe')) ('default path reaches real registration plan: ' + $entry)
    } finally { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
  }
  Write-Host 'PASS actual Windows PowerShell 5.1 -File install/uninstall entrypoints without explicit paths.'
  if ($InstallerOnly) { return }
  Assert ([bool]$PackageDirectory) 'PackageDirectory required for package validation'
  foreach ($name in @('CharacterBridge.exe','character-api.exe','Install.cmd','Uninstall.cmd','README.md','docs/character-extension.md','docs/character-http-api.md','docs/character-http-api.openapi.json','protocol/extension-identity.json','licenses/runtime/dotnet-10.0.14/LICENSE.TXT','licenses/runtime/dotnet-10.0.14/THIRD-PARTY-NOTICES.TXT')) { Assert (Test-Path -LiteralPath (Join-Path $PackageDirectory $name)) ('required package file ' + $name) }
  foreach ($executable in @(@('CharacterBridge.exe',2),@('character-api.exe',3))) {
    $binary=New-Object IO.BinaryReader([IO.File]::OpenRead((Join-Path $PackageDirectory $executable[0])))
    try {
      $binary.BaseStream.Position=0x3c; $peOffset=$binary.ReadInt32()
      $binary.BaseStream.Position=$peOffset+24+68
      Assert ($binary.ReadUInt16() -eq $executable[1]) ('PE subsystem GUI/console contract ' + $executable[0])
    } finally { $binary.Dispose() }
  }
  $extension = Join-Path $PackageDirectory 'extensions/dndbeyond'
  $allowed = @('manifest.json','background.js','identity.js','local-api.js','http-read.js','account-characters.js','script-api.js','sheet-api.js','script-rolls.js','character-summary.js','ui/picker.html','ui/picker.js','ui/picker.css','ui/picker-client.js','ui/setup.html','ui/setup.js')
  $actual = @(Get-ChildItem -LiteralPath $extension -Recurse -File | ForEach-Object { $_.FullName.Substring($extension.Length+1).Replace('\','/') })
  Assert (@(Compare-Object $allowed $actual).Count -eq 0) 'extension contains exactly standalone runtime files'
  foreach ($file in Get-ChildItem -LiteralPath $extension -Recurse -File) {
    $source = [IO.File]::ReadAllText($file.FullName)
    # Validate actual static module and HTML resource dependency closure.
    $patterns = @('(?:from\s*|import\s*)["''](\.[^"'']+)["'']','(?:src|href)=["''](\.[^"'']+|[^/:"'']+\.(?:js|css))["'']')
    foreach ($pattern in $patterns) { foreach ($match in [regex]::Matches($source,$pattern)) {
      $reference = ($match.Groups[1].Value -split '[?#]')[0]
      Assert (Test-Path -LiteralPath (Join-Path $file.DirectoryName $reference) -PathType Leaf) ('runtime dependency ' + $reference)
    } }
  }
  $manifest = Get-Content -LiteralPath (Join-Path $extension 'manifest.json') -Raw | ConvertFrom-Json
  Assert ($manifest.background.service_worker -ceq 'background.js') 'packaged worker entrypoint'
  Assert (-not ($manifest.PSObject.Properties.Name -contains 'content_scripts')) 'no legacy content script entrypoints'
  foreach ($reference in @($manifest.background.service_worker,$manifest.action.default_popup,$manifest.options_page)) { Assert (Test-Path -LiteralPath (Join-Path $extension $reference) -PathType Leaf) ('manifest resource ' + $reference) }
  $files = @(Get-ChildItem -LiteralPath $PackageDirectory -Recurse -File -Force)
  foreach ($file in $files) {
    Assert ($file.Name -notin @('http.json','root.json','clients.json','journal.json','project.godot','TabletopVR.exe','.character-bridge-registration.json','content.bundle.js')) 'no private artifacts or legacy game files'
    Assert ($file.Extension -notin @('.pdb','.pck','.dmp','.log','.cs')) 'no dev/game artifacts'
    if ($file.Extension -in @('.json','.js','.html','.css','.md','.py','.ps1','.cmd','.txt')) {
      $publicText=[IO.File]::ReadAllText($file.FullName).Replace('\','/')
      Assert ($publicText.IndexOf($repo.Replace('\','/'),[StringComparison]::OrdinalIgnoreCase) -lt 0) 'no developer workspace paths in public package text'
    }
  }
  # Run exactly the packaged EXEs with redirected LOCALAPPDATA and stdio. This
  # proves single-file runtime completeness without any installed SDK/runtime or
  # browser being used by the child executables, and touches no real user state.
  function Start-IsolatedExecutable([string]$name,[string]$arguments) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $PackageDirectory $name
    $start.Arguments = $arguments
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.EnvironmentVariables['LOCALAPPDATA'] = Join-Path $sandbox 'runtime local app data'
    # A child cannot accidentally resolve an installed SDK or shared runtime.
    $start.EnvironmentVariables['DOTNET_ROOT'] = Join-Path $sandbox 'no shared dotnet runtime'
    $start.EnvironmentVariables['DOTNET_BUNDLE_EXTRACT_BASE_DIR'] = Join-Path $sandbox 'runtime extraction'
    return [Diagnostics.Process]::Start($start)
  }
  function Read-NativeFrame($stream) {
    $header = New-Object byte[] 4
    $offset=0
    while ($offset -lt 4) {
      $task=$stream.ReadAsync($header,$offset,4-$offset)
      Assert ($task.Wait(10000)) 'native frame header before deadline'
      $count=$task.Result; Assert ($count -gt 0) 'native frame not EOF'; $offset += $count
    }
    $length=[BitConverter]::ToUInt32($header,0); Assert ($length -gt 0 -and $length -le 1048576) 'native frame bounds'
    $bytes=New-Object byte[] $length; $offset=0
    while ($offset -lt $length) {
      $task=$stream.ReadAsync($bytes,$offset,$length-$offset)
      Assert ($task.Wait(10000)) 'native payload before deadline'
      $count=$task.Result; Assert ($count -gt 0) 'native payload not truncated'; $offset += $count
    }
    return ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
  }
  $native=$null; $cli=$null
  try {
    $native=Start-IsolatedExecutable 'CharacterBridge.exe' 'chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/ --parent-window=0'
    Assert ((Read-NativeFrame $native.StandardOutput.BaseStream).type -ceq 'ready') 'packaged GUI helper initializes stdio, listener and config'
    $configuration=Get-Content -LiteralPath (Join-Path $sandbox 'runtime local app data/TabletopVR/character-bridge/v2/http.json') -Raw | ConvertFrom-Json
    $schema=Invoke-RestMethod -Uri ($configuration.url + '/openapi.json') -Headers @{Authorization=('Bearer ' + $configuration.token)} -TimeoutSec 5
    Assert ($schema.openapi -ceq '3.1.0') 'packaged Kestrel and embedded schema run self-contained'
    $cli=Start-IsolatedExecutable 'character-api.exe' 'GET /openapi.json'
    $cliOutput=$cli.StandardOutput.ReadToEndAsync(); $cliError=$cli.StandardError.ReadToEndAsync()
    Assert ($cli.WaitForExit(10000)) 'packaged CLI exits before deadline'
    Assert ($cli.ExitCode -eq 0 -and (($cliOutput.Result | ConvertFrom-Json).openapi -ceq '3.1.0')) 'packaged CLI reads discovery and makes authenticated request'
    Assert ($cliError.Result.Length -eq 0) 'packaged CLI no secret/exception output'
    $native.StandardInput.Close()
    Assert ($native.WaitForExit(10000) -and $native.ExitCode -eq 0) 'packaged native host exits on browser EOF'
    Assert ($native.StandardOutput.ReadToEnd().Length -eq 0 -and $native.StandardError.ReadToEnd().Length -eq 0) 'packaged GUI no unframed output'
  } finally {
    foreach ($process in @($cli,$native)) { if ($null -ne $process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() } }
  }
  Write-Host 'PASS standalone package contents, module/resource closure, notices and private/legacy exclusions.'
  Write-Host 'PASS actual packaged self-contained GUI relay and CLI with isolated LOCALAPPDATA and no installed runtime lookup.'
} finally {
  $resolved = [IO.Path]::GetFullPath($sandbox)
  $intended = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts')) + [IO.Path]::DirectorySeparatorChar
  if ($resolved.StartsWith($intended,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
