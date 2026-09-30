/* D11 fix-wave regression tests (main-sync-and-handlers domain, tombstone stamps + honest results):
 *   finding 2  tomatoRemoveByIds accepts {tomatoId, deletedAt, updatedAt} stamps — the sync apply
 *              path lands the winner's LWW age instead of a local-now re-stamp, and the oplog
 *              pointer extracts the id from the stamped object (no "[object Object]" ghost)
 *   finding 3  settingsRowDelete accepts {key, deletedAt, updatedAt} stamps — same parity
 *   finding 10 tomatoMigrateFromMeta keeps the meta blob when tomatoAppendMany REJECTED rows
 *              (per-row failure granularity + unconditional delBlob = permanent record loss)
 *   finding 11 planRemoveIds returns only the ids that actually changed — a ghost id emits no
 *              phantom ('plan', ghostId) oplog tombstone pointer
 *   finding 16 localUserId prefers the durable sync.localUserId memo (machine-local meta) over
 *              the 840001 offline default when the todos table is empty
 * Real better-sqlite3 via db.init on a fresh temp dir (round7-sync-lww pattern — never the real
 * %APPDATA% profile). Run: node --test tests/unit/main/d11-tombstone-stamps.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const syncApply = require_('../../../src/main/sync-apply.js')

function freshDevice (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-stamps-' + label + '-'))
  db.init(dir)
  return {
    dir,
    deviceId: 'devD11',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
  }
}

/** Raw row read from the (encrypted) db file, mirroring d6-sync-fixes.rawRows. */
function rawGet (dir, sql, params = []) {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const key = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
  const d = new Database(path.join(dir, 'todos.db'))
  d.pragma(`key='${key}'`)
  d.prepare('SELECT count(*) FROM sqlite_master').get() // decrypt probe
  const row = d.prepare(sql).get(...params)
  d.close()
  return row
}

function flush (state) { const r = syncApply.flushPendingWrites(state); assert.equal(r.ok, true) }

test('finding 2: tomatoRemoveByIds preserves the sync winner stamps on the tombstone', () => {
  const state = freshDevice('tomato')
  const T = Date.now() - 60000 // well in the past: a local-now re-stamp is unmistakable
  db.call('tomatoAppendMany', [{ tomatoId: 'd11t2', endTime: Date.now(), focus: 'x', focusDuration: 5 }])
  const ok = syncApply.applyRowSafe(state, {
    entity: 'tomato', id: 'd11t2', seq: 1, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null,
  })
  assert.equal(ok, true)
  flush(state)
  const row = rawGet(state.dir, 'SELECT deleted, deletedAt, updatedAt FROM tomato_records WHERE tomatoId = ?', ['d11t2'])
  assert.equal(row.deleted, 1, 'the tombstone landed')
  assert.equal(row.deletedAt, T, 'winner deletedAt must survive (was re-stamped to local now)')
  assert.equal(row.updatedAt, T, 'winner updatedAt must survive (was re-stamped to local now)')
  db.close()
})

test('finding 2: the oplog pointer for a stamped tomatoRemoveByIds carries the real tomatoId', () => {
  freshDevice('tomato-oplog')
  db.call('tomatoAppendMany', [{ tomatoId: 'd11t2b', endTime: Date.now(), focus: 'x', focusDuration: 5 }])
  db.call('tomatoRemoveByIds', [{ tomatoId: 'd11t2b', deletedAt: 123, updatedAt: 456 }])
  const all = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []
  assert.ok(all.some(r => r.entity === 'tomato' && r.entityId === 'd11t2b'), 'a tombstone pointer exists for the stamped form')
  assert.equal(all.filter(r => r.entity === 'tomato' && String(r.entityId).includes('object Object')).length, 0, 'no [object Object] ghost pointer')
  db.close()
})

test('finding 3: settingsRowDelete preserves the sync winner stamps on the tombstone', () => {
  const state = freshDevice('setting')
  const T = Date.now() - 60000
  // rowPutMany (not rowPut) honors an explicit updatedAt — that is the sync-apply path.
  db.call('settingsRowPutMany', [{ key: 'd11f3', value: 'v1', updatedAt: T - 5000 }])
  const ok = syncApply.applyRowSafe(state, {
    entity: 'setting', id: 'd11f3', seq: 2, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null,
  })
  assert.equal(ok, true)
  const row = (db.call('settingsRowsAll', {}) || []).find(r => r.key === 'd11f3')
  assert.ok(row, 'row present (tombstones included)')
  assert.equal(row.deleted, true, 'the deletion landed')
  assert.equal(row.deletedAt, T, 'winner deletedAt must survive (was re-stamped to local now)')
  assert.equal(row.updatedAt, T, 'winner updatedAt must survive (was re-stamped to local now)')
  db.close()
})

