/**
 * maint/d23 FIX-3a — UX trio, source-pinned:
 *  #5 QuickAdd: the Esc handler needs the same IME guard the Enter handler has — Esc
 *     dismissing an IME candidate window must not wipe the draft mid-composition.
 *  #6 RecycleBinView.restore: per-row re-entrancy guard against double-click double-firing
 *     restoreFromRecycle (second run re-derived dayStart from the already-restored row).
 *  #7 DayDeck: the overdue list items need draggable="true" (the normal list already has
 *     it) — overdue tasks are exactly the ones users drag to today.
 * Run: node --test tests/unit/renderer/fix-d23-ux-trio.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('#5 QuickAdd Esc carries the IME composition guard', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  // Vue passes the keyup event implicitly to the named handler (the binding shape is pinned
  // by tests/unit/renderer/uiux-1001-quickadd-esc.test.mjs); the guard lives in onCancel.
  assert.match(src, /@keyup\.esc="onCancel"/, 'Esc binding on the qa input (implicit event arg)')
  assert.match(src, /onCancel \(e\) \{[\s\S]*?if \(e && \(e\.isComposing \|\| e\.keyCode === 229\)\) return/,
    'onCancel early-returns on IME composition, same guard as the Enter handler')
})

test('#6 RecycleBinView restore has a per-row re-entrancy guard', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  const i = src.indexOf('async restore (t, patchToToday) {')
  assert.ok(i > -1)
  const body = src.slice(i, i + 2400)
  assert.match(body, /_restoringId === t\.taskId/, 're-entry for the same row is skipped')
  assert.match(body, /this\._restoringId = t\.taskId/, 'the busy marker is set before the dispatch')
  assert.match(body, /finally \{ this\._restoringId = null \}/,
    'the marker is always cleared (success or failure)')
})

test('#7 DayDeck overdue items are draggable', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const i = src.indexOf('pd-day-deck__list--overdue')
  assert.ok(i > -1, 'the overdue list exists')
  const li = src.slice(i, src.indexOf('</ul>', i))
  assert.match(li, /draggable="true"[^>]*@dragstart="onDragStart\(t, \$event\)"/,
    'the overdue <li> carries draggable="true" alongside its dragstart (parity with the normal list)')
})
