/**
 * Ghost plan/filter tombstone regression (2026-09-19 live storm): a plan
 * pointer whose chip planAll cannot see hydrates as a tombstone
 * ({deleted, data:null}), and the apply path called planRemoveIds UNCONDITIONALLY —
 * planRemoveIds re-captured the delete into the oplog even when we never had
 * the chip, so two peers echoed the same delete back and forth at ~1000 oplog
 * rows/s (oplog seq burned ~250k/30s live) and every round carried the whole
 * echo (120s+ rounds). Invariant: a delete for a chip/filter we do not have is
 * a no-op with NO write and NO oplog re-capture; a delete for a chip we DO have
 * lands exactly once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../../src/main/lan-sync-bootstrap.js')

const T = 1789668518000
const CHIP_ID = 'tid_ghost_1788871512897'

function mockState (tables = {}) {
  const pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  const calls = []
  const db = {
    call (op, params) {
      calls.push([op, params])
      if (tables[op]) return tables[op](params)
      return null
    },
  }
  const state = {
    db, pendingWrites, applyCache: null, engine: null, node: null, timers: [],
    peerWatermarks: new Map(), pendingToSeq: 0, getWindowSenders: () => [], deviceId: 'dev-b',
  }
  return { state, pendingWrites, calls }
}

test('ghost plan tombstone (chip absent) is a no-op: no planRemoveIds, no re-capture', () => {
  // planAll does NOT contain the chip -> hydrate/apply sees no local row.
  const { state, calls } = mockState({ planAll: () => [] })
  __test.setState(state)
  const applied = __test.applyRow({ entity: 'plan', id: CHIP_ID, seq: 5, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null })
  assert.equal(applied, false, 'a delete for a plan chip we never had must not report applied')
  assert.ok(!calls.some(([op]) => op === 'planRemoveIds'), 'planRemoveIds must not fire for a ghost chip (the delete echo was the 2026-09-19 storm)')
})

test('plan tombstone for a chip we HAVE still lands (delete propagation intact)', () => {
  const { state, calls } = mockState({ planAll: () => [{ id: CHIP_ID, day: '2026-09-19' }] })
  __test.setState(state)
  const applied = __test.applyRow({ entity: 'plan', id: CHIP_ID, seq: 5, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null })
  assert.equal(applied, true, 'a delete for an existing chip must land')
  assert.ok(calls.some(([op, params]) => op === 'planRemoveIds' && ((params && params[0] && typeof params[0] === 'object') ? String(params[0].id) : String(params && params[0])) === CHIP_ID), 'planRemoveIds called for the existing chip')
})

test('filter ghost tombstone is a no-op too (same echo path)', () => {
  const { state, calls } = mockState({ filterList: () => [] })
  __test.setState(state)
  const applied = __test.applyRow({ entity: 'filter', id: 42, seq: 5, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null })
  assert.equal(applied, false, 'a delete for a filter we never had must not report applied')
  assert.ok(!calls.some(([op]) => op === 'filterDelete'), 'filterDelete must not fire for a ghost filter')
})

/* ---------- todo tombstone re-write churn (2026-09-19 live storm) ---------- */

function todoState (row) {
  const { state, pendingWrites, calls } = mockState({ getAll: () => (row ? [row] : []) })
  __test.setState(state)
  return { state, pendingWrites, calls }
}

const DEAD_ROW = {
  taskId: 'tid_dead_1', userId: 840001, taskContent: 'done+deleted', complete: true, completedAt: T,
  delete: 1, deletedAt: T + 1000, createTime: T, updateTime: T + 1000, syncTime: 0, status: 'sync',
}

test('inbound tombstone identical to the local tombstone is a no-op (no re-write churn)', () => {
  const { pendingWrites } = todoState(DEAD_ROW)
  const inbound = {
    entity: 'todo', id: 'tid_dead_1', seq: 9, ts: T + 5000, updatedAt: T + 1000,
    deleted: true, deletedAt: T + 1000,
    data: { taskId: 'tid_dead_1', taskContent: 'done+deleted', complete: true, completedAt: T, delete: 1, deletedAt: T + 1000, createTime: T, updateTime: T + 1000, status: 'sync', userId: 999 },
  }
  const applied = __test.applyRow(inbound)
  assert.equal(applied, false, 'an already-dead row with equal-or-older deletedAt must be a no-op (both-dead guard)')
  assert.equal(pendingWrites.todos.length, 0, 'no re-write may be buffered')
})

test('inbound tombstone with a strictly newer deletedAt still lands (delete propagation intact)', () => {
  const { pendingWrites } = todoState(DEAD_ROW)
  const inbound = {
    entity: 'todo', id: 'tid_dead_1', seq: 9, ts: T + 9000, updatedAt: T + 9000,
    deleted: true, deletedAt: T + 8000,
    data: { taskId: 'tid_dead_1', taskContent: 'edited then deleted later', complete: true, completedAt: T, delete: 1, deletedAt: T + 8000, createTime: T, updateTime: T + 9000, status: 'sync', userId: 999 },
  }
  const applied = __test.applyRow(inbound)
  assert.equal(applied, true, 'a strictly newer deletion must land')
  assert.ok(pendingWrites.todos.some(t => t.taskId === 'tid_dead_1' && (t.delete === 1 || t.deletedAt === T + 8000)), 'the newer tombstone is buffered for write')
})

test('live tombstone landing (local live row, inbound deleted) still works — delete-wins intact', () => {
  const LIVE = { taskId: 'tid_live_1', userId: 840001, taskContent: 'alive', complete: false, delete: 0, deletedAt: 0, createTime: T, updateTime: T, syncTime: 0 }
  const { pendingWrites } = todoState(LIVE)
  const inbound = {
    entity: 'todo', id: 'tid_live_1', seq: 9, ts: T + 5000, updatedAt: T + 5000,
    deleted: true, deletedAt: T + 5000,
    data: { taskId: 'tid_live_1', taskContent: 'alive', complete: false, delete: 1, deletedAt: T + 5000, createTime: T, updateTime: T + 5000, status: 'sync', userId: 999 },
  }
  const applied = __test.applyRow(inbound)
  assert.equal(applied, true, 'live->deleted must land')
  assert.ok(pendingWrites.todos.some(t => t.taskId === 'tid_live_1'), 'the tombstone is buffered')
})