test('finding 10: tomatoMigrateFromMeta keeps the blob when rows were rejected', () => {
  const tomatoOps = require_('../../../src/main/db-tomato-ops.js')
  freshDevice('mig')
  const base = Date.now()
  const list = [
    { tomatoId: 'mig-ok-1', endTime: base, focus: 'a', focusDuration: 5 },
    { tomatoId: 'mig-bad', endTime: 'not-a-date', focus: 'b', focusDuration: 5 },
  ]
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: list })])
  // Stub the per-row append to exercise ITS rejection contract (a row that fails the
  // endTime/dateKey validation is skipped-and-collected, the batch still commits). The current
  // blob parser happens to pre-filter every shape appendMany rejects today, but the contract is
  // per-row: the migration must treat ANY rejected row as "the blob is still the only copy of
  // that record" and keep it. db.js's delegate resolves tomatoOps.* at call time, so patching
  // the export reaches the migration under test.
  const origAppend = tomatoOps.tomatoAppendMany
  tomatoOps.tomatoAppendMany = () => ({ accepted: 1, rejected: [{ index: 1, tomatoId: 'mig-bad', reason: 'dateKey derive failed' }] })
  try {
    const n = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(n, 1, 'returns the ACCEPTED count')
    assert.ok(db.call('getMeta', 'db.tomatoState'), 'blob KEPT: the rejected record only exists there (unconditional delBlob lost it forever)')
  } finally { tomatoOps.tomatoAppendMany = origAppend }
  db.close()
})

test('finding 10: a fully accepted migration still deletes the blob (steady state unchanged)', () => {
  freshDevice('mig2')
  const blob = JSON.stringify({ tomatoRecordList: [{ tomatoId: 'mig-ok-2', endTime: Date.now(), focus: 'a', focusDuration: 5 }] })
  db.call('setMeta', ['db.tomatoState', blob])
  const n = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
  assert.equal(n, 1)
  assert.equal(db.call('getMeta', 'db.tomatoState'), null, 'blob deleted after a lossless migration')
  db.close()
})

test('finding 11: planRemoveIds returns only the ids that changed; a ghost id emits no oplog pointer', () => {
  freshDevice('plan')
  db.call('planAddMany', [{ taskId: 'tidD11', day: '2026-10-01', mm: '09:00' }])
  const chipId = db.call('planAll', {}).find(r => r.taskId === 'tidD11').id
  const T = Date.now() - 1000
  const changed = db.call('planRemoveIds', [{ id: chipId, deletedAt: T, updatedAt: T }, { id: 'pl_ghost_d11', deletedAt: T, updatedAt: T }])
  assert.deepEqual(changed, [String(chipId)], 'the ghost id (never existed) is NOT in the changed result')
  const planPtrs = (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entity === 'plan')
  assert.equal(planPtrs.filter(r => r.entityId === 'pl_ghost_d11').length, 0, 'no phantom tombstone pointer for the ghost id')
  assert.ok(planPtrs.some(r => r.entityId === String(chipId)), 'the real chip still emits its pointer')
  db.close()
})

test('finding 16: localUserId falls back to the durable sync.localUserId memo, not 840001', () => {
  const state = freshDevice('userid')
  // No todos on this device; a PREVIOUS session discovered the real account id and persisted it.
  db.call('setMeta', ['sync.localUserId', '424242'])
  assert.equal(syncApply.localUserId(state), 424242, 'the durable memo wins over the 840001 offline default')
  db.close()
})

test('finding 16: a scanned todo userId persists durably for the next empty-table session', () => {
  const state = freshDevice('userid2')
  db.call('upsert', { taskId: 'd11u', content: 'x', userId: 777 })
  assert.equal(syncApply.localUserId(state), 777, 'the todos scan still wins')
  assert.equal(db.call('getMeta', 'sync.localUserId'), '777', 'the discovered id is persisted for later sessions')
  db.close()
})
