/* M1/M2/M3 regression tests (sync-verify round, 2026-09-20) — the REAL better-sqlite3 db via
 * src/main/db.js plus the real apply/flush pipeline via src/main/sync-apply.js (and the bootstrap
 * adapter's allRows() for snapshot shapes). No fabricated row shapes: everything below runs the
 * actual flush (upsertCategoryMany / planAddMany / filterUpsertMany) against a real database.
 *   M1: an inbound category edit AND tombstone land through the real flush in ROW shape, with
 *       the peer's updatedAt preserved (the old app-shape payload threw "Invalid value" in
 *       better-sqlite3 and flushOne dropped the whole categories buffer — category sync never
 *       landed; snapshots also carried age-0 rows because the app shape had no updatedAt).
 *   M2: an applied plan chip keeps the peer's updatedAt (no re-stamp) and its echoed row is an
 *       identical-content no-op (no new oplog delta — no ping-pong).
 *   M3: a locally deleted category/plan/filter holds delete-wins against an OLDER inbound live
 *       row, and its tombstone rides in the snapshot (allRows) to fresh devices.
 * Run: node --test tests/unit/main/sync-verify-20260920.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const syncApply = require_('../../../src/main/sync-apply.js')
const bootstrap = require_('../../../src/main/lan-sync-bootstrap.js')

/** Fresh real db ("device B") + a syncApply state wired to it. */
function freshDevice () {
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-verify-')))
  const state = {
    deviceId: 'devB',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
  }
  bootstrap.__test.setState(state)
  return state
}

const oplogPointersFor = id => (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entityId === String(id))

/* ---------- M1: category edits + tombstones land through the REAL flush ---------- */

test('M1: an inbound category edit lands via the real flush in row shape, updatedAt preserved', () => {
  const state = freshDevice()
  const T = Date.now() - 5000
  const CAT = 553001 // categories.id is INTEGER PRIMARY KEY (renderer ids are numeric too)
  const ok = syncApply.applyRowSafe(state, {
    entity: 'category', id: String(CAT), seq: 1, ts: T, updatedAt: T, deleted: false, deletedAt: 0,
    // RAW ROW shape, exactly what hydrateRow emits after the M1 fix.
    data: { id: CAT, userId: 840001, name: 'Work', color: '#123456', createdAt: T - 1000, sort: 2, isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: T },
  })
  assert.equal(ok, true)
  const flush = syncApply.flushPendingWrites(state)
  assert.equal(flush.ok, true, 'the REAL upsertCategoryMany must not throw (app shape used to make better-sqlite3 reject every row)')
  const row = db.call('categoriesAllRows', {}).find(r => r.id === CAT)
  assert.ok(row, 'category landed in the real db')
  assert.equal(row.name, 'Work')
  assert.equal(row.color, '#123456')
  assert.equal(row.sort, 2)
  assert.equal(row.deleted, 0)
  assert.equal(row.updatedAt, T, 'the peer row age must survive the flush (no now() re-stamp)')
  assert.ok(db.call('getAllCategories', {}).some(c => c.categoryId === CAT), 'visible through the app-facing read')
})

test('M1: an inbound category tombstone lands via the real flush and stays deleted', () => {
  const state = freshDevice()
  const T = Date.now() - 5000
  const CAT = 553002
  db.call('upsertCategory', { id: CAT, name: 'Doomed', color: '#000000', sort: 0 })
  db.call('upsertCategoryMany', [{ id: CAT, updatedAt: T }]) // age the local row below the inbound tombstone
  const TD = T + 2000
  const ok = syncApply.applyRowSafe(state, { entity: 'category', id: String(CAT), seq: 2, ts: TD, updatedAt: TD, deleted: true, deletedAt: TD, data: null })
  assert.equal(ok, true, 'the tombstone winner applies (this branch used to drop the buffer)')
  const flush = syncApply.flushPendingWrites(state)
  assert.equal(flush.ok, true, 'real flush of the row-shape tombstone must not throw')
  const row = db.call('categoriesAllRows', {}).find(r => r.id === CAT)
  assert.ok(row, 'tombstone row persists (soft delete)')
  assert.equal(row.deleted, 1)
  assert.equal(row.deletedAt, TD, 'peer deletedAt preserved (LWW ordering metadata)')
  assert.equal(row.updatedAt, TD)
  assert.equal(db.call('getAllCategories', {}).find(c => c.categoryId === CAT), undefined, 'hidden from the live list')
})

