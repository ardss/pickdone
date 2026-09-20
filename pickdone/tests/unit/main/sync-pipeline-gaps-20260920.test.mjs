/* F2/F3 regression tests (sync pipeline gaps round, 2026-09-20) — real SQLite via src/main/db.js.
 *   F2: inbound category tombstones land (row-shape deleted:1 via upsertCategoryMany) with
 *       deletedAt/updatedAt preserved so a newer live re-add on the peer still wins.
 *   F3a: planAll carries updatedAt (LWW age known).
 *   F3b: filterList carries updatedAt.
 *   F3c: planMoveTask/planDeleteTask/planDeleteTaskDay log per-CHIP oplog pointers, not taskId.
 * Run: node --test tests/unit/main/sync-pipeline-gaps-20260920.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-gaps-')))

const planPointers = () => (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entity === 'plan')

test('F3a: planAll rows carry updatedAt and writes stamp it', () => {
  const [id] = db.call('planAddMany', [{ taskId: 'g_f3a', day: '2026-09-20', mm: '09:00', sort: 1 }])
  const row = db.call('planAll', {}).find(c => c.id === id)
  assert.ok('updatedAt' in row, 'planAll must SELECT updatedAt (sync LWW age)')
  assert.ok(row.updatedAt > 0)
  const before = row.updatedAt
  db.call('planUpdateChip', { id, day: '2026-09-21', mm: '10:00' })
  const after = db.call('planAll', {}).find(c => c.id === id)
  assert.ok(after.updatedAt > before, 're-timing a chip must advance its LWW age')
})

test('F3c: planMoveTask logs per-chip pointers (not the taskId)', () => {
  const ids = db.call('planAddMany', [
    { taskId: 'g_f3c', day: '2026-09-20', mm: '09:00' },
    { taskId: 'g_f3c', day: '2026-09-20', mm: '10:00' },
  ])
  const before = planPointers().length
  db.call('planMoveTask', { taskId: 'g_f3c', fromDay: '2026-09-20', toDay: '2026-09-25' })
  const ptrs = planPointers().slice(before)
  const logged = new Set(ptrs.map(p => p.entityId))
  for (const id of ids) assert.ok(logged.has(id), `moved chip ${id} must have its own oplog pointer`)
  assert.ok(!logged.has('g_f3c'), 'taskId must NOT be logged as a chip pointer (ghost tombstone on peers)')
})

test('F3c: planDeleteTask/planDeleteTaskDay log per-chip pointers', () => {
  const [d1, d2] = db.call('planAddMany', [
    { taskId: 'g_f3d', day: '2026-09-20', mm: '09:00' },
    { taskId: 'g_f3d', day: '2026-09-21', mm: '09:00' },
  ])
  db.call('planDeleteTaskDay', { taskId: 'g_f3d', day: '2026-09-20' })
  let logged = planPointers().filter(p => p.entityId === d1).length
  assert.ok(logged >= 1, 'day-delete pointer must be the chip id')
  assert.ok(!planPointers().some(p => p.entityId === 'g_f3d'), 'taskId must never appear as a chip pointer')
  db.call('planDeleteTask', 'g_f3d')
  logged = planPointers().filter(p => p.entityId === d2).length
  assert.ok(logged >= 2, 'task-delete pointer must be the remaining chip id (planAdd + delete)')
  assert.ok(!planPointers().some(p => p.entityId === 'g_f3d'))
})

test('F3b: filterList rows carry updatedAt', () => {
  const id = db.call('filterUpsert', { name: 'gapfilter', conds: { dateMode: 'all' }, sort: 0 })
  const f = db.call('filterList', {}).find(x => x.id === id)
  assert.ok(f && f.updatedAt > 0, 'filterList must expose updatedAt (sync LWW age)')
  const before = f.updatedAt
  db.call('filterUpsert', { id, name: 'gapfilter-renamed', conds: { dateMode: 'all' }, sort: 0 })
  const after = db.call('filterList', {}).find(x => x.id === id)
  assert.equal(after.name, 'gapfilter-renamed')
  assert.ok(after.updatedAt > before, 'renaming a filter must advance its LWW age')
})

test('F2: an inbound category tombstone deletes the local category, preserving ordering metadata', () => {
  const catId = 990001
  db.call('upsertCategory', { id: catId, name: 'ToDie', color: '#123456', sort: 1 })
  const live = db.call('getAllCategories', {}).find(c => c.categoryId === catId)
  assert.ok(live, 'category exists locally before the tombstone lands')
  // Same op the sync flush uses (upsertCategoryMany -> upsertCategory), row shape as the
  // sync-apply tombstone branch pushes it: deleted:1 + deletedAt/updatedAt from the peer row.
  db.call('upsertCategoryMany', [{ id: catId, deleted: 1, deletedAt: 777000, updatedAt: 777000 }])
  assert.equal(db.call('getAllCategories', {}).find(c => c.categoryId === catId), undefined, 'tombstone must delete the category')
  // Ordering metadata survives: re-tombstoning an already-tombstoned row must not re-stamp it,
  // and a NEWER live row (updatedAt > deletedAt) still wins on the peer round-trip.
  db.call('upsertCategoryMany', [{ id: catId, deleted: 1, deletedAt: 777000, updatedAt: 777000 }])
  db.call('upsertCategoryMany', [{ id: catId, name: 'Reborn', color: '#654321', sort: 1, deleted: 0, deletedAt: 0, updatedAt: 888000 }])
  const reborn = db.call('getAllCategories', {}).find(c => c.categoryId === catId)
  assert.ok(reborn && reborn.categoryName === 'Reborn', 'a newer live row (updatedAt 888000 > deletedAt 777000) must win')
})

test('F1 guard: the setMeta blob bridge must not re-stamp identical rows (fold cannot clobber backwards)', () => {
  // The blob fold goes through setMeta -> db-sync-schema bridge (mergeDoc -> putRow). putRow's
  // identical-content no-op is what keeps the fold from re-stamping a NEWER row backwards when
  // the folded value equals the row value.
  const settingPtrs = () => (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entity === 'setting')
  db.call('settingsRowPut', { key: 'foldGuard', value: 'newer' })
  const afterFirst = settingPtrs().length
  // Fold-shaped write: the blob carries the same value the row already holds.
  db.call('setMeta', ['db.habitsState', JSON.stringify({ foldGuard: 'newer', habits: [], moments: [], savedAt: 1 })])
  db.call('setMeta', ['db.habitsState', JSON.stringify({ foldGuard: 'newer', habits: [], moments: [], savedAt: 1 })])
  const rows = db.call('settingsRowsAll', {}).filter(r => r.key === 'foldGuard')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 'newer')
  const stamps = settingPtrs().filter(p => p.entityId === 'foldGuard').length
  assert.equal(stamps, 1, 'identical blob folds must not mint additional row deltas (updatedAt re-stamps)')
  assert.ok(settingPtrs().length >= afterFirst)
})
