/**
 * Regression: restore-degraded-segments-marker-never-consumed (2026-10-02, P2).
 *
 * Sync-13's contract ("so a restore (and a human) can tell", todoBackup.js) was half-built: the
 * WRITER put degradedSegments into every degraded dump, but no reader existed — neither the UI
 * restore (SettingsDataTab.applyRestoreDump) nor the startup restore
 * (dbRecovery.restoreSegmentsFromCriticalBackup) read the field (probe-verified absent from the
 * restore result). Now describeDegradedSegments renders the marker and applyRestoreDump surfaces
 * a NON-BLOCKING warning naming the missing surfaces (planState → schedule chips; metaState →
 * repeat rules/estimates/project meta). The main-process side is pinned in
 * tests/unit/main/d12-recovery-handlers.test.mjs.
 *
 * Run: node --test tests/unit/renderer/restore-degraded-segments-reader.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + Date.now())
const dataTab = readFileSync(path.join(ROOT, 'renderer/js/components/settings/SettingsDataTab.vue'), 'utf8')

test('reader exists: describeDegradedSegments annotates each missing surface (red before the fix: no reader at all)', async () => {
  const { describeDegradedSegments, DEGRADED_SEGMENT_HINTS } = await importSrc('renderer/js/store/helpers/todoBackup.js')
  assert.equal(describeDegradedSegments(undefined), '', 'clean or pre-Sync-13 dump: no marker, no warning')
  assert.equal(describeDegradedSegments([]), '')
  const s = describeDegradedSegments(['planState', 'metaState'])
  assert.match(s, /planState/)
  assert.match(s, /schedule chips/, 'the human-facing hint names what planState carries')
  assert.match(s, /metaState/)
  assert.match(s, /repeat rules\/estimates\/project meta/, 'the human-facing hint names what metaState carries')
  assert.ok(DEGRADED_SEGMENT_HINTS.planState && DEGRADED_SEGMENT_HINTS.metaState)
})

test('applyRestoreDump consumes the marker: warning is surfaced in addition to reportRestoreResult, and is NOT a gate', () => {
  // source-shape assertions (the component cannot be mounted in plain node — same harness as
  // tests/unit/components/dw2-settings-data-tab-fixes.test.mjs):
  // 1. the dump's degradedSegments field reaches the shared renderer,
  assert.match(dataTab, /describeDegradedSegments\(b\.degradedSegments\)/,
    'red before the fix: nothing in the component read b.degradedSegments')
  // 2. it produces a non-blocking $message.warning (now via the backupDegradedWarn i18n key,
  //    maint 2026-10-09: the hardcoded English string broke the zh locale),
  assert.match(dataTab, /\$message\.warning\(this\.\$t\('statsE\.SettingsModal\.backupDegradedWarn'/, 'the warning is non-blocking and names the missing segments')
  // 3. it sits INSIDE applyRestoreDump and never pushes into `failed` (honesty surface, not a gate).
  const fn = dataTab.match(/async applyRestoreDump \(dump\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'applyRestoreDump found')
  assert.match(fn[0], /describeDegradedSegments\(b\.degradedSegments\)/)
  assert.ok(!/failed\.push\('degraded'\)/.test(fn[0]) && !/degraded.*failed\.push/.test(fn[0]),
    'a degraded marker must never fail the restore')
})
