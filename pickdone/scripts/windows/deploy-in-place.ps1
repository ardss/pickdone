[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$InstalledExe,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$RecoveryRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedInstallerSha256,
  [string]$StartTask='',
  [switch]$RestartAfterInstall
)
$ErrorActionPreference='Stop'
$installer=(Resolve-Path -LiteralPath $Installer).Path
$exe=[IO.Path]::GetFullPath($InstalledExe)
$root=Split-Path -Parent $exe
if([IO.Path]::GetFileName($exe) -ne 'PickDone.exe'){throw 'Expected PickDone.exe'}
if(-not(Test-Path -LiteralPath $exe)){throw 'Installed executable not found'}
$hash=(Get-FileHash $installer -Algorithm SHA256).Hash
if($hash -ne $ExpectedInstallerSha256.ToUpperInvariant()){throw 'Installer checksum mismatch'}
$oldVersion=(Get-Item $exe).VersionInfo.FileVersion
# NSIS replaces the previous build in one directory. Other install roots/start tasks block upgrade.
$verifier=Join-Path $PSScriptRoot 'verify-upgrade.ps1'
$rollbackHelper=Join-Path $PSScriptRoot 'restore-program.ps1'
if(-not(Test-Path -LiteralPath $verifier)){throw 'Upgrade verification script missing'}
if(-not(Test-Path -LiteralPath $rollbackHelper)){throw 'Rollback helper missing; refuse to start any installation'}
$preCheck=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifier -ExpectedExe $exe -ExpectedVersion $oldVersion
if($LASTEXITCODE -ne 0){throw ('Pre-install inventory refused: '+($preCheck -join ' '))}
if($oldVersion -eq $ExpectedVersion){throw 'Already at the expected version; refusing unnecessary reinstall'}
$fromBeta=[regex]::Match($oldVersion,'^(\d+\.\d+\.\d+)-beta\.(\d+)$')
$toBeta=[regex]::Match($ExpectedVersion,'^(\d+\.\d+\.\d+)-beta\.(\d+)$')
if($fromBeta.Success -and $toBeta.Success -and $fromBeta.Groups[1].Value -eq $toBeta.Groups[1].Value -and
   [int]$toBeta.Groups[2].Value -le [int]$fromBeta.Groups[2].Value){
 throw 'Version downgrade or reinstall is blocked by default'
}
$procs=@(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'")
$alien=@($procs|Where-Object {![string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase)})
if($alien.Count){throw 'Another PickDone installation root is running'}
$time=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup=Join-Path $RecoveryRoot ('upgrade-'+$oldVersion+'-to-'+$ExpectedVersion+'-'+$time)
New-Item -ItemType Directory -Path $backup -Force|Out-Null
$report=[ordered]@{from=$oldVersion;to=$ExpectedVersion;backup=$backup;installerHash=$hash;started=$false}
$data=Join-Path $env:APPDATA 'PickDone'
if(-not (Test-Path (Join-Path $data 'todos.db')) -or -not (Test-Path (Join-Path $data 'db.key'))){throw 'Live encrypted database or key missing'}
$shouldRestart=$procs.Count -gt 0 -or [bool]$RestartAfterInstall
# Electron helpers can take more than two seconds to tear down. Re-sample known-root
# processes with a bounded wait; refuse to kill anything from another install root.
$remain=@()
for($attempt=0;$attempt -lt 8;$attempt++){
 $remain=@(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'")
 if($remain.Count -eq 0){break}
 $unexpected=@($remain|Where-Object {![string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase)})
 if($unexpected.Count){throw 'Unexpected PickDone root while stopping'}
 foreach($one in $remain){Stop-Process -Id $one.ProcessId -Force -ErrorAction SilentlyContinue}
 Start-Sleep -Seconds 2
}
$remain=@(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'")
if($remain.Count){throw 'PickDone still running after bounded stop attempts'}
# Copy only the program tree and the consistent, quiescent SQLite set. Never merge or alter live user data.
try {
Copy-Item -LiteralPath $root -Destination (Join-Path $backup 'program') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $backup 'user-data') -Force|Out-Null
foreach($f in @('todos.db','todos.db-wal','todos.db-shm','db.key','config.json')){
 if(Test-Path (Join-Path $data $f)){Copy-Item -LiteralPath (Join-Path $data $f) -Destination (Join-Path $backup 'user-data') -Force}
}
if(Test-Path (Join-Path $data 'files')){Copy-Item -LiteralPath (Join-Path $data 'files') -Destination (Join-Path $backup 'user-data\files') -Recurse -Force}
$preHash=(Get-FileHash (Join-Path $data 'todos.db') -Algorithm SHA256).Hash
$preKeyHash=(Get-FileHash (Join-Path $data 'db.key') -Algorithm SHA256).Hash
$backupExeHash=(Get-FileHash (Join-Path $backup 'program\PickDone.exe') -Algorithm SHA256).Hash
$report.backupComplete=$true
} catch {
  $backupError=$_.Exception.Message
  # The installer has not run, so the original program remains intact.
  # Do not leave the user with a stopped application just because a backup
  # target is full or an attachment cannot be copied.
  $reopenError=''
  if($shouldRestart){
    try {
      if($StartTask){
        schtasks.exe /run /tn $StartTask |Out-Null
        if($LASTEXITCODE -ne 0){throw 'Startup task failed'}
      }else{Start-Process -FilePath $exe}
    }catch{$reopenError=$_.Exception.Message}
  }
  throw ('PREINSTALL_BACKUP_FAILED: '+$backupError+'; ORIGINAL_APP_PRESERVED; REOPEN_ERROR: '+$reopenError+'; PARTIAL_BACKUP: '+$backup)
}
$installAttempted=$false
try {
# NSIS /S installs into the existing registered product directory. /D is always the last argument.
$installAttempted=$true
$proc=Start-Process -FilePath $installer -ArgumentList @('/S',('/D='+$root)) -Wait -PassThru
$report.installerExit=$proc.ExitCode
if($proc.ExitCode -ne 0){throw ('Installer failed with '+$proc.ExitCode+'; backup '+$backup)}
if(-not(Test-Path $exe)){throw ('New program missing; backup '+$backup)}
$report.installedVersion=(Get-Item $exe).VersionInfo.FileVersion
if($report.installedVersion -ne $ExpectedVersion){throw ('Expected '+$ExpectedVersion+' but found '+$report.installedVersion+'; backup '+$backup)}
if((Get-FileHash (Join-Path $data 'todos.db') -Algorithm SHA256).Hash -ne $preHash){throw 'Database changed during offline program upgrade'}
if((Get-FileHash (Join-Path $data 'db.key') -Algorithm SHA256).Hash -ne $preKeyHash){throw 'Database key changed during offline program upgrade'}
$report.userDataUnchanged=$true
if($shouldRestart){
 if($StartTask){
  $task=Get-ScheduledTask -TaskName $StartTask -ErrorAction Stop
  if([string]$task.State -eq 'Disabled'){throw 'Launch task is disabled'}
  schtasks.exe /run /tn $StartTask |Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not launch scheduled task'}
 }else{Start-Process -FilePath $exe}
 Start-Sleep -Seconds 6
}
$procs=@(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'")
$roots=@($procs|Where-Object {$_.ExecutablePath}|Select-Object -ExpandProperty ExecutablePath -Unique)
if(@($roots|Where-Object {![string]::Equals($_,$exe,[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Unexpected second running application root'}
if($shouldRestart -and $roots.Count -ne 1){throw 'Installed app did not restart'}
$report.started=$shouldRestart
$report.activeExecutableRoots=$roots.Count
$postCheck=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifier -ExpectedExe $exe -ExpectedVersion $ExpectedVersion
if($LASTEXITCODE -ne 0){throw ('Post-install inventory failed: '+($postCheck -join ' '))}
$report.ok=$true
[pscustomobject]$report|ConvertTo-Json -Compress
}catch {
  $upgradeError=$_.Exception.Message
  # Never roll back before an installer has actually been attempted. Preserve
  # preflight/backup errors as-is instead of swapping any application directory.
  if(-not $installAttempted){throw}
  $rollbackScript=Join-Path $PSScriptRoot 'restore-program.ps1'
  $rolledBack=$false
  $restoreError=''
  $dataUnchanged=$false
  try {
    # A transient lock on the database must never prevent PROGRAM rollback.
    # If hashes cannot be read, treat data as UNKNOWN and do not auto-reopen.
    try {
      $dataUnchanged=(Test-Path (Join-Path $data 'todos.db')) -and
        (Test-Path (Join-Path $data 'db.key')) -and
        ((Get-FileHash (Join-Path $data 'todos.db') -Algorithm SHA256).Hash -eq $preHash) -and
        ((Get-FileHash (Join-Path $data 'db.key') -Algorithm SHA256).Hash -eq $preKeyHash)
    } catch { $dataUnchanged=$false }
    if(-not(Test-Path -LiteralPath $rollbackScript)){throw 'Rollback helper missing'}
    # Restore the old executable and resources only. Quarantine the failed new
    # program; leave the user's database, keys, and attachments untouched.
    $restoreRaw=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rollbackScript `
      -BackupProgram (Join-Path $backup 'program') -InstalledExe $exe `
      -ExpectedBackupExeSha256 $backupExeHash 2>&1
    if($LASTEXITCODE -ne 0){throw ('Restore helper failed: '+($restoreRaw -join ' '))}
    $restored=($restoreRaw|Out-String)|ConvertFrom-Json
    if(-not $restored.ok){throw 'Restore helper did not confirm success'}
    $rolledBack=$true
    # Reopen the original version only when the data files match the
    # pre-upgrade offline snapshot. Never risk old code opening migrated data.
    if($dataUnchanged -and $shouldRestart){
      if($StartTask){
        schtasks.exe /run /tn $StartTask |Out-Null
        if($LASTEXITCODE -ne 0){throw 'Old-version startup task failed'}
      }else{Start-Process -FilePath $exe}
    }
  }catch {
    $restoreError=$_.Exception.Message
  }
  $status=if($rolledBack){'PROGRAM_RESTORED'}else{'ROLLBACK_FAILED'}
  $dataStatus=if($dataUnchanged){'USER_DATA_HASH_UNCHANGED'}else{'USER_DATA_CHANGED_PRESERVED_FOR_MANUAL_RECOVERY'}
  throw ("UPGRADE_FAILED: "+$upgradeError+"; "+$status+"; "+$dataStatus+
         "; ROLLBACK_PROBLEM: "+$restoreError+"; BACKUP: "+$backup)
}
