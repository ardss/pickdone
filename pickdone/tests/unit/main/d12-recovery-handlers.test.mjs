/**
 * D12 main-recovery-handlers wave regressions.
 *
 * Sync-3: restoreSegmentsFromCriticalBackup reports per-segment success — index.js's plain-bak
 *   cleanup gate must be able to see that a NON-todo segment failed or was left unconsumed. The
 *   old restoreTasksFromCriticalBackup swallowed per-segment failures and returned only the
 *   todoState count, so a "restoredN > 0" recovery could delete todos.db.plain-bak (the only
 *   other copy) right after chips/filters/meta failed to import — irreversible loss.
 * Sync-4/Sync-17: recovery-pending sentinel. A healthy-header EMPTY todos.db with an unconsumed
 *   parseable critical backup (crash between re-init and restore = Sync-4; re-init failed so the
 *   jsonRestoreAllowed gate blocked the restore = Sync-17) used to answer 'transient' on every
 *   later boot — the user sat on an empty DB forever. With the sentinel present,
 *   attemptDbRecovery quarantines the empty shell and replays the JSON restore.
 *
 * Run: node --test tests/unit/main/d12-recovery-handlers.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbRecovery = require('../../../src/main/dbRecovery.cjs')

/** Fresh sandbox: a FRESH parent per test — criticalBackupPath prefers <parent>/pickdone-backups
 *  and must never accidentally see a real backup outside the sandbox. */
function sandbox () {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-recovery-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud)
  return ud
}

/** Write a critical backup with a healthy todoState and a BROKEN filterState payload
 *  (a torn/invalid JSON string: parseSegment recovers {} → 0 rows imported). */
function writeBackupWithBrokenFilter (ud) {
  const backup = {
    backup: {
      todoState: JSON.stringify({ todoList: [{ taskId: 't1', title: 'x' }], recycleList: [] }),
      // torn segment: existed at write time, died mid-write — the exact Sync-3 scene
      filterState: '{"list": [{"id": "f1"'
    }
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
}

/* ---------------- Sync-3: per-segment success report ---------------- */

test('Sync-3: a failed non-todo segment is REPORTED while todoState still imports', () => {
  const ud = sandbox()
  writeBackupWithBrokenFilter(ud)
  const tasks = []
  const r = dbRecovery.restoreSegmentsFromCriticalBackup(ud, list => tasks.push(...list), null, null, {
    filterPutMany: () => {} // the callback exists (as in index.js) — the torn payload is what fails
  })
  assert.equal(r.tasks, 1, 'todoState must still import its row')
  assert.deepEqual(tasks.map(t => t.taskId), ['t1'])
  assert.ok(r.unconsumedSegments.includes('filterState'),
    'red before the fix: the swallowed per-segment failure was invisible to the caller')
  assert.equal(r.proved, false, 'a restore that left a segment unconsumed must NOT count as proved')
})

test('Sync-3: a fully-consumed backup reports proved=true', () => {
  const ud = sandbox()
  const backup = {
    backup: {
      todoState: JSON.stringify({ todoList: [{ taskId: 't1' }], recycleList: [] }),
      filterState: JSON.stringify({ list: [{ id: 'f1', name: 'n' }] })
    }
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
  const r = dbRecovery.restoreSegmentsFromCriticalBackup(ud, () => {}, null, null, {
    filterPutMany: rows => rows
  })
  assert.equal(r.tasks, 1)
  assert.equal(r.imported, 2)
  assert.deepEqual(r.failedSegments, [])
  assert.deepEqual(r.unconsumedSegments, [])
  assert.equal(r.proved, true)
})

test('Sync-3: an importer that fails internally leaves the segment unconsumed and vetoes proved', () => {
  const ud = sandbox()
  const backup = {
    backup: {
      todoState: JSON.stringify({ todoList: [{ taskId: 't1' }], recycleList: [] }),
      planState: JSON.stringify({ chips: [{ id: 'p1', day: 'd', mm: 1 }] })
    }
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify(backup))
  // the plan importer swallows the write failure and reports 0 — the segment payload existed but
  // nothing was imported, which is exactly the "unconsumed" case the proved gate must catch
  const r = dbRecovery.restoreSegmentsFromCriticalBackup(ud, () => {}, null, null, {
    planPutMany: () => { throw new Error('bus dead') }
  })
  assert.deepEqual(r.failedSegments, [])
  assert.ok(r.unconsumedSegments.includes('planState'),
    'red before the fix: a failed segment import was invisible (old return: task count only)')
  assert.equal(r.proved, false)
  assert.equal(r.tasks, 1, 'the healthy segment still imports')
})

test('Sync-3: legacy shim still returns the bare task count', () => {
  const ud = sandbox()
  writeBackupWithBrokenFilter(ud)
  const n = dbRecovery.restoreTasksFromCriticalBackup(ud, () => {})
  assert.equal(n, 1, 'historical callers/tests read the task count')
})

test('Sync-3: a corrupt backup file proves nothing', () => {
  const ud = sandbox()
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{not json')
  const r = dbRecovery.restoreSegmentsFromCriticalBackup(ud, () => {})
  assert.equal(r.tasks, 0)
  assert.equal(r.imported, 0)
  assert.equal(r.proved, false)
})

/* ---------------- Sync-4/Sync-17: recovery-pending sentinel ---------------- */

test('Sync-4/17: sentinel + healthy-header EMPTY db + parseable JSON → JSON restore replay', () => {
  const ud = sandbox()
  writeBackupWithBrokenFilter(ud) // parseable whole-file JSON with a usable todoState
  // the empty shell: a valid SQLite-header db with no user data (re-init product)
  const dbPath = path.join(ud, 'todos.db')
  fs.writeFileSync(dbPath, Buffer.from('SQLite format 3\x00' + '.'.repeat(32), 'binary'))
  // no sentinel: the healthy-header guard must still stand (conservative baseline)
  const before = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(before.source, 'transient', 'without the sentinel a healthy header is never renamed')
  assert.equal(fs.existsSync(dbPath), true, 'baseline: the db file survives')
  // with the sentinel: the empty shell is quarantined and the JSON replay is armed
  assert.equal(dbRecovery.markRecoveryPending(ud, { reason: 'json-restore-blocked' }), true)
  const after = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(after.source, 'json',
    'red before the fix: source was transient forever, the snapshot was never replayed')
  assert.equal(fs.existsSync(dbPath), false, 'the empty shell was quarantined aside')
})

test('Sync-4/17: sentinel without a parseable JSON does NOT bypass the healthy-header guard', () => {
  const ud = sandbox()
  fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.from('SQLite format 3\x00' + '.'.repeat(32), 'binary'))
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{torn')
  assert.equal(dbRecovery.markRecoveryPending(ud, {}), true)
  const r = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(r.source, 'transient', 'no usable snapshot → no replay, guard stays conservative')
})

test('Sync-4/17: sentinel lifecycle round-trip (mark/has/clear)', () => {
  const ud = sandbox()
  assert.equal(dbRecovery.hasRecoveryPending(ud), false)
  dbRecovery.markRecoveryPending(ud, { reason: 'json-restore-unconsumed' })
  assert.equal(dbRecovery.hasRecoveryPending(ud), true)
  const raw = JSON.parse(fs.readFileSync(dbRecovery.recoveryPendingPath(ud), 'utf8'))
  assert.equal(raw.reason, 'json-restore-unconsumed')
  dbRecovery.clearRecoveryPending(ud)
  assert.equal(dbRecovery.hasRecoveryPending(ud), false)
})
