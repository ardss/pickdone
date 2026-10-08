/**
 * maint/d23 FIX-3b (CalendarView) — regression guards.
 * Fixes covered:
 *   [C1] shared double-submit guard across all three inline-create paths
 *        (createAt / tbCreate / container keydown proxy) — duplicate "(untitled)" orphans
 *   [C2] popNav clamps popYear to currentYear±20 (HabitView CAL_MIN_OFFSET precedent)
 * Run: node --test tests/unit/renderer/d23-fix3b-calendar.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const src = read('renderer/js/views/CalendarView.vue')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

test('[C1] createAt is guarded by the shared _createBusy flag, set before dispatch, cleared in finally', () => {
  const i = src.indexOf('createAt (ts) {')
  assert.ok(i > -1, 'createAt found')
  const body = src.slice(i, i + 900)
  assert.ok(/if \(this\._createBusy\) return/.test(body), 're-entry is rejected while a create is in flight')
  const iGuard = body.indexOf('this._createBusy = true')
  const iDispatch = body.indexOf("$store.dispatch('todo/addTodo'")
  assert.ok(iGuard > -1 && iGuard < iDispatch, 'the flag is set BEFORE the addTodo dispatch')
  assert.ok(body.includes('.finally(() => { this._createBusy = false })'),
    'the flag clears in finally (failure must not wedge creation forever)')
})

test('[C1] tbCreate shares the same guard flag; the keydown proxy delegates to createAt', () => {
  const i = src.indexOf('tbCreate (dayTs, hour) {')
  assert.ok(i > -1, 'tbCreate found')
  const body = src.slice(i, i + 900)
  assert.ok(/if \(this\._createBusy\) return/.test(body), 'tbCreate honors the shared flag')
  assert.ok(body.includes('.finally(() => { this._createBusy = false })'), 'tbCreate clears in finally too')
  // the container keydown proxy must reuse createAt (and thus the guard) instead of dispatching itself
  const iKey = src.indexOf('this._onKey = (e) => {')
  assert.ok(iKey > -1, 'container keydown proxy found')
  const keyBody = src.slice(iKey, iKey + 900)
  assert.ok(!keyBody.includes("dispatch('todo/addTodo'"), 'the keydown proxy no longer dispatches addTodo directly')
  assert.ok(keyBody.includes('this.createAt(+dayjs(cell.dataset.date))'), 'the keydown proxy delegates to createAt (inherits the guard)')
})

test('[C2] popNav clamps popYear to currentYear±20', () => {
  const i = src.indexOf('popNav (dir) {')
  assert.ok(i > -1, 'popNav found')
  const body = src.slice(i, i + 300)
  assert.ok(/this\.thisYear - 20/.test(body) && /this\.thisYear \+ 20/.test(body),
    'the clamp bounds are currentYear-20 .. currentYear+20')
  assert.ok(/Math\.min\(Math\.max\(this\.popYear \+ dir/.test(body), 'the increment is clamped in one expression')
})
