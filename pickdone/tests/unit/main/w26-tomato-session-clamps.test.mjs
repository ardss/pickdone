/* W26 fix 4 (2026-11-01): tomato-session —
 *  (a) reconcileDecision: a clock rollback past STAMP_CLAMP_MS left now BEHIND row.startedAt, so
 *      the expiry compare kept the durable row 'pending' forever — never cleared, and
 *      hasRunningSession stayed true so every quit re-prompted the focus-active confirm. A row
 *      stamped meaningfully in our future is unrecoverable skew: void it.
 *  (b) sessionRowFromTransition: restTime had only the lower clamp (1); align the upper clamp on
 *      the shared REST_MAX_MINUTES storage cap (same asymmetry FOCUS_MAX_MINUTES fixes for
 *      tomatoTime).
 * Run: node --test tests/unit/main/w26-tomato-session-clamps.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { sessionRowFromTransition, reconcileDecision } = require_('../../../src/main/tomato-session.js')
const { REST_MAX_MINUTES } = require_('../../../shared/limits.mjs')

test('w26[4a]: a focus row stamped AFTER now (clock rolled back) is voided, not pending forever', () => {
  const T0 = 1_700_000_000_000
  const row = { status: 'startTomatoTime', startedAt: T0 + 30 * 60_000, tomatoTime: 25, restTime: 5 }
  // Red before the fix: now-startedAt negative < limitMs → {action:'pending'} on EVERY later
  // boot (the durable row was never cleared; hasRunningSession stayed true).
  assert.equal(reconcileDecision(row, T0).action, 'void', 'red before the fix: a future-stamped focus row must void, not stay pending')
  // A rest row in the same skew situation was already void — regression guard for both statuses.
  assert.equal(reconcileDecision({ status: 'startRestTime', startedAt: T0 + 30 * 60_000, tomatoTime: 25, restTime: 5 }, T0).action, 'void')
  // Normal past-stamped rows keep the existing decision table.
  assert.equal(reconcileDecision({ status: 'startTomatoTime', startedAt: T0, tomatoTime: 25, restTime: 5 }, T0 + 60_000).action, 'pending', 'live phase: still pending')
  assert.equal(reconcileDecision({ status: 'startTomatoTime', startedAt: T0, tomatoTime: 25, restTime: 5 }, T0 + 30 * 60_000).action, 'book', 'expired phase: still booked')
})

test('w26[4b]: restTime is upper-clamped to the shared REST_MAX_MINUTES storage cap', () => {
  const base = { transition: 'start', status: 'startRestTime', startedAt: Date.now(), tomatoTime: 25 }
  const huge = sessionRowFromTransition({ ...base, restTime: 99_999 })
  assert.ok(huge, 'payload accepted')
  assert.equal(huge.restTime, REST_MAX_MINUTES, 'red before the fix: unbounded restTime persisted')
  // Lower clamp and default unchanged.
  assert.equal(sessionRowFromTransition({ ...base, restTime: 0 }).restTime, 5, 'restTime 0 → default 5')
  assert.equal(sessionRowFromTransition({ ...base, restTime: -3 }).restTime, 1, 'negative restTime → lower clamp 1')
  assert.equal(sessionRowFromTransition({ ...base, restTime: 15 }).restTime, 15, 'a sane value passes through')
})
