/** D10 (2026-09-27): float drag failsafe. The 16ms drag loop had no cap — a float renderer that
 *  freezes/crashes mid-drag never sends the sender-gated dragStop, and the card tracked the cursor
 *  at 60fps indefinitely with the hit poll suspended. The loop now force-stops after DRAG_MAX_MS
 *  (and stopDrag always re-arms the hit poll when the window is visible).
 * Run: node --test tests/unit/main/d10-float-drag-failsafe.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const tf = require('../../../src/main/tomato-float.js')

test('d10: dragExpired — a drag past DRAG_MAX_MS trips the failsafe, a live drag does not', () => {
  const cap = tf.DRAG_MAX_MS
  assert.ok(cap >= 30_000 && cap <= 120_000, 'cap is a sane seconds-scale bound')
  const start = 1_000_000
  assert.equal(tf.dragExpired(start, start + cap - 1), false, 'just under the cap: drag continues')
  assert.equal(tf.dragExpired(start, start + cap), true, 'at the cap: force-stop')
  assert.equal(tf.dragExpired(start, start + cap * 10), true, 'far past the cap: force-stop')
  assert.equal(tf.dragExpired(0, start + cap + 1), false, 'missing timestamp never trips the failsafe')
  assert.equal(tf.dragExpired(undefined, start + cap + 1), false)
})
