/* F4 fix #2 (2026-10-17) — a REMOTE category tombstone landing (sync-apply category branch,
 * winner.deleted) now cascades saved filters referencing the victim, same as a LOCAL delete
 * (renderer purgeFiltersForVictims / CLI deleteCategory P1-3): doomed filters are backed up under
 * the stamped `catFiltersBak.<deletedAt>.<victim>` key BEFORE being tombstoned through the bus,
 * so recover stays symmetric on both ends. Previously the remote path skipped the cascade — the
 * filter kept haunting this device while the peer had purged it (two-device divergence).
 * Run: node --test tests/unit/main/f4-sync-category-tombstone-filter-cascade.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-sync-cascade-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-sync-cascade-ud-'))
const db = require_('../../../src/main/db.js')
const { __test } = require_('../../../src/main/lan-sync-bootstrap.js')
const catOps = require_('../../../src/main/db-category-ops.js')

/* Fixture stamps must be computed PER TEST with a fat future margin (D7, 2026-10-23): the old
 * module-level `Date.now() + 1000..5000` bakes a +1..5s head start at module-load time, and under
 * full-suite load db.init/upsertCategory can take longer than that — the local row then carries a
 * NEWER stamp than the "future" tombstone, sync-apply's LWW keeps the local row (silent
 * "local version stands", sync-apply.js `winner !== incoming -> return false`), applyRow returns
 * false and the test reds with "the remote tombstone must land (F2 path intact)". A +60s margin is
 * far beyond any init delay and still deep inside the 10-minute SKEW_CLAMP window (stamp-clamp.js
 * STAMP_CLAMP_MS), so clampSkew never rewrites it and the tombstone always wins LWW. */
const futureStamp = () => Date.now() + 60 * 1000

function makeState () {
  return {
    deviceId: 'f4-node',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
    applyCache: null
  }
}

function tombstoneRow (id, deletedAt) {
  return { entity: 'category', id, seq: 1, ts: deletedAt, updatedAt: deletedAt, deleted: true, deletedAt, data: null, author: 'peer' }
}

test('remote category tombstone purges its referencing saved filter WITH a stamped catFiltersBak backup', () => {
  const STAMP1 = futureStamp()
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'f4-sync-cascade-t-')))
  assert.equal(db.call('upsertCategory', { id: 810001, userId: 840001, name: 'F4Cat', color: null, createdAt: 1, sort: 1, isFolder: 0, parentId: 0, deleted: 0 }), true)
  const fid = db.call('filterUpsert', { name: 'F4 filter', conds: { catId: 810001 }, sort: 0 })
  assert.ok(fid, 'filter created')
  assert.equal(db.call('filterList').length, 1)

  const state = makeState()
  __test.setState(state)
  const ok = __test.applyRow(tombstoneRow(810001, STAMP1))
  assert.equal(ok, true, 'the remote tombstone must land (F2 path intact)')
  assert.equal(state.pendingWrites.categories.length, 1, 'the category tombstone is still buffered for flush (unchanged)')
  assert.equal(state.pendingWrites.categories[0].deletedAt, STAMP1)

  // THE FIX: the referencing filter is tombstoned, with a backup the recover path can re-derive
  assert.equal(db.call('filterList').length, 0, 'red before the fix: the referencing filter survived the remote tombstone')
  const tombs = db.call('filterTombstones').filter(t => String(t.id) === String(fid))
  assert.equal(tombs.length, 1, 'the filter ends as a real tombstone (delete propagates onward)')
  const bakRaw = db.call('getMeta', `catFiltersBak.${STAMP1}.810001`)
  assert.ok(bakRaw, 'the stamped backup key is written (D15-B6 shape, age derivable for the GC)')
  const bak = JSON.parse(bakRaw)
  assert.equal(bak.length, 1)
  assert.equal(bak[0].name, 'F4 filter')
  assert.equal(String(bak[0].conds.catId), '810001')
})

