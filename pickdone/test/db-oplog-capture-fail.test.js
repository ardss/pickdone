/* round3-stability-9 (2026-09-26): oplogEntriesFor runs real SQL for planMoveTask/
 * planDeleteTask/planDeleteTaskDay OUTSIDE appendOplog's try/catch — a throw there rejected
 * the caller's invoke for an ALREADY-COMMITTED write. call() now wraps the whole capture in
 * try/catch (log-and-drop), matching appendOplog's declared contract ("oplog append failed,
 * write itself is unaffected"). The delta row was lost either way; only the caller-visible
 * outcome changes from error-on-committed-write to success+warn. Happy path identical.
 * Repro: poisoned getters on the params object — the write op destructures each property once
 * (succeeds), the capture SELECT then re-reads params.taskId (second access) and throws.
 * Fresh temp DB via TODO_DB_DIR / TODO_USER_DATA_DIR — the real %APPDATA% is never touched.
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs; run directly:
 * node --test test/db-oplog-capture-fail.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oplog-cap-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oplog-cap-ud-'))

const db = require('../src/main/db.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'oplog-cap-db-')))

// First read returns the real value; any later read throws (simulating the closed/re-init
// handle failure class oplogEntriesFor's SQL hits in production).
function onceThenBoom (value) {
  let read = false
  return {
    enumerable: true,
    configurable: true,
    get () {
      if (read) { const e = new Error('boom: handle closed mid-capture'); e.code = 'SQLITE_MISUSE'; throw e }
      read = true
      return value
    }
  }
}

test('happy path identical: planMoveTask with a real chip commits and captures normally', () => {
  db.call('planAddMany', [{ id: 'c1', taskId: 'T1', day: '2026-09-25', mm: '09:00', sort: 1 }])
  const r = db.call('planMoveTask', { taskId: 'T1', fromDay: '2026-09-25', toDay: '2026-09-26' })
  assert.ok(r > 0, 'precondition: the chip moved')
})

test('THE FIX: a capture-time throw no longer rejects the already-committed write', () => {
  db.call('planAddMany', [{ id: 'c2', taskId: 'T2', day: '2026-09-25', mm: '09:00', sort: 1 }])
  // Every property throws on its SECOND read: the write op destructures once (write commits),
  // oplogEntriesFor's capture SELECT re-reads params.taskId -> boom. Pre-fix this threw out of
  // call() AFTER the UPDATE had committed.
  const poisoned = Object.defineProperties({}, {
    taskId: onceThenBoom('T2'),
    fromDay: onceThenBoom('2026-09-25'),
    toDay: onceThenBoom('2026-09-26')
  })
  const r = db.call('planMoveTask', poisoned)
  assert.ok(r > 0, 'the committed write result is returned instead of rejecting the invoke')
  // and the move really did land
  const moved = db.call('planMoveTask', { taskId: 'T2', fromDay: '2026-09-26', toDay: '2026-09-27' })
  assert.ok(moved > 0, 'the chip is on the moved day — the write was committed, not rolled back')
})

test('a later healthy write still captures its oplog entries (log-and-drop does not poison the log)', () => {
  db.call('planAddMany', [{ id: 'c3', taskId: 'T3', day: '2026-09-25', mm: '09:00', sort: 1 }])
  const before = db.call('syncOplogSince', { sinceSeq: 0, limit: 5000 }).length
  const r = db.call('planMoveTask', { taskId: 'T3', fromDay: '2026-09-25', toDay: '2026-09-28' })
  assert.ok(r > 0)
  const after = db.call('syncOplogSince', { sinceSeq: 0, limit: 5000 }).length
  assert.ok(after > before, 'subsequent writes still append their oplog deltas')
})
