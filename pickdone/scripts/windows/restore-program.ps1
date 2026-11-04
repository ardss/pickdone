[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BackupProgram,
  [Parameter(Mandatory=$true)][string]$InstalledExe,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedBackupExeSha256,
  [switch]$TestIsolation
)
$ErrorActionPreference='Stop'
$exe=[IO.Path]::GetFullPath($InstalledExe)
$root=Split-Path -Parent $exe
if([IO.Path]::GetFileName($exe) -ne 'PickDone.exe'){throw 'Refusing unrelated executable'}
if(-not(Test-Path -LiteralPath $BackupProgram -PathType Container)){throw 'Backup program directory missing'}
$oldExe=Join-Path $BackupProgram 'PickDone.exe'
if(-not(Test-Path -LiteralPath $oldExe -PathType Leaf)){throw 'Backup PickDone.exe missing'}
$expected=$ExpectedBackupExeSha256.ToUpperInvariant()
if((Get-FileHash -LiteralPath $oldExe -Algorithm SHA256).Hash -ne $expected){throw 'Backup program hash mismatch'}
foreach($dir in @($root,$BackupProgram)){
 if(Test-Path -LiteralPath $dir){
  $item=Get-Item -LiteralPath $dir -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing to swap a junction/symlink path'}
 }
}
$rootParent=Split-Path -Parent $root
if(-not(Test-Path -LiteralPath $rootParent -PathType Container)){throw 'Install parent missing'}
$labRoot=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'pickdone-rollback-fixtures')) + [IO.Path]::DirectorySeparatorChar
if($TestIsolation -and -not $root.StartsWith($labRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'TestIsolation restricted to rollback fixtures'}
$running=if($TestIsolation){@()}else{@(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'")}
$foreign=@($running|Where-Object {$_.ExecutablePath -and ![string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase)})
if($foreign.Count){throw 'Other PickDone install root is running; refuse rollback'}
# Stop only the known install root; never kill other application families.
for($attempt=0;$attempt -lt $(if($TestIsolation){0}else{8});$attempt++){
$running=if($TestIsolation){@()}else{@(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'")}
 if(-not $running.Count){break}
 $foreign=@($running|Where-Object {![string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase)})
 if($foreign.Count){throw 'Unexpected PickDone root during rollback'}
 foreach($p in $running){Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}
 Start-Sleep -Milliseconds 600
}
if(-not $TestIsolation -and @(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'").Count){throw 'Cannot stop current PickDone install; rollback refused'}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$name=Split-Path $root -Leaf
$stage=Join-Path $rootParent ($name+'.RESTORING-'+$stamp)
$failed=Join-Path $rootParent ($name+'.FAILED-'+$stamp)
if((Test-Path $stage) -or (Test-Path $failed)){throw 'Rollback staging destination collision'}
# Pre-stage and fully verify BEFORE moving the current installation away.
Copy-Item -LiteralPath $BackupProgram -Destination $stage -Recurse -Force -ErrorAction Stop
if((Get-FileHash (Join-Path $stage 'PickDone.exe') -Algorithm SHA256).Hash -ne $expected){
 throw 'Rollback staged executable failed integrity check; current install unchanged'
}
# Detect incomplete copy of any executable/resource. Do not remove the source backup.
$originals=@(Get-ChildItem -LiteralPath $BackupProgram -File -Recurse -Force)
$copied=@(Get-ChildItem -LiteralPath $stage -File -Recurse -Force)
if($originals.Count -ne $copied.Count){throw 'Rollback stage file count differs from backup'}
foreach($f in $originals){
 $rel=$f.FullName.Substring($BackupProgram.TrimEnd('\').Length+1)
 $copy=Join-Path $stage $rel
 if(-not(Test-Path -LiteralPath $copy -PathType Leaf)){throw 'Rollback staged file missing'}
 if((Get-Item -LiteralPath $copy).Length -ne $f.Length){throw 'Rollback staged file size mismatch'}
}
$hadRoot=Test-Path -LiteralPath $root
$movedRoot=$false
try{
 if($hadRoot){Move-Item -LiteralPath $root -Destination $failed -ErrorAction Stop;$movedRoot=$true}
 Move-Item -LiteralPath $stage -Destination $root -ErrorAction Stop
 if((Get-FileHash -LiteralPath (Join-Path $root 'PickDone.exe') -Algorithm SHA256).Hash -ne $expected){throw 'Post-restore executable integrity mismatch'}
}catch{
 $reason=$_.Exception.Message
 if($movedRoot -and -not(Test-Path -LiteralPath $root) -and (Test-Path -LiteralPath $failed)){
   try {Move-Item -LiteralPath $failed -Destination $root -ErrorAction Stop}catch {}
 }
 throw ('Program rollback swap failed; staging and prior version retained when possible: '+$reason)
}
# Never delete failed app or touch user database. Returning a report allows caller to restart.
$failedProgram = if($hadRoot){$failed}else{$null}
[pscustomobject]@{
  ok=$true;restoredVersion=(Get-Item -LiteralPath (Join-Path $root 'PickDone.exe')).VersionInfo.FileVersion;
  oldExeSha256=$expected;failedProgram=$failedProgram;
  backupRetained=(Test-Path -LiteralPath $oldExe);
  liveUserDataUntouched=$true
}|ConvertTo-Json -Compress
