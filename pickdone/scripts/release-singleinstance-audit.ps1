# Release single-instance / autostart audit (S7 #224). READ-ONLY: queries processes,
# registry Run keys and scheduled tasks. Never writes, never stops, never registers.
# Mirrors the A-machine facts recorded in .wt-int2/DELIVERY-STATE.md:
#   - PickDoneStart = logon trigger ONLY (not a watchdog, no restart-on-failure)
#   - HKCU Run must have NO pickdone entry
#   - running PickDone procs should resolve to a single install root (one Electron
#     instance = ~4 processes: main + gpu + 2 renderers/utility)
# Exit 0 = findings match expected semantics; exit 1 = drift (each red printed).

$ErrorActionPreference = 'SilentlyContinue'
$reds = @()
$notes = @()

# --- 1. Running PickDone processes: group by image path (version-root uniqueness) ---
$procs = Get-Process PickDone -ErrorAction SilentlyContinue
$roots = @{}
foreach ($p in $procs) {
  if ($p.Path) { $root = Split-Path (Split-Path $p.Path -Parent) -Parent; $roots[$root] = 1 + [int]($roots[$root]) }
}
if ($procs) {
  $notes += "processes=$($procs.Count) roots=$((@($roots.Keys)).Count) [$((@($roots.Keys)) -join ', ')]"
  if ((@($roots.Keys)).Count -gt 1) { $reds += "MULTI-ROOT: PickDone processes resolve to $((@($roots.Keys)).Count) install roots: $((@($roots.Keys)) -join ' | ')" }
} else {
  $notes += 'processes=0 (no PickDone running)'
}

# --- 2. HKCU / HKLM Run autostart entries (must have NO pickdone entry) ---
foreach ($rk in 'HKCU:Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:Software\Microsoft\Windows\CurrentVersion\Run') {
  $props = Get-ItemProperty $rk -ErrorAction SilentlyContinue
  if ($props) {
    foreach ($prop in $props.PSObject.Properties) {
      if ($prop.Name -notlike 'PS*') {
        $isPick = ($prop.Name -match 'PickDone') -or ($prop.Value -match 'PickDone')
        if ($isPick) {
          $reds += "RUN-ENTRY: $rk\$($prop.Name) = $($prop.Value)"
        } else {
          $notes += "run: $($rk.Split(':')[0])\$($prop.Name) (unrelated)"
        }
      }
    }
  }
}

# --- 3. Scheduled tasks: PickDone* or executing a PickDone binary ---
$tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  ($_.TaskName -match 'PickDone') -or (@($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -match 'PickDone')
}
foreach ($t in $tasks) {
  $acts = (@($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join '; ')
  $trigs = (@($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ',')
  $isLogonOnly = ($trigs -match 'LogonTrigger') -and ($trigs -notmatch 'BootTrigger|TimeTrigger|CalendarTrigger|EventTrigger')
  $isAppBinary = ($acts -match 'PickDone(\\.*)?(\s|$)') -and ($acts -notmatch 'Drill|SyncV2')
  $notes += "task: $($t.TaskPath)$($t.TaskName) state=$($t.State) triggers=$trigs action=$acts"
  if ($isAppBinary -and -not $isLogonOnly) {
    $reds += "TASK-SEMANTICS: $($t.TaskPath)$($t.TaskName) references the app binary but has non-logon triggers ($trigs) — watchdog/interval semantics are NOT expected for PickDoneStart"
  }
  if ($t.State -ne 'Disabled' -and $acts -match 'Drill|SyncV2-Watch') {
    $notes += "task-unrelated-watch: $($t.TaskName) is enabled but does not execute the app binary (documented as unrelated)"
  }
}

# --- 4. Report ---
Write-Host '=== release-singleinstance-audit (read-only) ==='
foreach ($n in $notes) { Write-Host "  [note] $n" }
foreach ($r in $reds) { Write-Host "  [RED] $r" }
if ($reds.Count -gt 0) { Write-Host "FAIL: $($reds.Count) drift finding(s)"; exit 1 }
Write-Host 'PASS: single-instance/autostart semantics match expected model'
exit 0
