$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot 'restore-program.ps1'
$lab=Join-Path ([IO.Path]::GetTempPath()) 'pickdone-rollback-fixtures'
$fixture=Join-Path $lab ('isolated-'+[Guid]::NewGuid().ToString('N'))
$backup=Join-Path $fixture 'backup\program'
$live=Join-Path $fixture 'live\PickDone'
$user=Join-Path $fixture 'user-data'
New-Item -ItemType Directory -Path $backup,$live,$user -Force|Out-Null
[IO.File]::WriteAllText((Join-Path $backup 'PickDone.exe'),'SAFE_OLD_FAKE')
[IO.File]::WriteAllText((Join-Path $backup 'resource.txt'),'SAFE_RESOURCE')
[IO.File]::WriteAllText((Join-Path $live 'PickDone.exe'),'CORRUPT_NEW_FAKE')
[IO.File]::WriteAllText((Join-Path $live 'resource.txt'),'CORRUPT_RESOURCE')
[IO.File]::WriteAllText((Join-Path $user 'todos.db'),'PRESERVE_USER_DATA')
$good=(Get-FileHash (Join-Path $backup 'PickDone.exe') -Algorithm SHA256).Hash
$bad='0'*64
function Invoke-Restore([string]$hash,[string]$name){
 $stdout=Join-Path $fixture ($name+'.out')
 $stderr=Join-Path $fixture ($name+'.err')
 $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script,
 '-BackupProgram',$backup,'-InstalledExe',(Join-Path $live 'PickDone.exe'),
 '-ExpectedBackupExeSha256',$hash,'-TestIsolation')
 $p=Start-Process -FilePath 'powershell.exe' -ArgumentList $args -PassThru -Wait -RedirectStandardOutput $stdout -RedirectStandardError $stderr
 return [pscustomobject]@{code=$p.ExitCode;out=(Get-Content $stdout -Raw -ErrorAction SilentlyContinue);err=(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)}
}
$refused=Invoke-Restore $bad 'invalid-hash'
if($refused.code -eq 0 -or $refused.err -notmatch 'Backup program hash mismatch'){throw 'Bad archive hash was not rejected'}
if([IO.File]::ReadAllText((Join-Path $live 'PickDone.exe')) -ne 'CORRUPT_NEW_FAKE'){throw 'Rejected archive mutated current install'}
$valid=Invoke-Restore $good 'valid'
if($valid.code -ne 0){throw ('Valid rollback failed: '+$valid.err)}
$json=$valid.out|ConvertFrom-Json
if(-not $json.ok -or -not $json.backupRetained){throw 'Restore did not report complete'}
if([IO.File]::ReadAllText((Join-Path $live 'PickDone.exe')) -ne 'SAFE_OLD_FAKE'){throw 'Restored old binary mismatches'}
if([IO.File]::ReadAllText((Join-Path $live 'resource.txt')) -ne 'SAFE_RESOURCE'){throw 'Restored resources mismatch'}
if([IO.File]::ReadAllText((Join-Path $user 'todos.db')) -ne 'PRESERVE_USER_DATA'){throw 'User data mutated'}
$failed=@(Get-ChildItem (Split-Path $live -Parent) -Directory|Where-Object {$_.Name -like 'PickDone.FAILED-*'})
if($failed.Count -ne 1){throw ('Expected one failed install quarantine, got '+$failed.Count)}
if([IO.File]::ReadAllText((Join-Path $failed[0].FullName 'PickDone.exe')) -ne 'CORRUPT_NEW_FAKE'){throw 'Quarantined corrupt build mismatch'}
[pscustomobject]@{
 ok=$true;negativeHashRefusal=$true;programRestored=$true;
 brokenBuildRetained=$true;backupRetained=$true;userDataUnchanged=$true;
 fixture='private-isolated'
}|ConvertTo-Json -Compress
