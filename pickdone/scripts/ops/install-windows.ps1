#requires -Version 5.1
# PickDone A/B standard updater; invoke on the TARGET user's Windows desktop.
# Read-only by default. -Apply is the only mode that changes the installation.
# This NEVER publishes a GitHub Release.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('A','B')][string]$Target,
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$Installer,
  [string]$Sha256,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$machines = @{
  A = @{ Hostname='DESKTOP-CD2C03F'; InstallDir='D:\pickdone' }
  B = @{ Hostname='DU'; InstallDir='F:\PickDone' }
}
$m=$machines[$Target]
$hostname=[System.Net.Dns]::GetHostName()
if($hostname -ine $m.Hostname) { throw "WRONG_MACHINE: expected $($m.Hostname), got $hostname" }
$exe=Join-Path $m.InstallDir 'PickDone.exe'
$pkg=Join-Path $m.InstallDir 'resources\package.json'
if(-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $pkg)) {
  throw "INSTALL_NOT_FOUND: $exe. This script is for upgrades, not first-time installs."
}
function Read-State {
  $disk=(Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version
  $matches=@(Get-CimInstance Win32_Process -Filter "Name='PickDone.exe'" |
    Where-Object { $_.ExecutablePath -ieq $exe })
  $all=@(Get-CimInstance Win32_Process -Filter "Name='PickDone.exe'")
  $other=@($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ine $exe })
  $reg=@(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'PickDone*' })
  $regVersion=if($reg.Count -eq 1){$reg[0].DisplayVersion}else{''}
  return [pscustomobject]@{
    Host=$hostname; Target=$Target; Executable=$exe
    DiskVersion=[string]$disk; RegistryVersion=[string]$regVersion
    ProcessCount=$matches.Count
    Processes=@($matches | Select-Object ProcessId,ExecutablePath,CreationDate)
    OtherInstallProcessCount=$other.Count
  }
}
$before=Read-State
$backup=''
if($Apply) {
  if($before.OtherInstallProcessCount) { throw 'OTHER_INSTALL_RUNNING: refusing to replace files' }
  if($before.DiskVersion -ne $Version -or $before.RegistryVersion -ne $Version) {
    if(-not $Installer -or -not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'INSTALLER_REQUIRED' }
    if($Sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'SHA256_REQUIRED' }
    $hash=(Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
    if($hash -ine $Sha256) { throw 'INSTALLER_HASH_MISMATCH' }
    $data=Join-Path $env:APPDATA 'pickdone'
    if(-not (Test-Path -LiteralPath $data)) { throw "USER_DATA_MISSING: $data" }
    $backup=Join-Path $env:LOCALAPPDATA ('PickDoneDeploy\backups\'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -Path $backup -ItemType Directory -Force | Out-Null
    & robocopy.exe $data (Join-Path $backup 'pickdone') /E /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
    if($LASTEXITCODE -gt 7) { throw "BACKUP_FAILED: $backup" }
    foreach($p in @(Get-Process PickDone -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $exe })) {
      [void]$p.CloseMainWindow()
    }
    Start-Sleep -Seconds 3
    if(@(Get-CimInstance Win32_Process -Filter "Name='PickDone.exe'").Count -gt 0) {
      throw "APP_STILL_RUNNING: safely quit PickDone (including tray); backup=$backup"
    }
    $setup=Start-Process -FilePath $Installer -ArgumentList @('/S',"/D=$($m.InstallDir)") -PassThru
    if(-not $setup.WaitForExit(120000)) { throw "INSTALLER_TIMEOUT: pid=$($setup.Id) backup=$backup" }
    if($setup.ExitCode -ne 0) { throw "INSTALLER_FAILED: exit=$($setup.ExitCode) backup=$backup" }
  }
  $state=Read-State
  if($state.DiskVersion -eq $Version -and $state.RegistryVersion -eq $Version -and $state.ProcessCount -eq 0) {
    if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'NO_INTERACTIVE_SESSION' }
    Start-Process -FilePath $exe -WorkingDirectory $m.InstallDir
    Start-Sleep -Seconds 5
  }
}
$after=Read-State
$after | ConvertTo-Json -Depth 6
if($after.DiskVersion -ne $Version) { throw "DISK_VERSION_MISMATCH: $($after.DiskVersion)" }
if($after.RegistryVersion -ne $Version) { throw "REGISTRY_VERSION_MISMATCH: $($after.RegistryVersion)" }
if($after.ProcessCount -eq 0) { throw 'NOT_RUNNING: cannot claim installation is running' }
if($after.OtherInstallProcessCount) { throw 'MULTIPLE_INSTALLS_RUNNING' }
Write-Output 'RESULT=RUNNING_INSTALLED_VERSION_MATCH'
Write-Output 'QA=Application runtime UI and feature verification not covered by this script'
if($backup){Write-Output "BACKUP=$backup"}
