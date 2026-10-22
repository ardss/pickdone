/**
 * [J7 2026-10-22] A reminder born ALREADY PAST-DUE never fires — the two mechanisms disagree:
 * needsCatchUp(todo) returns true for it ("a PAST reminder instance not recorded as fired"),
 * so handlers/todo.js delegates to the full reloadAll — whose catch-up gate `ts > lastSeen`
 * can never cover an instance born BEHIND the frontier (the watermark was written before the
 * reminder existed). The reminder is swallowed with zero feedback (pomodoro R2 live repro:
 * CLI add --reminder <past>, closed-app seed; also peer-synced old tasks, edit-panel past pick).
 *
 * Fix shape (scheduler owner, D22 invariants honored): a past MAIN-reminder instance (offset 0)
 * whose row was CREATED after the catch-up frontier (t.createTime > lastSeen) was never "seen"
 * by any sweep — fire it once through the same fire-then-watermark path (failed fires roll the
 * frontier back, firedReminders dedups forever). Old rows (synced-in history: createTime <=
 * lastSeen) stay swallowed — no bombardment. Offset/extra instances keep the never-fire-past
 * semantics (their degenerate past form is an anchoring artifact, see scheduleOne's comment).
 *
 * Run: node --test tests/unit/main/j7-born-past-due-reminder.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const scheduler = require('../../../src/main/scheduler.js')

function mkDb ({ todos, lastSeen }) {
  const meta = new Map([['reminderLastSeenAt', String(lastSeen)]])
  return {
    getMeta: k => meta.has(k) ? meta.get(k) : null,
    setMeta: ([k, v]) => { meta.set(k, String(v)) },
    queryTodos: () => todos,
    _meta: meta
  }
}

test('j7: a reminder created ALREADY PAST-DUE (createTime behind no frontier) fires once', () => {
  scheduler._clearStateForTest()
  const now = Date.now()
  const frontier = now - 10 * 60_000 // last sweep 10 minutes ago
  const bornPastDue = now - 12 * 60_000 // reminder due 12 min ago: BEFORE the frontier (that is the swallow)
  const todo = {
    taskId: 'j7a', reminderTime: bornPastDue, reminderOffsets: [], reminderExtra: [],
    complete: false, delete: false, createTime: now - 60_000 // row born AFTER the frontier
  }
  const fired = []
  scheduler.setFireForTest((t) => { fired.push(t.taskId); return true })
  const db = mkDb({ todos: [todo], lastSeen: frontier })
  scheduler.reloadAll(db)
  assert.deepEqual(fired, ['j7a'], 'a born-past-due main reminder must fire exactly once, not be swallowed by the frontier')
  // watermark advanced; firedReminders holds the dedup key
  assert.ok(scheduler._fired.has('j7a:0'), 'the fired watermark is recorded for the born-past-due instance')
  // second rebuild: dedup holds, no re-fire
  scheduler.reloadAll(db)
  assert.deepEqual(fired, ['j7a'], 'no re-fire on the next rebuild (firedReminders dedup)')
  scheduler._clearStateForTest()
})

test('j7: old rows with past reminders stay swallowed (synced-in history must not fire)', () => {
  scheduler._clearStateForTest()
  const now = Date.now()
  const frontier = now - 60_000
  const old = {
    taskId: 'j7hist', reminderTime: now - 3 * 86400_000, reminderOffsets: [], reminderExtra: [],
    complete: false, delete: false, createTime: now - 5 * 86400_000 // created long before the frontier
  }
  const fired = []
  scheduler.setFireForTest((t) => { fired.push(t.taskId); return true })
  scheduler.reloadAll(mkDb({ todos: [old], lastSeen: frontier }))
  assert.deepEqual(fired, [], 'a peer-synced historical task must not fire (anti-bombardment invariant)')
  scheduler._clearStateForTest()
})

test('j7: a future main anchor with a degenerate past offset does not fire the offset', () => {
  scheduler._clearStateForTest()
  const now = Date.now()
  const frontier = now - 60_000
  const tomorrow10 = now + 20 * 3600_000
  const todo = {
    taskId: 'j7off', reminderTime: tomorrow10, reminderOffsets: [-1440], reminderExtra: [],
    complete: false, delete: false, createTime: now - 30_000 // fresh row; offset instance lands yesterday
  }
  const fired = []
  scheduler.setFireForTest((t, offset) => { fired.push(t.taskId + ':' + (offset || 0)); return true })
  const db = mkDb({ todos: [todo], lastSeen: frontier })
  scheduler.reloadAll(db)
  assert.deepEqual(fired, [], 'the degenerate past offset instance (early-warning artifact) must not fire instantly')
  assert.ok(scheduler._jobs.has('j7off:0'), 'the future main reminder is scheduled')
  scheduler._clearStateForTest()
})

test('j7: a failed fire stays retry-eligible (D22 P3 rollback honored for the born-past-due path)', () => {
  scheduler._clearStateForTest()
  const now = Date.now()
  const frontier = now - 10 * 60_000
  const bornPastDue = now - 12 * 60_000 // due BEFORE the frontier — reachable only via the born-past-due branch
  const todo = {
    taskId: 'j7fail', reminderTime: bornPastDue, reminderOffsets: [], reminderExtra: [],
    complete: false, delete: false, createTime: now - 60_000
  }
  const meta = new Map([['reminderLastSeenAt', String(frontier)]])
  let failFire = true
  const attempts = []
  scheduler.setFireForTest(() => { attempts.push(1); return !failFire })
  const db = {
    getMeta: k => meta.has(k) ? meta.get(k) : null,
    setMeta: ([k, v]) => { meta.set(k, String(v)) },
    queryTodos: () => [todo]
  }
  scheduler.reloadAll(db)
  assert.equal(attempts.length, 1, 'first attempt made')
  assert.ok(!scheduler._fired.has('j7fail:0'), 'a failed fire must not consume the dedup watermark')
  const rolledBack = Number(meta.get('reminderLastSeenAt'))
  assert.ok(rolledBack <= bornPastDue - 1, 'the frontier rolls back to before the failed reminder so it stays in the window')
  failFire = false
  scheduler.reloadAll(db)
  assert.equal(attempts.length, 2, 'the next rebuild retries')
  assert.ok(scheduler._fired.has('j7fail:0'), 'the successful retry is watermarked')
  scheduler._clearStateForTest()
})
