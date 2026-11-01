# Shared by the portable entry scripts. Windows PowerShell 5.1; no SDK, shell
# commands, elevation, browser/profile access or writes while constructing plans.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$BridgeHostName = 'com.tabletopvr.character_bridge'
$BridgeApplication = 'TabletopVR.CharacterBridge.v1'
$BridgeOwnerValue = 'TabletopVR.CharacterBridge.Owner'
$BridgeOrigin = 'chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/'
$BridgeUtf8 = New-Object Text.UTF8Encoding($false, $true)

function Get-BridgeAbsolutePath([string]$Path) {
  if ($Path -notmatch '^[a-zA-Z]:[\\/]' -or $Path.Contains('"') -or $Path.Substring(2).Contains(':')) {
    throw 'Use an absolute local Windows path, without quotes inside the value or alternate data streams.'
  }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  # Check every existing ancestor, not just the leaf: junctions/symlinks would
  # otherwise let an apparently contained manifest/helper escape the package.
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Bridge package paths must not traverse reparse points.'
      }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  return $full
}

function Get-BridgeJson($Value) { return ($Value | ConvertTo-Json -Depth 8) }
function Test-BridgeEqual($Left, $Right) {
  return (ConvertTo-Json -InputObject $Left -Depth 8 -Compress) -ceq (ConvertTo-Json -InputObject $Right -Depth 8 -Compress)
}
function Test-BridgeJsonText([string]$Text, [string]$Expected) {
  # Windows PowerShell 5.1 and PowerShell 7 format JSON differently. Compare
  # the exact property names/values, preserving ownership checks without
  # treating indentation or object property order as a modification.
  try {
    $actual = $Text | ConvertFrom-Json
    $wanted = $Expected | ConvertFrom-Json
    $names = @($actual.PSObject.Properties.Name)
    if ($names.Count -ne @($wanted.PSObject.Properties.Name).Count) { return $false }
    foreach ($property in $wanted.PSObject.Properties) {
      if ($names -cnotcontains $property.Name -or -not (Test-BridgeEqual $actual.PSObject.Properties[$property.Name].Value $property.Value)) { return $false }
    }
    return $true
  } catch { return $false }
}
function Get-BridgeManifest([string]$Helper) {
  return Get-BridgeJson ([ordered]@{
    name=$BridgeHostName; description='Tabletop VR Character Bridge'; path=$Helper
    type='stdio'; allowed_origins=@($BridgeOrigin)
  })
}
function Get-BridgeRegistryAdapter {
  # HKCU Software native-host keys are shared between Windows registry views.
  # No HKLM, WOW6432Node, policy/force-install, browser data or parent deletion.
  return @{
    Read = { param($Path)
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Path.Substring(6), $false)
      if ($null -eq $key) { return $null }
      try {
        $names = @($key.GetValueNames())
        $extra = @($names | Where-Object { $_ -cne '' -and $_ -cne $BridgeOwnerValue })
        foreach ($name in @('', $BridgeOwnerValue)) {
          if ($names -contains $name -and $key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) { $extra += 'non-string value' }
        }
        return [pscustomobject]@{
          Default=$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          Owner=$key.GetValue($BridgeOwnerValue, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          ExtraValues=$extra; SubKeys=@($key.GetSubKeyNames())
        }
      } finally { $key.Dispose() }
    }
    Write = { param($Path,$State)
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Path.Substring(6))
      try {
        $key.SetValue('', $State.Default, [Microsoft.Win32.RegistryValueKind]::String)
        $key.SetValue($BridgeOwnerValue, $State.Owner, [Microsoft.Win32.RegistryValueKind]::String)
      } finally { $key.Dispose() }
    }
    Delete = { param($Path)
      [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($Path.Substring(6), $false)
    }
  }
}

function Get-BridgeFileChange([string]$Path, $After) {
  $before = $null; $time = $null
  if (Test-Path -LiteralPath $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Generated bridge file path is occupied by a directory.' }
    $before = [IO.File]::ReadAllBytes($Path)
    $time = [IO.File]::GetLastWriteTimeUtc($Path).Ticks
  }
  return [pscustomobject]@{ Path=$Path; Before=$before; BeforeTime=$time; After=$After }
}

