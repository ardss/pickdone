/**
 * W10 main-process fixes regression tests.
 *   1. P2 fix-util.js backupNameTs: the regex lacked the optional suffix group autoBackup.nameToTs
 *      got in the D17/D20-B4 fixes, so same-second collision names (auto-…-dup<n>.json) and CLI
 *      event names (evt-<reason>-…-<epochMs>.json) parsed to ts=0 → sorted oldest in the Settings
 *      restore list and run-auto-backup's dedup twin selection could pick a stale file. They must
 *      now parse to their BASE stamp (the dup→0 rule stays in autoBackup.rankTs's pruning layer).
 *   2. P3 handlers/system.js data:relocate success notice: the async dialog resolved into a modal
 *      that the 400ms relaunch timer destroyed before the user could read it. Source contract:
 *      showMessageBoxSync is called BEFORE the relaunch setTimeout.
 * Run: node --test tests/unit/main/w10-main-fixes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { backupNameTs, sortBackupNamesNewestFirst } = require_('../../../src/main/fix-util.js')

/* ---- fix 1: suffixed backup names parse to their base stamp ---- */

// W11 (2026-10-26): backupNameTs now parses stamps as LOCAL time, mirroring autoBackup.nameToTs —
// filename stamps are local time, so the pin switches from Date.UTC to the local-time constructor.
const BASE = new Date(2026, 9, 26, 12, 34, 56).getTime()

test('W10 1a: auto-…-dup<n>.json parses to its base stamp (was 0 before the fix)', () => {
  assert.equal(backupNameTs('auto-20261026-123456.json'), BASE)
  assert.equal(backupNameTs('auto-20261026-123456-dup2.json'), BASE)
  assert.equal(backupNameTs('auto-20261026-123456-dup11.json'), BASE)
})

test('W10 1b: evt-<reason>-…-<epochMs>.json parses to its base stamp (was 0 before the fix)', () => {
  assert.equal(backupNameTs('evt-cli-20261026-123456.json'), BASE)
  assert.equal(backupNameTs('evt-pre-sync-20261026-123456-1791014096000.json'), BASE)
  assert.equal(backupNameTs('evt-pre-import-20261026-123456-1791014096543.json'), BASE)
})

test('W10 1c: junk / malformed names still parse to 0', () => {
  assert.equal(backupNameTs('garbage.json'), 0)
  assert.equal(backupNameTs('auto-20261026.json'), 0)
  assert.equal(backupNameTs('auto-20261026-123456-.json'), 0) // empty suffix must not match
})

test('W10 1d: suffixed names sort newest-first (restore list + dedup twin selection)', () => {
  const names = [
    'evt-pre-sync-20261026-123456-1791014096000.json',
    'auto-20261026-123456-dup2.json',
    'auto-20261026-130000.json', // later same-day plain auto → newest
    'auto-20261025-010101.json' // previous day → oldest
  ]
  assert.deepEqual(sortBackupNamesNewestFirst(names), [
    'auto-20261026-130000.json',
    'evt-pre-sync-20261026-123456-1791014096000.json',
    'auto-20261026-123456-dup2.json',
    'auto-20261025-010101.json'
  ])
})

/* ---- fix 2: light source-contract on the data:relocate success notice ---- */

test('W10 2: system.js data:relocate uses showMessageBoxSync before the relaunch timer', () => {
  const src = fs.readFileSync(require_.resolve('../../../src/main/handlers/system.js'), 'utf8')
  const syncIdx = src.indexOf('showMessageBoxSync')
  const timerIdx = src.indexOf('app.relaunch')
  assert.ok(syncIdx !== -1, 'success notice must use dialog.showMessageBoxSync (sync dialog closes on OK)')
  assert.ok(src.indexOf('dialog.showMessageBox({ type: \'info\', title: i18n.mt(\'dataLocDoneTitle\')') === -1,
    'the old async showMessageBox notice (destroyed by the relaunch timer after 400ms) must be gone')
  assert.ok(syncIdx < timerIdx, 'the sync notice must be issued BEFORE the relaunch timer is scheduled')
})
