/* sync-conflict-backups-tombstone-winner-no-rebackup (2026-09-26): when the CURRENT winner of a
 * conflict-backup restore was a TOMBSTONE (deleted row), ENTITY_CURRENT_ROW read it as null, no
 * reversible re-backup snapshot was minted, and the restore write silently erased the deletion
 * mark — contradicting the module's own C8 invariant ("snapshot the current winner BEFORE the
 * bulk write"). Now tombstone winners are snapshotted for category/setting (raw reads already
 * carry tombstones) and plan/filter (M3 tombstone-read fallback).
 * Real DB in fresh temp dirs (TODO_DB_DIR / TODO_USER_DATA_DIR) — never the real %APPDATA%.
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs; run directly:
 * node --test test/sync-conflict-backups.restore.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-tomb-win-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-tomb-win-ud-'))

const db = require('../src/main/db.js')
const backups = require('../src/main/sync-conflict-backups.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'scb-tomb-win-db-')))

const call = (op, p) => db.call(op, p)
const restoreOps = backups.ops(() => (op, p) => db.call(op, p))

const rebackupKeys = originalKey => (db.call('listMetaKeys') || [])
  .filter(k => k.startsWith('metaConflictBackup.' + originalKey + '.') && k !== sentinelKey(originalKey))
const sentinelKey = originalKey => 'metaConflictBackup.' + originalKey + '.sentinel-not-a-real-ts'

/** Mint a machine-local backup advertising `row` as the lost value of `originalKey`. */
function mintBackup (originalKey, row) {
  const key = sentinelKey(originalKey)
  db.call('setMeta', [key, JSON.stringify({ key: originalKey, value: row, lostAt: Date.now() })])
  return key
}

test('category: restoring over a TOMBSTONE winner mints a re-backup that records the deletion mark', () => {
  const catRow = { id: 901, userId: 840001, name: 'gone-later', color: '#123123', createdAt: 1, sort: 0, isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: 2 }
  db.call('upsertCategory', catRow)
  db.call('upsertCategory', { ...catRow, deleted: 1, delete: 1, deletedAt: 777, updatedAt: 778 })
  assert.ok(db.call('categoriesAllRows').find(r => String(r.id) === '901').deleted, 'precondition: winner is a tombstone')

  const key = mintBackup('category:901', { id: 901, name: 'restored-cat', color: '#456456', updatedAt: 999 })
  const r = restoreOps.syncConflictBackupRestore({ key })
  assert.deepEqual(r, { ok: true, key: 'category:901', entity: 'category' })

  // THE FIX (fails pre-fix): a re-backup exists whose value is the TOMBSTONE the restore overwrote
  const snaps = rebackupKeys('category:901')
  assert.equal(snaps.length, 1, 'the tombstone winner was re-backed up before the overwrite')
  const snap = JSON.parse(db.call('getMeta', snaps[0]))
  assert.equal(snap.key, 'category:901')
  assert.ok(snap.value.deleted, 'the snapshot records the deletion mark (recoverable)')
  assert.equal(Number(snap.value.deletedAt), 777)
  // the restore itself landed (winner overwritten by the lost row)
  assert.equal(db.call('categoriesAllRows').find(x => String(x.id) === '901').name, 'restored-cat')
  assert.equal(db.call('getMeta', key), null, 'the consumed backup key is deleted')
})

test('setting: restoring over a TOMBSTONE winner mints a re-backup (settingsRowsAll tombstones included)', () => {
  db.call('settingsRowPut', { key: 'habitsX', value: 'v0' })
  db.call('settingsRowDelete', { key: 'habitsX' })
  assert.ok(db.call('settingsRowsAll').find(r => r.key === 'habitsX').deleted, 'precondition: setting tombstone')

  const key = mintBackup('setting:habitsX', { key: 'habitsX', value: 'v-restored', updatedAt: 800 })
  const r = restoreOps.syncConflictBackupRestore({ key })
  assert.equal(r.ok, true)
  const snaps = rebackupKeys('setting:habitsX')
  assert.equal(snaps.length, 1, 'THE FIX: tombstone winner re-backed up')
  assert.ok(JSON.parse(db.call('getMeta', snaps[0])).value.deleted, 'tombstone recorded in the snapshot')
  assert.equal(db.call('settingsRowsAll').find(r => r.key === 'habitsX').value, 'v-restored', 'the lost value was restored into its native table')
})

test('plan: a live chip hidden by a tombstone winner is re-backed up through the M3 tombstone read (partial row — documented)', () => {
  db.call('upsert', { taskId: 'tp1', taskContent: 'x', createTime: 1, updateTime: 1 })
  db.call('planAddMany', [{ id: 'chipZ', taskId: 'tp1', day: '2026-09-26', mm: '10:00', updatedAt: 100 }])
  db.call('planRemoveIds', [{ id: 'chipZ', deletedAt: 555, updatedAt: 555 }])
  assert.equal(db.call('planAll').some(c => String(c.id) === 'chipZ'), false, 'precondition: chip is a tombstone (hidden from planAll)')

  // A full lost chip row would restore fine; what the fix guarantees is that the TOMBSTONE it
  // overwrites is recorded first (partial shape: id/updatedAt/deletedAt only).
  const key = mintBackup('plan:chipZ', { id: 'chipZ', taskId: 'tp1', day: '2026-09-26', mm: '11:30', updatedAt: 900 })
  const r = restoreOps.syncConflictBackupRestore({ key })
  assert.equal(r.ok, true)
  const snaps = rebackupKeys('plan:chipZ')
  assert.equal(snaps.length, 1, 'THE FIX: tombstone winner re-backed up via planTombstones fallback')
  const snap = JSON.parse(db.call('getMeta', snaps[0]))
  assert.equal(String(snap.value.id), 'chipZ')
  assert.equal(Number(snap.value.deletedAt), 555, 'the deletion stamps survive in the snapshot')
  assert.equal(db.call('planAll').find(c => String(c.id) === 'chipZ').mm, '11:30', 'the restore landed')
})
