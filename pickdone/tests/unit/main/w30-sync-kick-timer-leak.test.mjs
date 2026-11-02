/* W30 (P3) makeSyncKick retry-timer leak — handlers/shared.js.
   kick() re-entry calls retry() INLINE while a retry timer is still pending; retry() used to set
   timer=null WITHOUT clearTimeout, so the stale setTimeout later fired a second retry that could
   re-queue onto the now-empty slot and schedule ANOTHER timer — two live one-shot retries,
   duplicate notify delivery attempts, and a self-multiplying retry chain on sustained failure.
   Regression: after any kick/retry interleaving there is at most ONE pending timer, and a cleared
   timer's callback must not resurrect a second one. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const { makeSyncKick } = require_('../../../src/main/handlers/shared.js')

/** Deterministic timer harness: handles are plain objects, callbacks fire only via fire(). */
function harness () {
  const pending = new Map() // handle -> cb
  const cleared = []
  let seq = 0
  const st = (cb, ms) => { const h = { id: ++seq, ms }; pending.set(h, cb); return h }
  const ct = h => { if (pending.delete(h)) cleared.push(h) }
  const activeCount = () => pending.size
  return { st, ct, pending, cleared, activeCount }
}

test('kick re-entry while a retry timer is pending clears the old timer (no leak)', () => {
  const h = harness()
  let calls = 0
  const { kick } = makeSyncKick(() => { calls++; throw new Error('down') }, { timerMs: 1000, setTimeout: h.st, clearTimeout: h.ct })
  kick({ op: 1 }) // fails -> requeue -> T1 pending
  assert.equal(h.activeCount(), 1)
  const t1 = [...h.pending.keys()][0]
  kick({ op: 2 }) // re-entry: inline retry must CLEAR t1, then requeue exactly one new timer
  assert.ok(h.cleared.includes(t1), 'old retry timer must be clearTimeout-ed, not just forgotten')
  assert.equal(h.activeCount(), 1, 'exactly one pending retry timer after re-entry')
})

test('even a stale-fired retry can never leave two pending timers (invariant under sustained failure)', () => {
  const h = harness()
  const { kick } = makeSyncKick(() => { throw new Error('down') }, { timerMs: 1000, setTimeout: h.st, clearTimeout: h.ct })
  kick({ op: 1 })
  kick({ op: 2 })
  // Fire every currently-pending callback one round (simulating timers that were never cleared):
  // each firing must converge to exactly one pending timer, never two.
  for (let round = 0; round < 3; round++) {
    const cbs = [...h.pending.values()]
    for (const cb of cbs) { h.pending.clear(); cb() }
    assert.equal(h.activeCount(), 1, 'round ' + round + ': sustained failure keeps exactly one retry timer')
  }
})

test('successful delivery clears the retry state entirely', () => {
  const h = harness()
  let fail = true
  const { kick } = makeSyncKick(() => { if (fail) throw new Error('down') }, { timerMs: 1000, setTimeout: h.st, clearTimeout: h.ct })
  kick({ op: 1 }) // fails, timer pending
  assert.equal(h.activeCount(), 1)
  fail = false
  const cb = [...h.pending.values()][0]
  h.pending.clear(); cb() // retry succeeds
  assert.equal(h.activeCount(), 0)
  kick({ op: 2 }) // delivers synchronously, no timer
  assert.equal(h.activeCount(), 0)
})
