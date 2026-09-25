/* C8 (2026-09-25, domain-4 wave): entity conflict-backup restore is REVERSIBLE.
 * The entity branch of syncConflictBackupRestore used to overwrite the current winning row
 * WITHOUT re-backuping it — the meta branch re-backups the live value ("a restore is itself
 * reversible") but the entity restore destroyed the winner's only copy outside the table.
 * Now the current winner is snapshot RAW into a fresh backup key (same 20-per-key prune cap)
 * BEFORE the bulk overwrite, so: restore, then restore the minted backup, returns the row to
 * its pre-restore content.
 * Run: node --test tests/unit/lan-sync/d4-c8-entity-restore-reversible-20260925.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)

test('C8: restore, then restore the minted winner-backup, returns to the pre-restore state', () => {
  const db = require_('../../../src/main/db.js')
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'd4-c8-')))
  db.call('upsert', { taskId: 'c8_task', taskContent: 'host' })
  const BACKUP_PREFIX = 'metaConflictBackup.'
  // The local LOSER content of row pl_loss is backed up by the apply path; the PEER's newer
  // content of the SAME row id currently holds the table (LWW conflict = same id, two contents) —
  // the winner's only copy is that table row.
  const loser = { id: 'pl_loss', taskId: 'c8_task', day: '2026-09-25', mm: '09:00', sort: 1, updatedAt: 1700000000000 }
  const winner = { id: 'pl_loss', taskId: 'c8_task', day: '2026-09-25', mm: '17:30', sort: 9, updatedAt: 1700000005000 }
  db.call('planAddMany', [winner])
  const backupKey = BACKUP_PREFIX + 'plan:pl_loss.t0'
  db.call('setMeta', [backupKey, JSON.stringify({ key: 'plan:pl_loss', value: loser, lostAt: 1700000010000 })])

  const ops = require_('../../../src/main/sync-conflict-backups.js').ops(() => (op, p) => db.call(op, p))

  // Restore #1: the loser comes back AND the overwritten winner is re-backed-up first.
  const r1 = ops.syncConflictBackupRestore({ key: backupKey })
  assert.equal(r1.ok, true)
  assert.ok(db.call('planAll').find(c => c.id === 'pl_loss'), 'loser restored into the table')
  const winnerBackups = (db.call('listMetaKeys') || []).map(String).filter(k => k.startsWith(BACKUP_PREFIX + 'plan:pl_loss.') && k !== backupKey)
  assert.equal(winnerBackups.length, 1, 'restore #1 minted exactly one re-backup of the overwritten winner')
  const wb = JSON.parse(db.call('getMeta', winnerBackups[0]))
  assert.equal(wb.key, 'plan:pl_loss')
  assert.equal(wb.value.id, 'pl_loss')
  assert.equal(wb.value.sort, 9)
  assert.equal(wb.value.mm, '17:30', 'the winner row is snapshot RAW (not [object Object])')
  assert.equal(db.call('getMeta', backupKey), null, 'restore #1 consumed the original backup')

  // Restore #2 (of the minted backup): back to the pre-restore state.
  const r2 = ops.syncConflictBackupRestore({ key: winnerBackups[0] })
  assert.equal(r2.ok, true)
  const winRow = db.call('planAll').find(c => c.id === 'pl_loss' && c.mm === '17:30')
  assert.ok(winRow, 'the winner is back in the table — restore is reversible')
  assert.equal(winRow.mm, '17:30')
  assert.equal(winRow.sort, 9)
  const backAgain = (db.call('listMetaKeys') || []).map(String).filter(k => k.startsWith(BACKUP_PREFIX + 'plan:pl_loss.'))
  assert.equal(backAgain.length, 1, 'restore #2 re-backed-up the loser again (chain stays reversible)')
  const again = JSON.parse(db.call('getMeta', backAgain[0]))
  assert.equal(again.value.id, 'pl_loss')
  assert.equal(again.value.mm, '09:00')
})
