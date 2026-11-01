# Development updates target the user's registered standalone installation.
# A build output is not another installation and is never a fallback host.
function Get-InstalledCharacterApiDirectory {
  param([string]$ManifestPath)
  if (-not $ManifestPath) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts\com.tabletopvr.character_bridge',$false)
    if ($null -eq $key) { throw 'Install the standalone Character API package first.' }
    try { $ManifestPath=$key.GetValue('', $null) } finally { $key.Dispose() }
  }
  if (-not $ManifestPath -or $ManifestPath -notmatch '^[a-zA-Z]:[\\/]' -or $ManifestPath.Contains('"')) { throw 'Registered native manifest must use an absolute local path.' }
  $manifest=Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $directory=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ManifestPath))
  $helper=Join-Path $directory 'CharacterBridge.exe'
  if ($manifest.name -cne 'com.tabletopvr.character_bridge' -or $manifest.type -cne 'stdio' -or
      @($manifest.allowed_origins).Count -ne 1 -or $manifest.allowed_origins[0] -cne 'chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/' -or
      $manifest.path -ine $helper -or -not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Registered host is not the expected standalone Character API installation.' }
  return $directory
}
