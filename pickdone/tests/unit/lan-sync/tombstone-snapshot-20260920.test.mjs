/* X1 regression tests (tomato snapshot tombstone gap, 2026-09-20), driven through the
 * lan-sync-bootstrap __test hook with a mock db.call surface.
 *   Egress:  buildSnapshot rows (allRows) must carry tomato tombstones (pointer rows, data:null).
 *   Ingress: a peer's stale LIVE tomato row must NOT resurrect a locally tombstoned record, and
 *            an inbound tomato tombstone pointer must land via tomatoRemoveByIds.
 * Run: node --test tests/unit/lan-sync/tombstone-snapshot-20260920.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../../src/main/lan-sync-bootstrap.js')

const LIVE_TOMATO = {
  tomatoId: 't1', endTime: 1700000000000, dateKey: '2023-11-14', focus: '', focusTaskId: 'task1',
  focusDuration: 25, rest: 5, restDuration: 5, succeed: true, manual: false, status: 'local', abandonReason: '', updatedAt: 1000,
}

function mockState (tables = {}, writeImpl = {}) {
  const calls = []
  const pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  const db = {
    calls,
    call (op, params) {
      calls.push({ op, params })
      if (tables[op]) return tables[op](params)
      if (writeImpl[op]) return writeImpl[op](params)
      return null
    },
  }
  const state = {
    db, pendingWrites, applyCache: null, engine: null, node: null, timers: [],
    peerWatermarks: new Map(), pendingToSeq: 0, deviceId: 'dev-local',
    getWindowSenders: () => [],
  }
  __test.setState(state)
  return { state, calls, pendingWrites }
}

const EMPTY = {
  getAll: () => [], settingsRowsAll: () => [], tomatoAll: () => [], tomatoTombstones: () => [],
  getAllCategories: () => [], planAll: () => [], filterList: () => [], listMetaKeys: () => [],
  getMeta: () => null, syncOplogSince: () => [],
}

test('X1 egress: allRows carries tomato tombstones as deleted pointer rows (data:null)', () => {
  mockState({
    ...EMPTY,
    tomatoAll: () => [LIVE_TOMATO],
    tomatoTombstones: () => [{ tomatoId: 't2', updatedAt: 2000, deletedAt: 2000 }],
  })
  const rows = __test.allRows().filter(r => r.entity === 'tomato')
  const live = rows.find(r => r.id === 't1')
  const dead = rows.find(r => r.id === 't2')
  assert.ok(live && live.deleted === false && live.data && live.data.tomatoId === 't1', 'live record exports with payload')
  assert.ok(dead, 'tombstoned record MUST be part of snapshot rows (was the resurrection gap)')
  assert.equal(dead.deleted, true)
  assert.equal(dead.deletedAt, 2000)
  assert.equal(dead.data, null, 'tombstones export as pointers; sync-apply lands them via tomatoRemoveByIds')
})

test('X1 ingress: peer stale LIVE row loses against local tombstone — no resurrect write', () => {
  const m = mockState({
    ...EMPTY,
    // Local record is deleted: tomatoAll (deleted=0) does not list it; only the tombstone read does.
    tomatoTombstones: () => [{ tomatoId: 't1', updatedAt: 2000, deletedAt: 2000 }],
  })
  void m
  const ok = __test.applyRow({
    entity: 'tomato', id: 't1', seq: 9, ts: 1000, updatedAt: 1000, deleted: false, deletedAt: 0,
    deviceId: 'peer', data: { ...LIVE_TOMATO },
  })
  assert.equal(ok, false, 'local tombstone stands (merge reports "local version wins")')
  assert.equal(m.pendingWrites.tomatoes.length, 0, 'stale live row must NOT land via tomatoAppendMany (deleted=0 upsert = resurrection)')
  assert.equal(m.calls.find(c => c.op === 'tomatoAppendMany'), undefined)
})

test('X1 ingress: inbound tombstone pointer deletes a peer-stale live record (snapshot-to-fresh-B)', () => {
  const m = mockState({
    ...EMPTY,
    // Fresh B still has the record live (it missed the delete increment)
    tomatoAll: () => [LIVE_TOMATO],
  })
  const ok = __test.applyRow({
    entity: 'tomato', id: 't1', seq: 9, ts: 2000, updatedAt: 2000, deleted: true, deletedAt: 2000,
    deviceId: 'peer-A', data: null,
  })
  assert.equal(ok, true)
  assert.equal(m.pendingWrites.tomatoes.length, 0)
  const remove = m.calls.find(c => c.op === 'tomatoRemoveByIds')
  assert.ok(remove, 'tombstone pointer lands via tomatoRemoveByIds — record stays deleted on B')
  assert.deepEqual(remove.params, ['t1'])
})

test('X1 LWW preserved: a peer live row NEWER than the local tombstone legitimately wins', () => {
  const m = mockState({
    ...EMPTY,
    tomatoTombstones: () => [{ tomatoId: 't1', updatedAt: 1000, deletedAt: 1000 }],
  })
  const ok = __test.applyRow({
    entity: 'tomato', id: 't1', seq: 9, ts: 3000, updatedAt: 3000, deleted: false, deletedAt: 0,
    deviceId: 'peer', data: { ...LIVE_TOMATO, focusDuration: 50, updatedAt: 3000 },
  })
  assert.equal(ok, true)
  assert.equal(m.pendingWrites.tomatoes.length, 1, 'newer live edit beats the older tombstone (delete-wins is not delete-always)')
  assert.equal(m.pendingWrites.tomatoes[0].focusDuration, 50)
})
