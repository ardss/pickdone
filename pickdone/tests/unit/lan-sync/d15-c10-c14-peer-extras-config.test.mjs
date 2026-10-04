/* D15 C10 + C14 regression.
 *   C10 (P3, lan-sync/peer-extras.js): the missing-attachment memo keyed ONLY on the max
 *   oplog seq had two blind spots — sync-ack echo rows (commitSyncBatch writes are excluded
 *   from oplog capture) and attachment-file deletions on disk (no todo row / no oplog
 *   append) — leaving the "missing" list stale forever. The memo is now TTL-bounded and the
 *   invariant comment is honest ("seq advances OR the TTL expires").
 *   C14 (P3, main/config-store.js): sleepBackoff degraded to zero-wait when Atomics.wait is
 *   unavailable — the promised ~1.5s AV-lock backoff became 5 immediate reads. The busy-spin
 *   fallback from multi-instance.js keeps the delay real.
 * Run: node --test tests/unit/lan-sync/d15-c10-c14-peer-extras-config.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const createPeerExtras = require('../../../src/main/lan-sync/peer-extras')
const cfg = require('../../../src/main/config-store.js')

/* ---------- C10: TTL-bounded missing-attachment memo ---------- */

const peerExtras = createPeerExtras({ settingGet: () => null })
const ATTACH_DIR = process.cwd()

function extrasState (seqRef) {
  let getAllCount = 0
  const st = {
    db: {
      getAllCount: () => getAllCount,
      call (op) {
        if (op === 'getAll') { getAllCount += 1; return [{ image: JSON.stringify([{ url: 'local://a.png' }]) }] }
        if (op === 'syncOplogSince') return seqRef.value > 0 ? [{ seq: seqRef.value }] : []
        return null
      },
    },
  }
  const inject = { attachDir: ATTACH_DIR, existsSync: () => false }
  return { st, inject, getAll: () => getAllCount }
}

test('C10: an unchanged seq WITHIN the TTL still hits the cache (getAll once)', () => {
  const seqRef = { value: 3000 }
  const clock = { t: 1_000_000 }
  const h = extrasState(seqRef)
  h.inject.now = () => clock.t
  peerExtras.missingAttachmentKeys(h.st, h.inject)
  clock.t += 500 // inside the TTL window
  peerExtras.missingAttachmentKeys(h.st, h.inject)
  assert.equal(h.getAll(), 1, 'the perf memo must keep working inside the TTL window')
})

test('C10: an unchanged seq PAST the TTL recomputes (blind spots: sync-ack echo rows, file deletions)', () => {
  const seqRef = { value: 4000 }
  const clock = { t: 2_000_000 }
  const h = extrasState(seqRef)
  h.inject.now = () => clock.t
  peerExtras.missingAttachmentKeys(h.st, h.inject)
  assert.equal(h.getAll(), 1)
  clock.t += 5000 // far past MISSING_CACHE_TTL_MS, seq unchanged (the old memo returned the stale list forever)
  peerExtras.missingAttachmentKeys(h.st, h.inject)
  assert.equal(h.getAll(), 2, 'red before the fix: seq-only memo never recomputed despite the on-disk blind spots')
})

/* ---------- C14: sleepBackoff busy-spin fallback ---------- */

test('C14/D19: sleepBackoff without Atomics.wait still elapses a REAL (capped) delay', () => {
  const orig = Atomics.wait
  Atomics.wait = () => { throw new TypeError('simulated environment without Atomics.wait/SAB') }
  try {
    const t0 = Date.now()
    cfg.sleepBackoff(80)
    const elapsed = Date.now() - t0
    // D19-DOM1 (2026-10-02): the fallback spin is now CAPPED (~50ms per wait) — the old
    // full-slice spin (up to 800ms of full-core main-thread burn per read) was the price of
    // the D15 honesty contract; the documented degrade is: a real delay stays (never
    // zero-wait), the rest of the slice is given up and the read proceeds to the
    // non-destructive transient path sooner (no quarantine, writes gated off).
    assert.ok(elapsed >= 30, 'still elapses a real delay (never zero-wait); got ' + elapsed + 'ms')
    assert.ok(elapsed < 80, 'capped below the requested slice; got ' + elapsed + 'ms')
  } finally { Atomics.wait = orig }
})

test('C14: sleepBackoff with Atomics.wait available does not busy-spin (fast return)', () => {
  const t0 = Date.now()
  cfg.sleepBackoff(50)
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 40 && elapsed < 400, 'normal path: Atomics.wait sleeps ~ms, got ' + elapsed)
})