function New-BridgeRegistrationPlan {
  param([string]$InstallDirectory, [string]$Browser, [bool]$Uninstall, [hashtable]$RegistryAdapter)
  $directory = Get-BridgeAbsolutePath $InstallDirectory
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'InstallDirectory must be an existing directory.' }
  $helper = Get-BridgeAbsolutePath (Join-Path $directory 'CharacterBridge.exe')
  $manifestPath = Get-BridgeAbsolutePath (Join-Path $directory ($BridgeHostName + '.json'))
  $receiptPath = Get-BridgeAbsolutePath (Join-Path $directory '.character-bridge-registration.json')
  foreach ($path in @($helper,$manifestPath,$receiptPath)) {
    if ([IO.Path]::GetDirectoryName($path) -cne $directory) { throw 'Bridge path escaped the installation directory.' }
  }
  if (-not $Uninstall -and -not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Adjacent self-contained CharacterBridge.exe is missing.' }
  $identityPath = Join-Path $directory 'protocol/extension-identity.json'
  $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([Convert]::FromBase64String($identity.manifest_key))
    $derived = -join @($digest[0..15] | ForEach-Object { [string][char](97 + ($_ -shr 4)) + [char](97 + ($_ -band 15)) })
    $installationId = ([BitConverter]::ToString($sha.ComputeHash($BridgeUtf8.GetBytes($directory.ToLowerInvariant())))).Replace('-','').ToLowerInvariant()
  } finally { $sha.Dispose() }
  if ($derived -cne 'abeakpcagojpphodembeeajfjgmcadnc' -or $identity.extension_id -cne $derived -or $identity.origin -cne $BridgeOrigin -or $identity.native_host_name -cne $BridgeHostName -or $identity.schema -ne 1) {
    throw 'Public extension identity does not match the fixed bridge identity.'
  }
  $oldManifestPath = $manifestPath
  $receipt = $null
  if (Test-Path -LiteralPath $receiptPath) {
    $receiptText = [IO.File]::ReadAllText($receiptPath, $BridgeUtf8)
    $receipt = $receiptText | ConvertFrom-Json
    if ($receipt.application -cne $BridgeApplication -or $receipt.schema -ne 1 -or $receipt.installation_id -cnotmatch '^[0-9a-f]{64}$') { throw 'Unrecognized bridge ownership receipt.' }
    $oldManifestPath = Get-BridgeAbsolutePath $receipt.manifest_path
    $oldHelper = Get-BridgeAbsolutePath $receipt.helper_path
    $oldDirectory = [IO.Path]::GetDirectoryName($oldManifestPath)
    if ($oldDirectory -ine $directory -and (Test-Path -LiteralPath $oldDirectory)) {
      throw 'The original installation still exists. Unregister it there before registering a separate copy.'
    }
    if ($oldManifestPath -cne (Join-Path $oldDirectory ($BridgeHostName + '.json')) -or $oldHelper -cne (Join-Path $oldDirectory 'CharacterBridge.exe')) { throw 'Invalid receipt path containment.' }
    $expectedReceipt = Get-BridgeJson ([ordered]@{ schema=1; application=$BridgeApplication; installation_id=$receipt.installation_id; manifest_path=$oldManifestPath; helper_path=$oldHelper })
    if (-not (Test-BridgeJsonText $receiptText $expectedReceipt) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-BridgeJsonText ([IO.File]::ReadAllText($manifestPath, $BridgeUtf8)) (Get-BridgeManifest $oldHelper))) {
      throw 'Generated manifest/receipt ownership mismatch; refusing overwrite or deletion.'
    }
    $installationId = $receipt.installation_id
  } elseif (Test-Path -LiteralPath $manifestPath) {
    throw 'An unowned native manifest already occupies the generated path.'
  }
  $manifestJson = Get-BridgeManifest $helper
  $newReceipt = Get-BridgeJson ([ordered]@{ schema=1; application=$BridgeApplication; installation_id=$installationId; manifest_path=$manifestPath; helper_path=$helper })
  $allPaths = @(
    ('HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $BridgeHostName),
    ('HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $BridgeHostName)
  )
  # Brave is an explicitly UNVERIFIED Chromium/Chrome-fallback target. No
  # speculative BraveSoftware native-host key. See the source audit in the guide.
  $selected = @($allPaths[0]) # Chrome and Brave share this per-user host location.
  $changes = @(); $retainFiles = $false
  foreach ($path in $allPaths) {
    $current = & $RegistryAdapter.Read $path
    $isSelected = $selected -contains $path
    $owned = $null -ne $receipt -and $null -ne $current -and $current.Owner -ceq $installationId -and $current.Default -ceq $oldManifestPath -and @($current.ExtraValues).Count -eq 0 -and @($current.SubKeys).Count -eq 0
    if ($isSelected -and $null -ne $current -and -not $owned) { throw ('Refusing an unowned or modified registration: ' + $path) }
    if (-not $isSelected) {
      # A modified key can still reference this installation. Do not rewrite the
      # moved receipt and strand that browser merely because strict ownership fails.
      $referencesInstallation = $null -ne $current -and ($current.Default -ieq $oldManifestPath -or $current.Owner -ieq $installationId)
      if (-not $Uninstall -and $referencesInstallation -and $oldManifestPath -cne $manifestPath) { throw 'A previous Edge registration still references this installation. Remove that registration with its original installer before moving this folder.' }
      if ($null -ne $current -and ($current.Default -ceq $oldManifestPath -or $current.Default -ceq $manifestPath -or $current.Owner -ceq $installationId)) { $retainFiles = $true }
      continue
    }
    $after = $null
    if (-not $Uninstall) { $after = [pscustomobject]@{ Default=$manifestPath; Owner=$installationId; ExtraValues=@(); SubKeys=@() } }
    $changes += [pscustomobject]@{ Path=$path; Before=$current; After=$after }
  }
  $files = @()
  if (-not $Uninstall) {
    $files += Get-BridgeFileChange $manifestPath ($BridgeUtf8.GetBytes($manifestJson))
    $files += Get-BridgeFileChange $receiptPath ($BridgeUtf8.GetBytes($newReceipt))
  } elseif ($null -ne $receipt -and -not $retainFiles) {
    $files += Get-BridgeFileChange $manifestPath $null
    $files += Get-BridgeFileChange $receiptPath $null
  }
  return [pscustomobject]@{
    Action=$(if ($Uninstall) { 'Unregister' } else { 'RegisterOrRepair' })
    Browser=$Browser; BrowserCompatibility='unverified'
    HostName=$BridgeHostName; AllowedOrigins=@($BridgeOrigin); InstallDirectory=$directory
    HelperPath=$helper; ManifestPath=$manifestPath; ManifestJson=$manifestJson
    RegistryPaths=$selected; RegistryChanges=$changes; FileChanges=$files
  }
}

function Set-BridgePlannedFile($Change, [bool]$Restore) {
  $bytes = $Change.After
  if ($Restore) { $bytes = $Change.Before }
  if ($null -eq $bytes) {
    if (Test-Path -LiteralPath $Change.Path) { [IO.File]::Delete($Change.Path) }
  } else {
    [IO.File]::WriteAllBytes($Change.Path, [byte[]]$bytes)
    if ($Restore) { [IO.File]::SetLastWriteTimeUtc($Change.Path, (New-Object DateTime($Change.BeforeTime, [DateTimeKind]::Utc))) }
  }
}

function Invoke-BridgeRegistrationPlan($Plan, [hashtable]$RegistryAdapter) {
  # Detect changed inputs before any write. Every actual mutation uses the
  # already validated plan returned by -DryRun, never a second installer path.
  foreach ($change in $Plan.RegistryChanges) {
    if (-not (Test-BridgeEqual (& $RegistryAdapter.Read $change.Path) $change.Before)) { throw 'Registry changed after preflight; retry.' }
  }
  foreach ($change in $Plan.FileChanges) {
    $current = Get-BridgeFileChange $change.Path $null
    if (-not (Test-BridgeEqual $current.Before $change.Before)) { throw 'Generated file changed after preflight; retry.' }
  }
  $writtenFiles = @(); $writtenKeys = @()
  try {
    # Publish files before pointing browsers at them; uninstall removes keys first.
    if ($Plan.Action -eq 'RegisterOrRepair') {
      foreach ($change in $Plan.FileChanges) { $writtenFiles += $change; Set-BridgePlannedFile $change $false }
    }
    foreach ($change in $Plan.RegistryChanges) {
      if (Test-BridgeEqual $change.Before $change.After) { continue }
      $writtenKeys += $change
      if ($null -eq $change.After) { & $RegistryAdapter.Delete $change.Path | Out-Null }
      else { & $RegistryAdapter.Write $change.Path $change.After | Out-Null }
    }
    if ($Plan.Action -eq 'Unregister') {
      foreach ($change in $Plan.FileChanges) { $writtenFiles += $change; Set-BridgePlannedFile $change $false }
    }
  } catch {
    $failure = $_; $rollbackErrors = @()
    [array]::Reverse($writtenFiles)
    foreach ($change in $writtenFiles) {
      try { Set-BridgePlannedFile $change $true } catch { $rollbackErrors += $_.Exception.Message }
    }
    [array]::Reverse($writtenKeys)
    foreach ($change in $writtenKeys) {
      try {
        if ($null -eq $change.Before) { & $RegistryAdapter.Delete $change.Path | Out-Null }
        else { & $RegistryAdapter.Write $change.Path $change.Before | Out-Null }
      } catch { $rollbackErrors += $_.Exception.Message }
    }
    if ($rollbackErrors.Count) { throw ('Apply failed and rollback was incomplete: ' + $failure.Exception.Message + '; ' + ($rollbackErrors -join '; ')) }
    throw $failure
  }
}
