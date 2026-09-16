/* P1 sync groundwork regression (src/main/db.js, 2026-09-15):
   1. schema v5 adds tombstone (deleted/deletedAt) + updatedAt columns to categories/filters/
      plan_chips/tomato_records, and creates the sync_oplog change-capture table
   2. user-facing deletes are tombstones (row survives, readers filter it, same-id upsert resurrects)
   3. call() appends one sync_oplog row per affected entity for every write op; reads and the
      commitSyncBatch echo path stay silent; sinceSeq pagination works across re-init (persistence)
   Run: node --test tests/unit/main/sync-groundwork.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-groundwork-'))
db.init(dir)

// The module does not expose the raw handle; assert column presence behaviourally via the public
// ops plus the sync_oplog schema through syncOplogSince, and schemaVersion via meta.
const schemaVersion = () => Number(db.call('getMeta', 'schemaVersion'))

test('migration v5 stamped on a fresh DB', () => {
  assert.ok(schemaVersion() >= 5, 'schemaVersion should be >= 5 after init, got ' + schemaVersion())
})

test('filterDelete is a tombstone: hidden from filterList, resurrectable by filterUpsert', () => {
  const id = db.call('filterUpsert', { name: 'sync-gw', conds: { dateMode: 'all' }, sort: 1 })
  assert.ok(db.call('filterList').some(f => f.id === id), 'filter listed before delete')
  assert.equal(db.call('filterDelete', id), true)
  assert.ok(!db.call('filterList').some(f => f.id === id), 'filter hidden after delete')
  // The row must still exist (not physically gone) — re-saving the same id revives it
  db.call('filterUpsert', { id, name: 'sync-gw-2', conds: { dateMode: 'today' }, sort: 1 })
  const revived = db.call('filterList').find(f => f.id === id)
  assert.ok(revived, 'same-id upsert resurrects the tombstoned filter row')
  assert.equal(revived.name, 'sync-gw-2')
})

test('planRemoveIds is a tombstone: hidden from planAll, resurrectable by planAddMany', () => {
  const [id] = db.call('planAddMany', [{ taskId: 'gw_task', day: '2026-09-15', mm: '09:00' }])
  assert.ok(db.call('planAll').some(c => c.id === id))
  db.call('planRemoveIds', [id])
  assert.ok(!db.call('planAll').some(c => c.id === id), 'chip hidden after remove')
  db.call('planAddMany', [{ id, taskId: 'gw_task', day: '2026-09-16', mm: '10:00' }])
  const revived = db.call('planAll').find(c => c.id === id)
  assert.ok(revived, 'same-id planAddMany resurrects the tombstoned chip')
  assert.equal(revived.day, '2026-09-16')
})

test('tomatoRemoveByIds is a tombstone: excluded from tomatoAll AND tomatoByDay stats', () => {
  const t0 = Date.now()
  const rec = { tomatoId: 'gw_tmt', endTime: t0, focus: 'gw', focusDuration: 25, succeed: true }
  db.call('tomatoAppendMany', [rec])
  // tomatoByDay bounds are millisecond timestamps (or YYYYMMDD ints) — not ISO strings.
  // Bounds must be the record's LOCAL day (dateKey is derived locally via dayjs, db layer):
  // the old toISOString().slice(0,10) + 'T00:00:00' mixed a UTC calendar date with a LOCAL
  // midnight parse, so between 00:00 and 08:00 in UTC+8 the range landed on the previous day
  // and the freshly appended record summed to 0 (timezone-dependent flake).
  const d0 = new Date(t0)
  const dayStart = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime()
  const range = { from: dayStart, to: dayStart + 86400000 - 1 }
  const sumBefore = db.call('tomatoByDay', range).reduce((a, r) => a + r.focus, 0)
  assert.equal(sumBefore, 25, 'ledger counts the record before delete')
  db.call('tomatoRemoveByIds', 'gw_tmt')
  assert.ok(!db.call('tomatoAll').some(r => r.tomatoId === 'gw_tmt'), 'record hidden after delete')
  const sumAfter = db.call('tomatoByDay', range).reduce((a, r) => a + r.focus, 0)
  assert.equal(sumAfter, 0, 'deleted record must not count into focus stats')
  // Re-appending the same tomatoId resurrects it (upsert path clears the tombstone)
  db.call('tomatoAppendMany', [{ ...rec, focusDuration: 30 }])
  assert.equal(db.call('tomatoAll').find(r => r.tomatoId === 'gw_tmt').focusDuration, 30)
})

test('oplog: one row per entity per write op, ordered, with per-op entity kinds', () => {
  // isolate from earlier tests' log rows
  const prior = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = prior.length ? prior[prior.length - 1].seq : 0
  db.call('upsert', { taskId: 'gw_op1', taskContent: 'x', categoryId: null, complete: false, delete: false })
  db.call('setMeta', ['gwKey', 'v1'])
  const fid = db.call('filterUpsert', { name: 'oplog-f', conds: {}, sort: 0 })
  db.call('filterDelete', fid)
  const rows = db.call('syncOplogSince', { sinceSeq: lastSeq })
  assert.equal(rows.length, 4, 'one row per write op, got ' + JSON.stringify(rows.map(r => r.entity)))
  const entities = rows.map(r => r.entity)
  assert.deepEqual(entities.slice(0, 4), ['todo', 'meta', 'filter', 'filter'])
  assert.equal(rows[0].entityId, 'gw_op1')
  assert.equal(rows[1].entityId, 'gwKey')
  assert.ok(rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq), 'seq strictly ascending')
  // batch expansion: upsertMany logs one row per task id
  db.call('upsertMany', [
    { taskId: 'gw_b1', taskContent: 'x', categoryId: null, complete: false, delete: false },
    { taskId: 'gw_b2', taskContent: 'y', categoryId: null, complete: false, delete: false }
  ])
  const tail = db.call('syncOplogSince', { sinceSeq: rows[rows.length - 1].seq })
  assert.deepEqual(tail.map(r => r.entityId), ['gw_b1', 'gw_b2'])
})

test('oplog: reads and commitSyncBatch echo path stay silent', () => {
  const before = db.call('syncOplogSince', { sinceSeq: 0 }).length
  db.call('getById', 'gw_op1')
  db.call('getAll', {})
  db.call('planAll')
  db.call('tomatoAll')
  db.call('upsert', { taskId: 'gw_echo', taskContent: 'x', categoryId: null, complete: false, delete: false })
  const v = Number(db.call('getMeta', 'todosVersion')) || 0
  db.call('commitSyncBatch', { rows: [{ taskId: 'gw_echo', taskContent: 'synced', complete: false, delete: false }], version: v + 1 })
  db.call('getById', 'gw_echo')
  const after = db.call('syncOplogSince', { sinceSeq: 0 }).length
  assert.equal(after, before + 1, 'only the upsert logs; reads and the sync-ack echo must not')
  assert.equal(db.call('getById', 'gw_echo').taskContent, 'synced', 'commitSyncBatch still applies rows')
})

test('oplog survives close/re-init; sinceSeq pagination continues from persisted seq', () => {
  const before = db.call('syncOplogSince', { sinceSeq: 0 })
  assert.ok(before.length > 0)
  db.close()
  db.init(dir)
  const after = db.call('syncOplogSince', { sinceSeq: 0 })
  assert.equal(after.length, before.length, 'oplog rows persist across restart')
  const lastSeq = after[after.length - 1].seq
  db.call('upsert', { taskId: 'gw_after_restart', taskContent: 'x', categoryId: null, complete: false, delete: false })
  const delta = db.call('syncOplogSince', { sinceSeq: lastSeq })
  assert.equal(delta.length, 1)
  assert.equal(delta[0].entityId, 'gw_after_restart')
})
