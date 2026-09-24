/* Regression tests 2026-09-25 (LAN sync conflict-backup + sync-layer fixes):
 *   P0  entity:id conflict backups (B16, `metaConflictBackup.<entity>:<id>.<ts36>` with the RAW
 *       ROW as value) restore INTO THE NATIVE TABLE via the manifest-derived bulk upsert op —
 *       previously the restore went through setMeta, db.js's String(v) wrote '[object Object]'
 *       into meta, the unique lost row was never recovered, and the backup key was then deleted.
 *       Also: list preview JSON-summarizes object values (was '[object Object]' for every entity
 *       backup); backup keys stay machine-local (no oplog pollution).
 *   P2  planDeleteTask/planDeleteTaskDay are idempotent (`AND deleted=0`): a repeat delete must
 *       not re-stamp deletedAt nor mint another oplog tombstone pointer.
 *   P1  db-sync-ops reset() clears only the DYNAMIC layer — statically-registered getMetaMany
 *       survives (previously 'sync op unavailable' forever after reset).
 * Run: node --test tests/unit/lan-sync/conflict-backup-entity-restore-20260925.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../../../src/main/db.js')
const scb = require('../../../src/main/sync-conflict-backups.js')
const syncOps = require('../../../src/main/db-sync-ops.js')
const { isMachineLocalMetaKey } = require('../../../src/main/sync-apply.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cba-restore-'))
const BACKUP_PREFIX = 'metaConflictBackup.'

test('P0: plan:chip backup restores the ROW into plan_chips — no [object Object] meta, backup consumed, oplog carries the plan pointer', () => {
  const dir = tmp()
  db.init(dir)
  // Seed a task + the peer-winning chip; the LOCAL loser chip is backed up by the apply path as
  // metaConflictBackup.plan:<id>.<ts36> with the raw row (hydrateRow shape) as the value.
  db.call('upsert', { taskId: 'cba_task_1', taskContent: 'host task' })
  const lostChip = { id: 'pl_cba_1', taskId: 'cba_task_1', day: '2026-09-25', mm: '09:30', sort: 2, updatedAt: 1700000000000 }
  const backupKey = BACKUP_PREFIX + 'plan:pl_cba_1.abc'
  db.call('setMeta', [backupKey, JSON.stringify({ key: 'plan:pl_cba_1', value: { ...lostChip, conflictOf: 'pl_cba_1', conflictAt: 1700000000000 }, lostAt: 1700000001000 })])

  const ops = scb.ops(() => (op, p) => db.call(op, p))

  // list: object-value backups render as readable JSON, never '[object Object]' (发现12)
  const listed = ops.syncConflictBackupsList().find(b => b.key === backupKey)
  assert.ok(listed, 'backup is listed')
  assert.equal(listed.originalKey, 'plan:pl_cba_1')
  assert.ok(listed.preview.includes('"mm":"09:30"'), 'preview is readable JSON of the lost row: ' + listed.preview)
  assert.ok(!listed.preview.includes('[object Object]'), 'preview must not be [object Object]')

  const oplogBefore = db.call('syncOplogSince', { sinceSeq: 0, limit: 100000 }).filter(r => r.entity === 'plan').length
  const r = ops.syncConflictBackupRestore({ key: backupKey })
  assert.equal(r.ok, true)
  assert.equal(r.key, 'plan:pl_cba_1')
  assert.equal(r.entity, 'plan')

  // the lost row is back in its NATIVE table (upsert resurrects), not in meta
  const restored = db.call('planAll').find(c => c.id === 'pl_cba_1')
  assert.ok(restored, 'plan chip restored into plan_chips')
  assert.equal(restored.day, '2026-09-25')
  assert.equal(restored.mm, '09:30')
  assert.equal(restored.updatedAt, 1700000000000, 'the loser LWW age is preserved by the restore')
  const metaVal = db.call('getMeta', 'plan:pl_cba_1')
  assert.equal(metaVal, null, 'nothing written under the entity:id meta key')
  assert.ok(!db.call('listMetaKeys').some(k => String(db.call('getMeta', k)) === '[object Object]'), 'no [object Object] anywhere in meta')
  assert.equal(db.call('getMeta', backupKey), null, 'consumed backup key deleted')

  // the restored row is oplog-captured like a local edit (syncs to peers); the backup key
  // deletion is machine-local (metaConflictBackup.* in isMachineLocalMetaKey) and must NOT
  // surface as a syncable meta pointer.
  const planPtrs = db.call('syncOplogSince', { sinceSeq: 0, limit: 100000 }).filter(r2 => r2.entity === 'plan')
  assert.equal(planPtrs.length, oplogBefore + 1, 'restore lands as one plan oplog delta')
  assert.ok(isMachineLocalMetaKey(backupKey), 'metaConflictBackup.plan:* stays machine-local (never syncs)')
  assert.ok(!db.call('syncOplogSince', { sinceSeq: 0, limit: 100000 }).some(r2 => r2.entity === 'meta' && r2.entityId === backupKey), 'backup key never entered the oplog')
})

test('P0: meta-key backups keep the meta restore path (re-backup live value, consume backup)', () => {
  const dir = tmp()
  db.init(dir)
  db.call('setMeta', ['metaConflictBackup.someKey.k', JSON.stringify({ key: 'someKey', value: '{"lost":1}', lostAt: 1 })])
  db.call('setMeta', ['someKey', '{"live":2}'])
  const ops = scb.ops(() => (op, p) => db.call(op, p))
  const r = ops.syncConflictBackupRestore({ key: 'metaConflictBackup.someKey.k' })
  assert.deepEqual(r, { ok: true, key: 'someKey' })
  assert.equal(db.call('getMeta', 'someKey'), '{"lost":1}', 'lost meta value restored')
  assert.ok([...db.call('listMetaKeys')].some(k => k.startsWith('metaConflictBackup.someKey.')), 'previous live value re-backed-up (reversible)')
})

test('P0: malformed entity backup payload (non-object value) throws without mutating anything', () => {
  const dir = tmp()
  db.init(dir)
  db.call('setMeta', ['metaConflictBackup.plan:pl_x.k', JSON.stringify({ key: 'plan:pl_x', value: 'just-a-string', lostAt: 1 })])
  const ops = scb.ops(() => (op, p) => db.call(op, p))
  assert.throws(() => ops.syncConflictBackupRestore({ key: 'metaConflictBackup.plan:pl_x.k' }), /not a row object/)
  assert.equal(db.call('getMeta', 'metaConflictBackup.plan:pl_x.k') != null, true, 'backup untouched on failure')
  assert.equal(db.call('planAll').some(c => c.id === 'pl_x'), false, 'no junk row created')
})

test('P2: repeat planDeleteTask does not re-stamp deletedAt nor mint a new oplog tombstone pointer', () => {
  const dir = tmp()
  db.init(dir)
  db.call('upsert', { taskId: 'cba_del_1', taskContent: 'to delete' })
  db.call('planAddMany', [{ id: 'pl_del_1', taskId: 'cba_del_1', day: '2026-09-25', mm: '10:00', updatedAt: 1700000000000 }])
  const oplogLen = () => db.call('syncOplogSince', { sinceSeq: 0, limit: 100000 }).length

  assert.equal(db.call('planDeleteTask', 'cba_del_1'), true)
  const afterFirst = oplogLen()
  const chip = db.call('planAll').find(c => c.id === 'pl_del_1')
  assert.equal(chip, undefined, 'chip deleted from live view')

  db.call('planDeleteTask', 'cba_del_1') // repeat delete: previously re-stamped now() + new oplog seq
  assert.equal(oplogLen(), afterFirst, 'repeat delete logs NO new oplog entry')

  db.call('planDeleteTaskDay', { taskId: 'cba_del_1', day: '2026-09-25' })
  assert.equal(oplogLen(), afterFirst, 'repeat planDeleteTaskDay also logs no new oplog entry')
})

test('P1: db-sync-ops reset() keeps the statically-registered getMetaMany dispatchable', () => {
  syncOps.reset()
  // static op survives reset (previously threw 'sync op unavailable' forever after)
  assert.doesNotThrow(() => syncOps.dispatch('getMetaMany', ['whatever']))
  // dynamic ops are still cleared: a sync-only op is unavailable until initLanSync registers it
  assert.throws(() => syncOps.dispatch('syncGetStatus', {}), /sync op unavailable/)
  syncOps.register({ __probe: () => 42 })
  assert.equal(syncOps.dispatch('__probe', {}), 42, 'dynamic registration works again after reset')
  syncOps.reset()
  assert.throws(() => syncOps.dispatch('__probe', {}), /sync op unavailable/, 'reset clears dynamic handlers')
})
