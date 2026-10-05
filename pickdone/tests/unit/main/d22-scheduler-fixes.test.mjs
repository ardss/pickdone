/**
 * maint/d22 round — scheduler fixes:
 *  - a complete flip must change the rebuild fingerprint (P1) — a task completed via the CLI/
 *    peer-sync write path must not keep its future reminder timer;
 *  - the fired-reminder watermark is written only when the fire SUCCEEDED (P3) — a failed fire
 *    must stay catch-up-eligible and retry on the next rebuild.
 * Run: node --test tests/unit/main/d22-scheduler-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const scheduler = require('../../../src/main/scheduler.js')

/* ---------------- fix 1 (P1): fingerprint encodes the complete flip ---------------- */
test('d22: rebuildFingerprint changes when a reminder task flips complete (and back)', () => {
  const t = { taskId: 'fp1', reminderTime: Date.now() + 3600_000, reminderOffsets: [], reminderExtra: [], complete: false }
  const open = scheduler.rebuildFingerprint([t])
  const done = scheduler.rebuildFingerprint([{ ...t, complete: true }])
  assert.notEqual(open, done, 'complete flip must change the fingerprint so reloadAll rebuilds and clears the live timer')
  assert.equal(done, '', 'a completed task contributes no part (its timers get torn down)')
  assert.equal(scheduler.rebuildFingerprint([{ ...t, complete: false }]), open, 'un-completing restores the original fingerprint')
})

test('d22: reloadAll tears down the future timer of a task completed between rebuilds', () => {
  scheduler._clearStateForTest()
  const fired = []
  scheduler.setFireForTest(() => { fired.push(1) })
  const meta = new Map()
  const mkDb = (todos) => ({
    getMeta: k => meta.has(k) ? meta.get(k) : null,
    setMeta: ([k, v]) => { meta.set(k, String(v)) },
    queryTodos: () => todos
  })
  const t = { taskId: 'fp2', reminderTime: Date.now() + 3600_000, reminderOffsets: [], reminderExtra: [], complete: false, delete: false }
  const liveDb = mkDb([t])
  scheduler.reloadAll(liveDb)
  assert.equal(scheduler._jobs.size, 1, 'future reminder is scheduled for the open task')
  // Task completed via an external write (CLI done / peer sync): same db handle re-read later.
  t.complete = true
  scheduler.reloadAll(liveDb)
  assert.equal(scheduler._jobs.size, 0, 'the completed task keeps NO live reminder timer')
  scheduler._clearStateForTest()
})

/* ---------------- fix 4 (P3): fire failure does not consume the watermark ---------------- */
test('d22: a failed fire stays un-watermarked and is retried by the next reloadAll', () => {
  scheduler._clearStateForTest()
  const meta = new Map()
  let failFire = true
  const attempts = []
  scheduler.setFireForTest(() => { attempts.push(1); if (failFire) return false; return true })
  const past = Date.now() - 60_000
  const todo = { taskId: 'fw1', reminderTime: past, reminderOffsets: [], reminderExtra: [], complete: false, delete: false }
  const dbFake = {
    getMeta: k => meta.has(k) ? meta.get(k) : null,
    setMeta: ([k, v]) => { meta.set(k, String(v)) },
    queryTodos: () => [todo]
  }
  // Pre-seed the watermark from a previous run so the first rebuild is NOT a first run.
  meta.set('reminderLastSeenAt', String(past - 600_000))
  // Reminder came due while "closed": fire FAILS → no watermark entry may be recorded.
  scheduler.reloadAll(dbFake)
  assert.equal(attempts.length, 1, 'catch-up attempted the fire')
  assert.equal(scheduler._fired.has('fw1:0'), false, 'failed fire must NOT write the fired-reminder watermark (red before the fix)')
  // Fire recovers → the SAME reminder is retried: the rebuild watermark rolled back to just
  // before the failed reminder, so it is still inside the catch-up window. (The edge-trigger
  // fingerprint gate still no-ops a rebuild on unchanged inputs — nudge the reminder time like
  // any task edit would; any other task write in production re-triggers the rebuild too.)
  failFire = false
  todo.reminderTime = past + 1000
  scheduler.reloadAll(dbFake)
  assert.equal(attempts.length, 2, 'the un-watermarked reminder is retried on the next rebuild')
  assert.equal(scheduler._fired.has('fw1:0'), true, 'successful fire writes the watermark')
  // And a further rebuild does not re-fire the watermarked reminder.
  scheduler.reloadAll(dbFake)
  assert.equal(attempts.length, 2)
  scheduler._clearStateForTest()
})