test('M1: snapshot (allRows) category rows are ROW shape with a real age', () => {
  freshDevice()
  db.call('upsertCategory', { id: 551001, name: 'Snap', color: '#abcdef', sort: 1 })
  const raw = db.call('categoriesAllRows', {}).find(r => r.id === 551001)
  const snap = bootstrap.__test.allRows().filter(r => r.entity === 'category')
  const row = snap.find(r => r.id === '551001')
  assert.ok(row, 'category present in the snapshot')
  assert.equal(row.updatedAt, raw.updatedAt, 'snapshot age must be the ROW updatedAt (app shape had no updatedAt -> age 0)')
  assert.ok(row.updatedAt > 0)
  assert.equal(row.data.name, 'Snap', 'data must carry ROW columns (peers apply via upsertCategory)')
  assert.equal(row.data.categoryName, undefined, 'data must NOT be the hydrated app shape')
})

/* ---------- M2: applied chips keep the peer age; echo is a no-op ---------- */

test('M2: applying a peer chip lands it with the peer updatedAt; its echo produces no new delta', () => {
  const state = freshDevice()
  const T = Date.now() - 5000
  const ok = syncApply.applyRowSafe(state, {
    entity: 'plan', id: 'pl_x1', seq: 3, ts: T, updatedAt: T, deleted: false, deletedAt: 0,
    data: { id: 'pl_x1', taskId: 't_m2', day: '2026-09-20', mm: '09:30', sort: 0, updatedAt: T },
  })
  assert.equal(ok, true)
  syncApply.flushPendingWrites(state)
  const row = db.call('planAll', {}).find(c => c.id === 'pl_x1')
  assert.ok(row, 'chip landed in the real db')
  assert.equal(row.updatedAt, T, 'planAddMany must NOT re-stamp now() over the peer age (M2)')
  // The echo: B pushes the applied row back to A; A's identical content must be a no-op and must
  // not mint a new delta for the chip on B either. Simulate B's own egress row re-applied on B.
  const deltasBefore = oplogPointersFor('pl_x1').length
  const echoed = bootstrap.__test.allRows().find(r => r.entity === 'plan' && r.id === 'pl_x1')
  assert.ok(echoed, 'the applied chip egresses (peer A can ack it)')
  const reApply = syncApply.applyRowSafe(state, { ...echoed, seq: 99, deviceId: 'devA' })
  assert.equal(reApply, false, 'identical-content echo is a no-op')
  assert.equal(oplogPointersFor('pl_x1').length, deltasBefore, 'no new oplog delta for the echoed chip (no ping-pong)')
})

test('M2: an applied filter keeps the peer updatedAt through the real filterUpsertMany flush', () => {
  const state = freshDevice()
  const T = Date.now() - 5000
  const fid = db.call('filterUpsert', { name: 'Seed', conds: { dateMode: 'all' }, sort: 0 }) // filters are AUTOINCREMENT; updates need the row to exist
  db.call('filterUpsert', { id: fid, name: 'Seed (aged)', conds: { dateMode: 'all' }, sort: 0, updatedAt: T - 1000 }) // age it below the inbound row (renamed so the no-op suppression does not skip the write)
  const ok = syncApply.applyRowSafe(state, {
    entity: 'filter', id: String(fid), seq: 4, ts: T, updatedAt: T, deleted: false, deletedAt: 0,
    data: { id: fid, name: 'Peer filter', conds: { dateMode: 'all' }, sort: 0, updatedAt: T },
  })
  assert.equal(ok, true)
  syncApply.flushPendingWrites(state)
  const f = db.call('filterList', {}).find(x => x.id === fid)
  assert.ok(f, 'filter landed')
  assert.equal(f.name, 'Peer filter')
  assert.equal(f.updatedAt, T, 'filterUpsert must NOT re-stamp now() over the peer age (M2)')
})

