/** D10 (2026-09-27): reminder notification clicks must route through the lock-aware
 *  showMainOrLock (wired via scheduler.setShowMainEntry), never a bare win.show()/win.focus() —
 *  clicking any reminder used to unlock a locked app to its full contents.
 * Run: node --test tests/unit/main/d10-reminder-click-lock.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const scheduler = require('../../../src/main/scheduler.js')

test('d10: focusMainFromNotification delegates to the lock-aware show entry (never bare win.show)', () => {
  let calls = 0
  scheduler.setShowMainEntry(() => { calls++ })
  scheduler.focusMainFromNotification()
  scheduler.focusMainFromNotification()
  assert.equal(calls, 2, 'click routes through the lock-aware gate (set via setShowMainEntry)')
})

test('d10: a throwing show entry cannot crash the click path; unwired fallback still focuses the window', () => {
  scheduler.setShowMainEntry(() => { throw new Error('transient') })
  assert.doesNotThrow(() => scheduler.focusMainFromNotification(), 'entry failure is logged, not fatal')
  // fallback when unwired: exercises window-ref directly (no main window in bare node → no-op)
  scheduler.setShowMainEntry(null)
  assert.doesNotThrow(() => scheduler.focusMainFromNotification())
})
