# Release drill (S7 #224 / J4) — backup -> install -> launch -> read old data -> restart -> rollback -> verify.
# One-click scripted form of the manual steps recorded in the DELIVERY-STATE handoff
# (update-a-from-b.ps1 lineage), but ISOLATED: everything runs under -Root (default a
# timestamped dir under $env:TEMP). It NEVER touches a real install path, the real
# %APPDATA%\pickdone, or any scheduled task.
#
# Params (all REQUIRED, machine paths are passed in by the operator, never hardcoded):
#   -OldApp  source dir of the OLD build to stage as "currently installed" (read-only source)
#   -NewApp  source dir of the NEW candidate win-unpacked (read-only source)
#   -Root    isolated drill root
#
# Exit 0 = full J4 chain green; exit 1 = a step failed (evidence JSON says which).
param(
  [Parameter(Mandatory = $true)][string]$OldApp,
  [Parameter(Mandatory = $true)][string]$NewApp,
  [string]$Root = ''
)
$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Join-Path $env:TEMP ("pd-release-drill-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
foreach ($d in $OldApp, $NewApp) {
  if (-not (Test-Path "$d\PickDone.exe")) { Write-Host "FAIL: no PickDone.exe under $d"; exit 2 }
}
# hard guard: refuse to run if the drill root collides with a real path
foreach ($bad in "$env:APPDATA\pickdone", $OldApp, $NewApp) {
  $rb = ($Root.TrimEnd('\') + '\').ToLower()
  if ($rb.StartsWith(($bad.TrimEnd('\') + '\').ToLower())) { Write-Host "REFUSING: Root collides with real path $bad"; exit 2 }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$AppDir    = Join-Path $Root 'app'          # simulated install root (in-place replaced)
$UserData  = Join-Path $Root 'userdata'     # isolated userData (TODO_USER_DATA_DIR)
$BackupDir = Join-Path $Root 'backup'
$Ev        = [ordered]@{ root = $Root; oldApp = $OldApp; newApp = $NewApp; steps = @(); dbHashes = [ordered]@{} }
$script:exitCode = 0

function Step($name, $ok, $detail) {
  $Ev.steps += [ordered]@{ step = $name; ok = [bool]$ok; detail = $detail }
  Write-Host ("[{0}] {1}: {2}" -f ($(if ($ok) {'OK '} else {'RED'})), $name, $detail)
  if (-not $ok) { $script:exitCode = 1 }
}
function ExeVer($p) { (Get-Item $p).VersionInfo.FileVersion }
function DbHashes {
  # hash with FileShare ReadWrite — SQLite keeps todos.db open while the app runs
  $h = [ordered]@{}
  foreach ($f in 'todos.db', 'todos.db-wal', 'todos.db-shm', 'db.key') {
    $fp = Join-Path $UserData $f
    if (Test-Path $fp) {
      $fs = [System.IO.File]::Open($fp, 'Open', 'Read', 'ReadWrite')
      try { $sha = [System.Security.Cryptography.SHA256]::Create(); $h[$f] = ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '') } finally { $fs.Close() }
    }
  }
  return $h
}

function Stop-DrillApp {
  # kill ONLY PIDs whose image path lives under the drill root
  $mine = Get-Process PickDone -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($Root.ToLower()) }
  foreach ($p in $mine) { $null = $p.CloseMainWindow(); }
  Start-Sleep -Seconds 2
  foreach ($p in (Get-Process PickDone -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($Root.ToLower()) })) { Stop-Process -Id $p.Id -Force }
  if ($mine) { $mine | ForEach-Object { Wait-Process -Id $_.Id -ErrorAction SilentlyContinue -Timeout 10 } }
  return @($mine).Count
}

function Start-DrillApp($expectVersion) {
  $env:TODO_USER_DATA_DIR = $UserData
  $p = Start-Process -FilePath (Join-Path $AppDir 'PickDone.exe') -PassThru -WorkingDirectory $AppDir
  Start-Sleep -Seconds 10
  $alive = -not $p.HasExited
  $dbReady = (Test-Path (Join-Path $UserData 'todos.db')) -or (Test-Path (Join-Path $UserData 'todos.db-wal'))
  $log = Join-Path $UserData 'logs\main.log'
  $logTail = if (Test-Path $log) { (Get-Content $log -Tail 3) -join ' | ' } else { '(no log)' }
  $ver = ExeVer (Join-Path $AppDir 'PickDone.exe')
  $ok = $alive -and ($ver -eq $expectVersion)
  return @{ ok = $ok; pid = $p.Id; alive = $alive; dbReady = $dbReady; version = $ver; logTail = $logTail }
}

try {
  # ---- stage: copy OLD into the simulated install root; prep isolated userData ----
  New-Item -ItemType Directory -Force -Path $AppDir, $UserData | Out-Null
  Copy-Item "$OldApp\*" $AppDir -Recurse -Force
  Step 'stage-old' $true ("install root seeded from $OldApp, FileVersion " + (ExeVer (Join-Path $AppDir 'PickDone.exe')))

  # ---- boot OLD -> creates the "legacy" todos.db in isolated userData ----
  $r = Start-DrillApp (ExeVer (Join-Path $AppDir 'PickDone.exe'))
  Step 'boot-old' $r.ok ("pid=$($r.pid) ver=$($r.version) dbReady=$($r.dbReady) log='$($r.logTail)'")
  Stop-DrillApp | Out-Null
  Start-Sleep -Seconds 1
  $Ev.dbHashes.preSwap = DbHashes
  Step 'hash-old-db' (($Ev.dbHashes.preSwap.Keys.Count -gt 0)) ("todos.db sha256=" + ($Ev.dbHashes.preSwap['todos.db']))

  # ---- backup: app + userData -> backup dir (J4 leg 1) ----
  New-Item -ItemType Directory -Force -Path "$BackupDir\app", "$BackupDir\userdata" | Out-Null
  Copy-Item "$AppDir\*" "$BackupDir\app" -Recurse -Force
  Copy-Item "$UserData\*" "$BackupDir\userdata" -Recurse -Force
  Step 'backup' ((Test-Path "$BackupDir\app\PickDone.exe") -and (Test-Path "$BackupDir\userdata\todos.db")) "backup at $BackupDir"

  # ---- install: in-place same-root replace with the NEW candidate (J4 leg 2) ----
  Copy-Item "$NewApp\*" $AppDir -Recurse -Force
  $newVer = ExeVer (Join-Path $AppDir 'PickDone.exe')
  $candVer = ExeVer (Join-Path $NewApp 'PickDone.exe')
  $oldVerBk = ExeVer "$BackupDir\app\PickDone.exe"
  $ok = ($newVer -eq $candVer)
  $note = "install root now FileVersion $newVer (candidate=$candVer, previous=$oldVerBk)"
  if ($oldVerBk -eq $candVer) { $note += ' [note: old and candidate are the SAME version locally - version-differentiation not available on this machine; replacement verified by candidate-version equality]' }
  Step 'install' $ok $note

  # ---- launch NEW + read old data (J4 legs 3-4) ----
  $r = Start-DrillApp $newVer
  $Ev.dbHashes.afterUpgrade = DbHashes
  Step 'boot-new' $r.ok ("pid=$($r.pid) ver=$($r.version) dbReady=$($r.dbReady)")
  Step 'read-old-data' (($Ev.dbHashes.afterUpgrade['todos.db'] -eq $Ev.dbHashes.preSwap['todos.db']) -and $r.dbReady) "todos.db hash unchanged across upgrade: $($Ev.dbHashes.afterUpgrade['todos.db'])"
  # ---- restart leg (J4 leg 5) ----
  Stop-DrillApp | Out-Null
  Start-Sleep -Seconds 1
  $r = Start-DrillApp $newVer
  Step 'restart-new' $r.ok ("second boot ver=$($r.version) dbReady=$($r.dbReady)")
  Stop-DrillApp | Out-Null
  Start-Sleep -Seconds 1

  # ---- rollback: restore backup over the install root (J4 leg 6) ----
  Remove-Item "$AppDir\*" -Recurse -Force
  Copy-Item "$BackupDir\app\*" $AppDir -Recurse -Force
  Copy-Item "$BackupDir\userdata\*" $UserData -Recurse -Force
  $oldVer = ExeVer (Join-Path $AppDir 'PickDone.exe')
  Step 'rollback' ($oldVer -eq (ExeVer "$BackupDir\app\PickDone.exe")) "install root restored to FileVersion $oldVer"

  # ---- post-rollback verify (J4 leg 7) ----
  $r = Start-DrillApp $oldVer
  $Ev.dbHashes.afterRollback = DbHashes
  Step 'boot-rolled-back' $r.ok ("pid=$($r.pid) ver=$($r.version) dbReady=$($r.dbReady)")
  Step 'db-hash-post-rollback' ($Ev.dbHashes.afterRollback['todos.db'] -eq $Ev.dbHashes.preSwap['todos.db']) ("todos.db sha256=" + $Ev.dbHashes.afterRollback['todos.db'])
  Stop-DrillApp | Out-Null
} finally {
  $Ev.exitCode = $script:exitCode
  $Ev.finished = (Get-Date -Format o)
  $evPath = Join-Path $Root 'drill-evidence.json'
  $Ev | ConvertTo-Json -Depth 6 | Set-Content $evPath -Encoding UTF8
  Write-Host "evidence: $evPath"
}
exit $script:exitCode
