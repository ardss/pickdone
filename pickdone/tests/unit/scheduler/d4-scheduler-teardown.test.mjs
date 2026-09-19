/**
 * D4 maintenance round (2026-09-19) — scheduler regressions:
 *  - P0: reloadAll must compute its no-op fingerprint BEFORE tearing jobs down; a no-op rebuild
 *    used to clear every live future reminder timer (silent reminder loss).
 *  - P1: needsCatchUp gates the handlers/todo.js fast path — only a PAST reminder instance that has
 *    NOT been recorded as fired forces the full reloadAll catch-up path.
 * Run: node --test tests/unit/scheduler/d4-scheduler-teardown.test.mjs
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const scheduler = require('../../../src/main/scheduler.js')
import { test } from 'node:test'
import assert from 'node:assert/strict'

const MIN = 60000

function makeDb (rows, watermark) {
  return {
    store: new Map(watermark != null ? [['reminderLastSeenAt', String(watermark)]] : []),
    getMeta (k) { return this.store.has(k) ? this.store.get(k) : null },
    setMeta ([k, v]) { this.store.set(k, String(v)) },
    queryTodos: () => rows
  }
}

test('P0 d4: a fingerprint no-op reloadAll must NOT tear down live reminder timers', () => {
  scheduler._clearStateForTest()
  scheduler.setFireForTest(() => assert.fail('no fire during this test'))
  const now = Date.now()
  const rows = [
    { taskId: 'a', reminderTime: now + 30 * MIN, reminderOffsets: [-5], reminderExtra: [], complete: false, delete: false },
    { taskId: 'b', reminderTime: now + 90 * MIN, reminderOffsets: [], reminderExtra: [], complete: false, delete: false }
  ]
  const db = makeDb(rows, now - MIN)
  scheduler.reloadAll(db)
  assert.equal(scheduler._jobs.size, 3, 'two future reminders + one offset are scheduled')
  const watermarkAfterFirst = db.store.get('reminderLastSeenAt')
  const liveHandles = [...scheduler._jobs.values()]
  // Unchanged inputs (the external-write watcher kick shape): rebuild is a no-op.
  scheduler.reloadAll(db)
  scheduler.reloadAll(db)
  assert.equal(scheduler._jobs.size, 3, 'a no-op rebuild must leave all live timers in place (was: all cleared)')
  assert.deepEqual([...scheduler._jobs.values()], liveHandles, 'the very same timer handles are still live')
  assert.ok(scheduler._jobs.has('a:0') && scheduler._jobs.has('a:-5') && scheduler._jobs.has('b:0'))
  assert.equal(db.store.get('reminderLastSeenAt'), watermarkAfterFirst, 'the no-op path must not re-write the watermark either')
  // An actual input change still rebuilds: old timers are replaced by the new set.
  rows.push({ taskId: 'c', reminderTime: now + 120 * MIN, reminderOffsets: [], reminderExtra: [], complete: false, delete: false })
  scheduler.reloadAll(db)
  assert.equal(scheduler._jobs.size, 4, 'a real change rebuilds and includes the new reminder')
  assert.ok(scheduler._jobs.has('c:0'))
})

test('P0 d4: catch-up rebuild still works after the reorder (missed reminders re-fired once)', () => {
  scheduler._clearStateForTest()
  const fired = []
  scheduler.setFireForTest((t, o) => fired.push(t.taskId + ':' + (o || 0)))
  const now = Date.now()
  const missedTs = now - 5 * MIN
  const rows = [
    { taskId: 'missed', reminderTime: missedTs, reminderOffsets: [], reminderExtra: [], complete: false, delete: false },
    { taskId: 'future', reminderTime: now + 10 * MIN, reminderOffsets: [], reminderExtra: [], complete: false, delete: false }
  ]
  const db = makeDb(rows, missedTs - MIN)
  scheduler.reloadAll(db)
  assert.deepEqual(fired, ['missed:0'], 'catch-up semantics preserved by the reordered reloadAll')
  assert.ok(scheduler._jobs.has('future:0'))
})

test('P1 d4: needsCatchUp — future-only task takes the scheduleOne fast path', () => {
  scheduler._clearStateForTest()
  const now = Date.now()
  assert.equal(scheduler.needsCatchUp({ taskId: 'f', reminderTime: now + 10 * MIN, complete: false, delete: false }), false,
    'future reminders need no catch-up: scheduleOne is enough')
  assert.equal(scheduler.needsCatchUp({ taskId: 'n', reminderTime: 0, reminderExtra: [], complete: false, delete: false }), false,
    'no reminder instances at all: no catch-up')
})

test('P1 d4: needsCatchUp — past UNFIRED instance forces the reloadAll catch-up branch', () => {
  scheduler._clearStateForTest()
  const past = Date.now() - 3 * MIN
  const t = { taskId: 'due', reminderTime: past, reminderOffsets: [], reminderExtra: [], complete: false, delete: false }
  assert.equal(scheduler.needsCatchUp(t), true, 'a past instance not in firedReminders still owes catch-up')
  // Once recorded as fired (runtime or catch-up path — the set is meta-persisted), edits take the fast path again
  scheduler._markFired('due:0')
  assert.equal(scheduler.needsCatchUp(t), false, 'a fired past instance is fully deduped — no reloadAll needed')
})

test('P1 d4: needsCatchUp — complete/deleted tasks never force catch-up', () => {
  scheduler._clearStateForTest()
  const past = Date.now() - 3 * MIN
  assert.equal(scheduler.needsCatchUp({ taskId: 'x', reminderTime: past, complete: true, delete: false }), false)
  assert.equal(scheduler.needsCatchUp({ taskId: 'y', reminderTime: past, complete: false, delete: true }), false)
  assert.equal(scheduler.needsCatchUp(null), false)
})
