[CmdletBinding()]
param(
  [string]$InstallDirectory,
  [switch]$DryRun,
  [Parameter(DontShow=$true)][hashtable]$RegistryAdapter
)
# Windows PowerShell 5.1 -File binds defaults before $PSScriptRoot is set.
if (-not $PSBoundParameters.ContainsKey('InstallDirectory')) { $InstallDirectory = $PSScriptRoot }
. (Join-Path $PSScriptRoot 'registration.ps1')
if ($null -eq $RegistryAdapter) { $RegistryAdapter = Get-BridgeRegistryAdapter }
$plan = New-BridgeRegistrationPlan -InstallDirectory $InstallDirectory -Browser Both -Uninstall $false -RegistryAdapter $RegistryAdapter
if ($DryRun) { return $plan }
Invoke-BridgeRegistrationPlan $plan $RegistryAdapter
Write-Host ('Registered Character API for Chrome and Brave in: ' + $plan.InstallDirectory)
Write-Host 'Keep this folder in its permanent location. Load extensions/dndbeyond as an unpacked extension in your browser.'
Write-Host 'Open the extension setup page, then run character-api.exe GET /v1/status. See README.md.'
