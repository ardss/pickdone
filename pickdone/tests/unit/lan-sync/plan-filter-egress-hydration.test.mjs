/* Egress hydration contract for the plan/filter entities (hydrateRow TOMB_FALLBACK_LOOKUP):
 * every oplog pointer that leaves this device must hydrate to a merge-ready row whose LWW age is
 * the LOCAL ROW's real age — a live chip/filter carries its updatedAt, a locally tombstoned one
 * hydrates as a tombstone stamped with its real deletedAt (NOT the pointer's ts), and an unknown
 * id hydrates as a data-less tombstone at the pointer's ts. A peer receiving these rows then runs
 * ordinary delete-wins LWW instead of resurrecting deleted work. Regression guard for the
 * plan/filter hydration block, which no test exercised end-to-end (pointer -> hydrateRow -> wire
 * row shape); losing it silently made deleted chips/filters vanish from egress and re-win LWW on
 * peers that still held them live (ghost resurrection).
 * Real sqlite rows through db.init on TODO_USER_DATA_DIR/TODO_DB_DIR temp dirs — the real
 * %APPDATA% is never touched.
 * Run: node --test tests/unit/lan-sync/plan-filter-egress-hydration.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-hydr-db-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-hydr-ud-'))

const db = require_('../../../src/main/db.js')
const { createHydrationCache, hydrateRow } = require_('../../../src/main/sync-apply.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-hydr-node-'))

function stateFor () {
  return { db: { call: (op, p) => db.call(op, p) } }
}

function ptr (entity, id, ts) {
  return { seq: 1, entity, entityId: id, ts }
}

test('plan/filter egress hydration: live, locally tombstoned, and unknown ids hydrate to the contract shape', () => {
  db.init(dir)

  /* --- live chip: real updatedAt, raw row data, not deleted --- */
  const chipStamp = 1700000000000
  db.call('planAddMany', [{ id: 'chip-live', taskId: 't1', day: '2026-09-27', mm: '09:00', updatedAt: chipStamp }])
  let row = hydrateRow(stateFor(), ptr('plan', 'chip-live', 123), createHydrationCache(stateFor()))
  assert.ok(row, 'a live plan pointer must hydrate')
  assert.equal(row.deleted, false, 'live chip hydrates as NOT deleted')
  assert.equal(row.updatedAt, chipStamp, 'live chip carries the ROW age, not the pointer ts')
  assert.ok(row.data && row.data.id === 'chip-live', 'live chip carries the raw row (apply path binds columns)')

  /* --- locally tombstoned chip: hydrates as a tombstone with the REAL deletion age --- */
  const chipDeletedAt = 1700000050000
  db.call('planRemoveIds', [{ id: 'chip-live', deletedAt: chipDeletedAt, updatedAt: chipDeletedAt }])
  assert.equal(db.call('planAll').length, 0, 'the chip is locally gone')
  row = hydrateRow(stateFor(), ptr('plan', 'chip-live', 123), createHydrationCache(stateFor()))
  assert.ok(row, 'a tombstoned plan pointer must still hydrate (so the deletion propagates)')
  assert.equal(row.deleted, true, 'locally deleted chip hydrates as a tombstone')
  assert.equal(row.deletedAt, chipDeletedAt, 'THE CONTRACT: tombstone age is the real deletedAt, not the pointer ts')
  assert.equal(row.data, null, 'tombstone carries no data payload')
  assert.equal(row.updatedAt, chipDeletedAt, 'LWW age follows the tombstone age')

  /* --- unknown chip id: data-less tombstone at the pointer ts (delete still propagates) --- */
  row = hydrateRow(stateFor(), ptr('plan', 'chip-unknown', 777), createHydrationCache(stateFor()))
  assert.ok(row, 'an unknown plan id must hydrate (not be filtered out)')
  assert.equal(row.deleted, true)
  assert.equal(row.deletedAt, 777, 'unknown id falls back to the pointer ts as its age')
  assert.equal(row.data, null)

  /* --- filter: same three states through the filterTomb fallback --- */
  db.call('filterUpsert', { id: 424242, name: 'work', conds: [], sort: 0, updatedAt: 1700000100000 })
  row = hydrateRow(stateFor(), ptr('filter', 424242, 5), createHydrationCache(stateFor()))
  assert.ok(row && row.deleted === false, 'live filter hydrates as NOT deleted')
  assert.equal(row.updatedAt, 1700000100000, 'live filter carries the row age')

  const filterDeletedAt = 1700000200000
  // db.call forwards a single params arg: the sync path idiom packs [id, {stamps}] into one array
  db.call('filterDelete', [424242, { deletedAt: filterDeletedAt, updatedAt: filterDeletedAt }])
  row = hydrateRow(stateFor(), ptr('filter', 424242, 5), createHydrationCache(stateFor()))
  assert.ok(row, 'a tombstoned filter pointer must still hydrate')
  assert.equal(row.deleted, true, 'locally deleted filter hydrates as a tombstone')
  assert.equal(row.deletedAt, filterDeletedAt, 'THE CONTRACT: filter tombstone age is the real deletedAt')
  assert.equal(row.data, null)

  row = hydrateRow(stateFor(), ptr('filter', 424243, 888), createHydrationCache(stateFor()))
  assert.ok(row && row.deleted === true && row.data === null && row.deletedAt === 888,
    'unknown filter id hydrates as a data-less tombstone at the pointer ts')

  /* --- non-syncable entity is refused outright (never reaches the wire) --- */
  assert.equal(hydrateRow(stateFor(), ptr('nope', 'x', 1)), null, 'unknown entity hydrates to null')
})
