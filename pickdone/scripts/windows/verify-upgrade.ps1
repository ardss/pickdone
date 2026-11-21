[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ExpectedExe,
  [string]$ExpectedVersion='',
  [string[]]$KnownOldRoots=@()
)
$ErrorActionPreference='Stop'
$exe=[IO.Path]::GetFullPath($ExpectedExe)
if(-not(Test-Path -LiteralPath $exe -PathType Leaf)){throw 'Expected PickDone executable is missing'}
if([IO.Path]::GetFileName($exe) -ne 'PickDone.exe'){throw 'Unexpected application name'}
$version=(Get-Item $exe).VersionInfo.FileVersion
$processes=@(Get-CimInstance Win32_Process -Filter "name='PickDone.exe'")
$roots=@($processes|Where-Object {$_.ExecutablePath}|Select-Object -ExpandProperty ExecutablePath -Unique)
$others=@($roots|Where-Object {![string]::Equals($_,$exe,[StringComparison]::OrdinalIgnoreCase)})
$activeTaskStarts=@()
foreach($t in @(Get-ScheduledTask -ErrorAction SilentlyContinue)){
 if([string]$t.State -eq 'Disabled'){continue}
 foreach($a in @($t.Actions)){
  $cmd=($a.Execute+' '+$a.Arguments).Trim()
  if($cmd -match '(?i)PickDone\.exe|pickdone-drill[\\/]start\.bat'){$activeTaskStarts+=@{task=$t.TaskName;action=$cmd}}
 }
}
$alternateStarts=@($activeTaskStarts|Where-Object{$_.action -notmatch [regex]::Escape($exe)})
$knownOldPresent=@($KnownOldRoots|Where-Object{Test-Path (Join-Path $_ 'PickDone.exe')})
$uninstall=@()
$regRoots=@('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
foreach($r in $regRoots){
 foreach($item in @(Get-ChildItem $r -ErrorAction SilentlyContinue)){
  try{$v=Get-ItemProperty $item.PSPath;if($v.DisplayName -like 'PickDone*'){$uninstall+=@{name=$v.DisplayName;version=$v.DisplayVersion}}}catch{}
 }
}
$data=Join-Path $env:APPDATA 'PickDone'
$ok=($others.Count -eq 0 -and $alternateStarts.Count -eq 0 -and $knownOldPresent.Count -eq 0 -and (!$ExpectedVersion -or $version -eq $ExpectedVersion) -and (Test-Path (Join-Path $data 'todos.db')) -and (Test-Path (Join-Path $data 'db.key')))
[pscustomobject]@{
 ok=$ok;actualVersion=$version;runningExecutableRoots=$roots.Count;
 unexpectedRunningRoots=$others.Count;enabledOldStartTasks=$alternateStarts.Count;
 oldRootsStillOnDisk=$knownOldPresent.Count;registryEntries=$uninstall.Count;
 userDatabasePresent=(Test-Path (Join-Path $data 'todos.db'));
 userKeyPresent=(Test-Path (Join-Path $data 'db.key'))
}|ConvertTo-Json -Compress
if(-not $ok){exit 2}
