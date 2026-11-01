[CmdletBinding()]
param(
  [string]$InstallDirectory,
  [switch]$DryRun,
  [Parameter(DontShow=$true)][hashtable]$RegistryAdapter
)
# Resolve the default at execution time, including the .cmd / -File entrypoint.
if (-not $PSBoundParameters.ContainsKey('InstallDirectory')) { $InstallDirectory = $PSScriptRoot }
. (Join-Path $PSScriptRoot 'registration.ps1')
if ($null -eq $RegistryAdapter) { $RegistryAdapter = Get-BridgeRegistryAdapter }
$plan = New-BridgeRegistrationPlan -InstallDirectory $InstallDirectory -Browser Both -Uninstall $true -RegistryAdapter $RegistryAdapter
if ($DryRun) { return $plan }
Invoke-BridgeRegistrationPlan $plan $RegistryAdapter
Write-Host 'Removed this installation native-host registration. Remove the unpacked extension in Chrome or Brave.'
Write-Host 'Extracted files and local API configuration were preserved. You may delete this package folder after closing the browser.'