test('a filter on a SURVIVING category is untouched; filters referencing other victims stay put', () => {
  const STAMP2 = futureStamp()
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'f4-sync-cascade-t-')))
  assert.equal(db.call('upsertCategory', { id: 810002, userId: 840001, name: 'F4Keep', color: null, createdAt: 1, sort: 1, isFolder: 0, parentId: 0, deleted: 0 }), true)
  assert.equal(db.call('upsertCategory', { id: 810003, userId: 840001, name: 'F4Kill', color: null, createdAt: 1, sort: 2, isFolder: 0, parentId: 0, deleted: 0 }), true)
  db.call('filterUpsert', { name: 'keep me', conds: { catId: 810002 }, sort: 0 })

  const state = makeState()
  __test.setState(state)
  assert.equal(__test.applyRow(tombstoneRow(810003, STAMP2)), true)
  assert.equal(db.call('filterList').length, 1, 'the surviving category filter is untouched')
  assert.equal(db.call('getMeta', `catFiltersBak.${STAMP2}.810003`), null, 'no backup written when nothing was doomed')
})

test('re-landing the same tombstone is idempotent (no backup rewrite, no doomed set)', () => {
  const STAMP3 = futureStamp()
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'f4-sync-cascade-t-')))
  assert.equal(db.call('upsertCategory', { id: 810004, userId: 840001, name: 'F4Again', color: null, createdAt: 1, sort: 1, isFolder: 0, parentId: 0, deleted: 0 }), true)
  db.call('filterUpsert', { name: 'again', conds: { catId: 810004 }, sort: 0 })
  const state = makeState()
  __test.setState(state)
  assert.equal(__test.applyRow(tombstoneRow(810004, STAMP3)), true)
  const metaBefore = db.call('getMeta', `catFiltersBak.${STAMP3}.810004`)
  const filterTombs = db.call('filterTombstones').length
  // re-landed tombstone: category row is now a tombstone (localRow still found → cascade runs again on an empty doomed set)
  assert.equal(__test.applyRow(tombstoneRow(810004, STAMP3)), true, 'tombstone landing stays idempotent (F2 contract)')
  assert.equal(db.call('getMeta', `catFiltersBak.${STAMP3}.810004`), metaBefore, 'no second backup rewrite')
  assert.equal(db.call('filterTombstones').length, filterTombs, 'no duplicate filter tombstone')
})

test('ghost tombstone (category never existed locally) still applies with NO cascade', () => {
  const STAMP4 = futureStamp()
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'f4-sync-cascade-t-')))
  db.call('filterUpsert', { name: 'unrelated', conds: { catId: 424242 }, sort: 0 })
  const state = makeState()
  __test.setState(state)
  assert.equal(__test.applyRow(tombstoneRow(424242, STAMP4)), true, 'ghost tombstone: applied, no write (F2 contract)')
  assert.equal(state.pendingWrites.categories.length, 0)
  assert.equal(db.call('filterList').length, 1, 'unrelated filter untouched')
  assert.equal(db.call('getMeta', `catFiltersBak.${STAMP4}.424242`), null)
})

test('shared core purgeFiltersForCategoryVictims works store-free with the default db writer', () => {
  const STAMP5 = futureStamp()
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'f4-sync-cascade-t-')))
  assert.equal(db.call('upsertCategory', { id: 810005, userId: 840001, name: 'F4Core', color: null, createdAt: 1, sort: 1, isFolder: 0, parentId: 0, deleted: 0 }), true)
  db.call('filterUpsert', { name: 'core', conds: { catId: 810005 }, sort: 0 })
  const removed = catOps.purgeFiltersForCategoryVictims({ call: (op, p) => db.call(op, p) }, ['810005'], STAMP5)
  assert.equal(removed, 1)
  assert.equal(db.call('filterList').length, 0)
  assert.ok(db.call('getMeta', `catFiltersBak.${STAMP5}.810005`), 'backup written by the default writer')
  // unstamped tombstone → legacy key shape, still readable by restoreFiltersBackup's fallback
  assert.equal(db.call('upsertCategory', { id: 810006, userId: 840001, name: 'F4Core2', color: null, createdAt: 1, sort: 2, isFolder: 0, parentId: 0, deleted: 0 }), true)
  db.call('filterUpsert', { name: 'core2', conds: { catId: 810006 }, sort: 0 })
  const removed2 = catOps.purgeFiltersForCategoryVictims({ call: (op, p) => db.call(op, p) }, [810006], 0)
  assert.equal(removed2, 1)
  assert.ok(db.call('getMeta', 'catFiltersBak.810006'), 'legacy unstamped key shape (GC keeps it conservatively)')
})
