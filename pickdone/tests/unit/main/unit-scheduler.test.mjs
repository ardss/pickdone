/**
 * Reminder scheduler unit tests - the scheduling layer for multiple reminders previously had zero coverage (missed catch-up/double-fire dedup is a historical P0 area).
 * scheduler.js loads under pure node (electron dependencies are lazy/fault-tolerant); fire can be replaced with a spy.
 * Run: npm test
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const scheduler = require('../../../src/main/scheduler.js')
import { test } from 'node:test'
import assert from 'node:assert/strict'

const MIN = 60000

test('scheduler: reminderInstances offset expansion (anchored on the main reminder, negative = earlier)', () => {
  const base = Date.now() + 3600000
  const out = scheduler.reminderInstances({ reminderTime: base, reminderOffsets: [-30, -1440] })
  assert.deepEqual(out, [[0, base], [-30, base - 30 * MIN], [-1440, base - 1440 * MIN]])
})

test('scheduler: reminderInstances boundaries - no main reminder means no anchor / instance times <=0 dropped / missing offsets', () => {
  assert.deepEqual(scheduler.reminderInstances({ reminderTime: 0, reminderOffsets: [-30] }), [])
  // Main reminder near 1970-01-01: earlier-offset instance times <=0 must be dropped, never producing negative times
  const tiny = 30 * MIN
  const out = scheduler.reminderInstances({ reminderTime: tiny, reminderOffsets: [-60, -10] })
  assert.deepEqual(out, [[0, tiny], [-10, tiny - 10 * MIN]])
  assert.deepEqual(scheduler.reminderInstances({ reminderTime: tiny }), [[0, tiny]])
})

test('scheduler: reloadAll catches up each missed reminder exactly once (firedReminders dedup)', () => {
  scheduler._clearStateForTest()
  const fired = []
  scheduler.setFireForTest((t, o) => fired.push(t.taskId + ':' + (o || 0)))
  const now = Date.now()
  const missedTs = now - 5 * MIN // came due while the app was closed
  const db = {
    store: new Map([['reminderLastSeenAt', String(missedTs - MIN)]]), // has a watermark -> not the first run
    getMeta (k) { return this.store.has(k) ? this.store.get(k) : null },
    setMeta ([k, v]) { this.store.set(k, String(v)) },
    queryTodos () {
      return [{ taskId: 't1', reminderTime: missedTs, reminderOffsets: [], complete: false, delete: false }]
    }
  }
  scheduler.reloadAll(db)
  assert.deepEqual(fired, ['t1:0'], 'reminders due after the watermark fire once as catch-up')
  // A write triggers a rebuild: the same reminder must not notify again (timer-triggered and catch-up share the dedup)
  scheduler.reloadAll(db)
  scheduler.reloadAll(db)
  assert.equal(fired.length, 1, 'firedReminders dedup: catch-up happens only once')
})

test('scheduler: reloadAll does not catch up on first run (prevents a bombardment of historical reminders from old DBs)', () => {
  scheduler._clearStateForTest()
  const fired = []
  scheduler.setFireForTest((t, o) => fired.push(t.taskId))
  const now = Date.now()
  const db = {
    store: new Map(), // no watermark -> first run
    getMeta (k) { return this.store.has(k) ? this.store.get(k) : null },
    setMeta ([k, v]) { this.store.set(k, String(v)) },
    queryTodos () {
      return [{ taskId: 'old', reminderTime: now - 86400000, reminderOffsets: [-30], complete: false, delete: false }]
    }
  }
  scheduler.reloadAll(db)
  assert.deepEqual(fired, [], 'historical reminders do not bombard on first run')
  assert.ok(db.store.get('reminderLastSeenAt'), 'first run sets the watermark')
})

test('scheduler: reloadAll neither catches up nor schedules completed tasks; future reminders enter jobs', () => {
  scheduler._clearStateForTest()
  scheduler.setFireForTest(() => assert.fail('should not fire'))
  const now = Date.now()
  const db = {
    store: new Map([['reminderLastSeenAt', String(now - 60 * MIN)]]),
    getMeta (k) { return this.store.has(k) ? this.store.get(k) : null },
    setMeta ([k, v]) { this.store.set(k, String(v)) },
    queryTodos () {
      return [
        { taskId: 'done', reminderTime: now - 5 * MIN, complete: true, delete: false },
        { taskId: 'fut', reminderTime: now + 30 * MIN, reminderOffsets: [-10], complete: false, delete: false }
      ]
    }
  }
  scheduler.reloadAll(db)
  assert.ok(scheduler._jobs.has('fut:0'), 'the future main reminder is scheduled')
  assert.ok(scheduler._jobs.has('fut:-10'), 'the future offset reminder is scheduled')
  assert.equal(scheduler._jobs.size, 2)
  assert.ok(!scheduler._jobs.has('done:0'), 'completed tasks are not scheduled')
})

test('scheduler: scheduleOne neither fires nor occupies a job for already-past reminders', () => {
  scheduler._clearStateForTest()
  scheduler.setFireForTest(() => assert.fail('a past reminder must not pop immediately'))
  scheduler.scheduleOne({ taskId: 'past', reminderTime: Date.now() - MIN, complete: false })
  assert.equal(scheduler._jobs.size, 0)
  const futureTs = Date.now() + 5 * MIN
  scheduler.scheduleOne({ taskId: 'soon', reminderTime: futureTs, reminderOffsets: [-1], complete: false })
  assert.ok(scheduler._jobs.has('soon:0') && scheduler._jobs.has('soon:-1'))
})

test('scheduler: sleep/wake - multiple reminders (reminderExtra) missed within the watermark each catch up once; waking again does not re-send', () => {
  scheduler._clearStateForTest()
  const MIN = 60000
  const t0 = Date.now()
  const calls = []
  scheduler.setFireForTest((t, offset) => calls.push(t.taskId + ':' + offset))
  // Simulate 8 hours of sleep: the watermark stopped 8h ago; one main reminder + two earlier offsets all expired meanwhile
  const saved = {}
  const db = {
    getMeta: k => saved[k],
    setMeta: ([k, v]) => { saved[k] = v },
    queryTodos: () => [
      { taskId: 'm', reminderTime: t0 - 7 * 60 * MIN, reminderOffsets: [-30, -60], complete: false, delete: false }
    ]
  }
  saved['reminderLastSeenAt'] = String(t0 - 8 * 60 * MIN - 1000) // the watermark is strictly 1ms before the earliest instance: ts==lastSeen does not count as missed (existing anti-double-fire semantics)
  scheduler.reloadAll(db)
  assert.equal(calls.length, 3, `main + 2 offsets should catch up 3 times, got ${calls.length}`)
  assert.ok(calls.includes('m:0') && calls.includes('m:-30') && calls.includes('m:-60'))
  // The second reloadAll (rebuild triggered again after waking): the watermark has advanced, must not re-send
  scheduler.reloadAll(db)
  assert.equal(calls.length, 3, 'the post-wake rebuild must never catch up a second time')
  // Future reminders enter jobs as usual
  assert.equal(scheduler._jobs.size, 0, 'all expired means no future jobs')
})