/* ---------- M3: local tombstones hold delete-wins; snapshot carries them ---------- */

test('M3: an OLDER inbound live category does NOT resurrect a locally deleted one', () => {
  const state = freshDevice()
  db.call('upsertCategory', { id: 552001, name: 'Doomed locally', color: '#111111', sort: 1 })
  const TD = Date.now() - 2000
  db.call('upsertCategoryMany', [{ id: 552001, deleted: 1, deletedAt: TD, updatedAt: TD }]) // local delete
  const older = TD - 5000
  const ok = syncApply.applyRowSafe(state, {
    entity: 'category', id: '552001', seq: 5, ts: older, updatedAt: older, deleted: false, deletedAt: 0,
    data: { id: '552001', userId: 840001, name: 'Zombie', color: '#222222', createdAt: older, sort: 1, isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: older },
  })
  assert.equal(ok, false, 'older live row must lose to the local tombstone')
  syncApply.flushPendingWrites(state)
  const row = db.call('categoriesAllRows', {}).find(r => r.id === 552001)
  assert.equal(row.deleted, 1, 'stays deleted')
  assert.equal(db.call('getAllCategories', {}).find(c => c.categoryId === 552001), undefined)
  // ...and the deletion propagates to fresh devices via the snapshot.
  const snap = bootstrap.__test.allRows().find(r => r.entity === 'category' && r.id === '552001')
  assert.ok(snap && snap.deleted === true && snap.data === null, 'snapshot carries the tombstone (data:null)')
})

test('M3: an OLDER inbound live chip does NOT resurrect a locally deleted one', () => {
  const state = freshDevice()
  const [chipId] = db.call('planAddMany', [{ taskId: 't_m3', day: '2026-09-20', mm: '08:00', sort: 0 }])
  db.call('planRemoveIds', [chipId]) // local delete, stamps deletedAt/updatedAt = now
  const TD = Date.now() - 1
  const older = TD - 5000
  const ok = syncApply.applyRowSafe(state, {
    entity: 'plan', id: chipId, seq: 6, ts: older, updatedAt: older, deleted: false, deletedAt: 0,
    data: { id: chipId, taskId: 't_m3', day: '2026-09-21', mm: '10:00', sort: 0, updatedAt: older },
  })
  assert.equal(ok, false, 'older live chip must lose to the local tombstone')
  assert.ok(db.call('planTombstones', {}).some(t => t.id === chipId), 'chip stays deleted')
  const snap = bootstrap.__test.allRows().find(r => r.entity === 'plan' && r.id === chipId)
  assert.ok(snap && snap.deleted === true && snap.data === null, 'snapshot carries the chip tombstone')
})

test('M3: an OLDER inbound live filter does NOT resurrect a locally deleted one', () => {
  const state = freshDevice()
  const id = db.call('filterUpsert', { name: 'tobedeleted', conds: { dateMode: 'all' }, sort: 0 })
  db.call('filterDelete', id) // local delete, stamps deletedAt/updatedAt = now
  const older = Date.now() - 6000
  const ok = syncApply.applyRowSafe(state, {
    entity: 'filter', id: String(id), seq: 7, ts: older, updatedAt: older, deleted: false, deletedAt: 0,
    data: { id, name: 'Zombie filter', conds: { dateMode: 'all' }, sort: 0, updatedAt: older },
  })
  assert.equal(ok, false, 'older live filter must lose to the local tombstone')
  assert.ok(db.call('filterTombstones', {}).some(t => t.id === id), 'filter stays deleted')
  const snap = bootstrap.__test.allRows().find(r => r.entity === 'filter' && r.id === String(id))
  assert.ok(snap && snap.deleted === true && snap.data === null, 'snapshot carries the filter tombstone')
})
