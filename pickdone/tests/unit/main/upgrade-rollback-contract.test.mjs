import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const scripts = path.resolve(import.meta.dirname, '../../../scripts/windows')
const read = name => readFileSync(path.join(scripts, name), 'utf8')

test('in-place upgrade fails closed without a verified rollback helper before touching programs', () => {
  const src = read('deploy-in-place.ps1')
  const marker = src.indexOf('Rollback helper missing; refuse to start any installation')
  const stop = src.indexOf('Stop-Process -Id $one.ProcessId')
  const installer = src.indexOf("$proc=Start-Process -FilePath $installer")
  assert.ok(marker > 0 && marker < stop && stop < installer)
  assert.match(src, /ExpectedInstallerSha256\.ToUpperInvariant\(\)/)
  assert.match(src, /Version downgrade or reinstall is blocked by default/)
})

test('upgrade automatically invokes program restore only after the installer was attempted', () => {
  const src = read('deploy-in-place.ps1')
  assert.match(src, /\$installAttempted=\$true/)
  assert.match(src, /if\(-not \$installAttempted\)\{throw\}/)
  assert.match(src, /-BackupProgram \(Join-Path \$backup 'program'\) -InstalledExe \$exe/)
  assert.match(src, /-ExpectedBackupExeSha256 \$backupExeHash/)
  assert.match(src, /UPGRADE_FAILED:/)
  assert.match(src, /USER_DATA_CHANGED_PRESERVED_FOR_MANUAL_RECOVERY/)
  assert.match(src, /if\(\$dataUnchanged -and \$shouldRestart\)/)
})

test('rollback swaps program trees but not user data, protects original and quarantines failing build', () => {
  const src = read('restore-program.ps1')
  assert.match(src, /Copy-Item -LiteralPath \$BackupProgram -Destination \$stage/)
  assert.match(src, /Move-Item -LiteralPath \$root -Destination \$failed/)
  assert.match(src, /Move-Item -LiteralPath \$stage -Destination \$root/)
  assert.match(src, /Post-restore executable integrity mismatch/)
  assert.match(src, /backupRetained=/)
  assert.match(src, /liveUserDataUntouched=\$true/)
  assert.doesNotMatch(src, /Remove-Item[^\n]*\$backupProgram/i)
  assert.doesNotMatch(src, /Copy-Item[^\n]*(todos\.db|db\.key|user-data)/i)
  assert.match(src, /TestIsolation restricted to rollback fixtures/)
})
