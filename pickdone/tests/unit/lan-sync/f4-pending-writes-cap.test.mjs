/**
 * F4 fix (2026-10-15): pendingWrites unbounded growth. While a flush (or its quarantine parking)
 * keeps failing the buffer segments are RETAINED (D18) and every later ingest keeps pushing rows —
 * an unbounded growth window ending in OOM. capPendingWrites now trims each buffer to
 * PENDING_WRITES_CAP at flush entry, dropping the OLDEST rows, with a log.error trace per drop.
 * Run: node --test tests/unit/lan-sync/f4-pending-writes-cap.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const flush = require('../../../src/main/sync-apply-flush.js')

function mockState (buffers) {
  return {
    db: { call: () => null },
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [], ...buffers },
    applyCache: null, engine: null, node: null, timers: [],
    peerWatermarks: new Map(), pendingToSeq: 0, getWindowSenders: () => [],
  }
}

test('F1: capPendingWrites drops only the OLDEST rows over the cap, per buffer', () => {
  const state = mockState()
  state.pendingWrites.todos = Array.from({ length: flush.PENDING_WRITES_CAP + 10 }, (_, i) => ({ taskId: 't' + i }))
  state.pendingWrites.plans = [{ id: 'p1' }] // under the cap: untouched
  flush.capPendingWrites(state)
  assert.equal(state.pendingWrites.todos.length, flush.PENDING_WRITES_CAP, 'trimmed to exactly the cap')
  assert.equal(state.pendingWrites.todos[0].taskId, 't10', 'the OLDEST 10 rows were dropped (shift-side)')
  assert.equal(state.pendingWrites.todos.at(-1).taskId, 't' + (flush.PENDING_WRITES_CAP + 9), 'newest rows kept')
  assert.equal(state.pendingWrites.plans.length, 1, 'under-cap buffers untouched')
})

test('F1: flushPendingWrites drains a capped buffer normally (trim composes with the flush)', () => {
  const state = mockState()
  state.pendingWrites.settings = Array.from({ length: flush.PENDING_WRITES_CAP + 1 }, (_, i) => ({ key: 'k' + i, value: i }))
  const r = flush.flushPendingWrites(state)
  assert.equal(r.ok, true)
  assert.equal(state.pendingWrites.settings.length, 0, 'flush still clears the buffer after the trim')
})

test('F1: the cap is conservative — bounded memory but orders of magnitude above a normal segment', () => {
  // Quarantine cap precedent is 50 ENTRIES per op (samples, not full rows); the row buffer must
  // allow normal ack-sized segments (tens of rows) to flow without ever trimming.
  assert.ok(flush.PENDING_WRITES_CAP >= 1000, 'cap must not threaten normal traffic')
  assert.ok(flush.PENDING_WRITES_CAP <= 20000, 'cap must actually bound worst-case memory')
})
