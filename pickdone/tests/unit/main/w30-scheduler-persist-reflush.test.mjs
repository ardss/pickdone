/* W30 (P3) scheduler fired-reminder persist: retry exhaustion must re-arm a delayed re-flush.
 * flushFiredNow's 30s retry chain used to STOP dead after 3 failures ("the next markFired
 * re-arms the 60s debounce anyway" — false for a reminder that already fired: a reminder fires
 * once per instance, so after the last markFired of a burst every pending watermark sat
 * unwritten in memory only, and a crash inside that window re-fired ALL of them after restart).
 * Fix: on exhaustion a single 120s safety re-flush is armed (self-perpetuating while failing,
 * bounded to one unref'd timer; a success resets the retry budget).
 * Injection: command-bus.commit (the persist write door) is patched on the shared module cache
 * to throw; setTimeout is spied at the global to observe the re-arm cadence. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const scheduler = require_('../../../src/main/scheduler.js')
const commandBus = require_('../../../src/main/command-bus.js')

const origCommit = commandBus.commit
const origSetTimeout = global.setTimeout
function spySetTimeout () {
  const calls = [] // [delay, ...]
  global.setTimeout = (cb, ms) => { calls.push(ms); return origSetTimeout(() => {}, 10_000) } // never actually fire
  return { calls, restore () { global.setTimeout = origSetTimeout } }
}

test('persist failures arm 30s retries, then a 120s safety re-flush after exhaustion (never nothing)', () => {
  scheduler._clearStateForTest()
  commandBus.commit = () => { throw new Error('w30 injected persist failure') }
  const spy = spySetTimeout()
  try {
    scheduler._markFired('t_w30:0') // arms the normal 60s debounce (1 call)
    assert.deepEqual(spy.calls, [60_000])
    // 4 flush attempts: 3 retry backoffs (30s each) + 1 exhausted safety re-flush (120s)
    for (let i = 0; i < 4; i++) scheduler.flushFiredNow()
    assert.deepEqual(spy.calls.slice(1), [30_000, 30_000, 30_000, 120_000],
      'exhaustion must arm the 120s safety re-flush, not leave the watermark hanging')
  } finally {
    spy.restore()
    commandBus.commit = origCommit
    scheduler.flushFiredNow() // clean state with real commit (entry written or map empty)
  }
})

test('a successful persist resets the retry budget (next failure chain starts at 30s again)', () => {
  scheduler._clearStateForTest()
  commandBus.commit = () => { throw new Error('w30 injected persist failure') }
  const spy = spySetTimeout()
  try {
    scheduler._markFired('t_w30b:0')
    for (let i = 0; i < 4; i++) scheduler.flushFiredNow() // exhausted -> 120s armed
    commandBus.commit = () => {} // a SUCCESSFUL persist (no-op write door; the real bus needs a live DB)
    scheduler._markFired('t_w30b:1')
    spy.calls.length = 0
    scheduler.flushFiredNow() // succeeds now: budget reset, written stamps set
    commandBus.commit = () => { throw new Error('w30 injected persist failure 2') }
    scheduler._markFired('t_w30b:2')
    spy.calls.length = 0
    scheduler.flushFiredNow() // first failure AFTER a success -> 30s retry, not exhausted
    assert.deepEqual(spy.calls, [30_000], 'retry budget must reset on success')
  } finally {
    spy.restore()
    commandBus.commit = origCommit
    scheduler.flushFiredNow()
  }
})
