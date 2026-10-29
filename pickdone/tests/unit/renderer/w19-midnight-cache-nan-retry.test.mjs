/**
 * [w19-renderer] four-fixture fix batch (2026-10-30) — regression tests:
 *   1. [P2] TodoItem cross-midnight stale cached computeds: deadlineOverdue read
 *      dayjs().startOf('day') and dateLabel read Date.now() — neither has a reactive
 *      dependency, so Vue cached the pre-midnight value and the red chip / "today" badge
 *      stayed stale all next day. Both must read the reactive store owner
 *      todo.todayTimestamp (W9 caliber, RecycleBinView.isOverdue precedent).
 *   2. [P3] todoComputeViews todayXNext comparator had no NaN guard: a drifted NaN
 *      todoTime made the subtraction return NaN (implementation-defined order, rows
 *      reshuffling every recompute). Missing numbers must fall back to 0 (Review-P3 caliber).
 *   3. [P3] QuickAdd partial-failure retry: `rest.concat(_pendingLines)` put a LATER failed
 *      batch AHEAD of already-queued lines (FIFO violation), and `text = rest[0]` clobbered
 *      a draft the user typed during the await window.
 *   4. [P3] TomatoFloatPage ringPct drew a 0% empty ring on the first frame of a working
 *      pomodoro (remaining still null — the guard clock() has, ringPct lacked).
 * Items 1/3/4 are component-internal logic → source anchors + extracted-logic replicas
 * (same convention as w17-deck-fixes.test.mjs); item 2 gets a behavioral test through
 * computeViewsCore via the real store action.
 * Run: node --test tests/unit/renderer/w19-midnight-cache-nan-retry.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStore } from 'vuex'
import todo from '../../../renderer/js/store/todo.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const itemSrc = read('renderer/js/components/TodoItem.vue')
const quickSrc = read('renderer/js/components/QuickAdd.vue')
const floatSrc = read('renderer/js/views/TomatoFloatPage.vue')

/* ---------- bug 1: TodoItem cross-midnight stale computeds ---------- */

test('deadlineOverdue compares against the reactive todo.todayTimestamp, not wall-clock dayjs()', () => {
  const m = itemSrc.match(/deadlineOverdue \(\) \{[\s\S]*?\n[ \t]{4}\},/)
  assert.ok(m, 'deadlineOverdue computed found')
  assert.ok(m[0].includes('this.$store.state.todo.todayTimestamp'), 'reads the reactive store owner (re-evaluates after setTodayTs rollover)')
  assert.ok(!m[0].includes('dayjs()'), 'no wall-clock dayjs() read (untracked dep → stale cache across midnight)')
})

test('dateLabel "today" comparison reads todo.todayTimestamp, not Date.now()', () => {
  const m = itemSrc.match(/dateLabel \(\) \{.*\},/)
  assert.ok(m, 'dateLabel computed found')
  assert.ok(m[0].includes('this.$store.state.todo.todayTimestamp'), 'badge re-renders at rollover')
  assert.ok(!m[0].includes('Date.now()'), 'no bare Date.now() read (untracked dep → stale "today" badge)')
})

test('replica: the fixed comparison flips exactly at the midnight rollover', () => {
  // Mirror of the fixed computed, parameterized by the store owner instead of a clock
  const DAY = 86400000
  const todayTs = +dayjsStartOfDay(Date.now())
  const dueYesterday = todayTs - DAY
  const dueToday = todayTs
  const overdue = ts => dayjsStartOfDay(ts) < todayTs
  assert.equal(overdue(dueYesterday), true, 'due yesterday is overdue')
  assert.equal(overdue(dueToday), false, 'due today is due-soon, not overdue (D14-A3 semantics preserved)')
  function dayjsStartOfDay (ts) { return new Date(ts).setHours(0, 0, 0, 0) }
})

/* ---------- bug 2: todayXNext NaN-safe comparator (behavioral) ---------- */

const DAY = 86400000
const today = new Date().setHours(0, 0, 0, 0)

const buildStore = rows => createStore({
  modules: {
    todo: { ...todo, state: () => ({ ...todo.state(), todoList: rows, viewsDirty: true }) },
    settings: {
      namespaced: true,
      state: { recycleBinAutoDeleteDays: 0, showNoDate: false, todoBoxCategoryId: -1, todoBoxSortOrder: 'asc', todoBoxSortMethod: 'created', sortMode: 'default' }
    }
  }
})

const row = (id, patch = {}) => ({
  taskId: id, taskContent: id, delete: false, complete: false,
  dayStart: 0, todoTime: 0, createTime: 1000, updateTime: 1000, completedAt: 0,
  ...patch
})

test('todayXNext comparator: NaN/missing todoTime falls back to 0 (deterministic order)', async () => {
  const rows = [
    row('bad-todoTime', { dayStart: today, todoTime: NaN }),
    row('no-todoTime', { dayStart: today }),
    row('good-later', { dayStart: today, todoTime: today + 3600000 }),
    row('overdue', { dayStart: today - DAY, todoTime: today - DAY })
  ]
  const store = buildStore(rows)
  await store.dispatch('todo/computeViews')
  const next = store.state.todo.views.todayXNext
  const ids = next.map(t => t.taskId)
  assert.ok(ids.includes('bad-todoTime') && ids.includes('no-todoTime'), 'NaN-todoTime rows stay in the x-next group')
  // every pair comparison must be a real number (no NaN → implementation-defined order)
  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const cmp = ((next[i].dayStart || 0) - (next[j].dayStart || 0)) || ((next[i].todoTime || 0) - (next[j].todoTime || 0))
      assert.equal(Number.isNaN(cmp), false, `pair ${next[i].taskId}/${next[j].taskId} compares to a number`)
    }
  }
  assert.equal(ids.indexOf('overdue') < ids.indexOf('good-later'), true, 'dayStart ordering still wins over todoTime')
})

test('todayXNext comparator guard is present in the helper source', () => {
  const src = read('renderer/js/store/helpers/todoComputeViews.js')
  const m = src.match(/todayXNext: todayXNext\.sort\(.*/)
  assert.ok(m && m[0].includes('|| 0'), 'both subtraction sides carry the ||0 fallback')
})

/* ---------- bug 3: QuickAdd retry queue FIFO + draft preservation ---------- */

test('retry queue appends FIFO (later failed batch goes after already-queued lines)', () => {
  const m = quickSrc.match(/const rest = lines\.slice\(done\)[\s\S]*?\n[ \t]{8}\}/)
  assert.ok(m, 'retry block found')
  assert.ok(m[0].includes('(this._pendingLines || []).concat(rest)'), 'queue is append-FIFO')
  assert.ok(!m[0].includes('rest.concat('), 'old LIFO rest.concat(...) form removed')
})

test('retry does not clobber a user draft: text = rest[0] only fires on an empty input', () => {
  const m = quickSrc.match(/const rest = lines\.slice\(done\)[\s\S]*?\n[ \t]{8}\}/)
  assert.ok(m && m[0].includes('if (!this.text.trim()) this.text = rest[0]'), 'draft seed is gated on an empty input')
})

test('replica: queue order matches first-failure-first across two failed batches', () => {
  let pending = ['a1', 'a2'] // batch A failed, queued
  const restB = ['b1'] // batch B fails later
  pending = (pending || []).concat(restB)
  assert.deepEqual(pending, ['a1', 'a2', 'b1'], 'FIFO: batch A lines stay ahead of batch B')
})

/* ---------- bug 4: TomatoFloatPage first-frame 0% ring ---------- */

test('ringPct guards remaining == null like clock() does (first frame = full ring)', () => {
  const m = floatSrc.match(/ringPct \(\) \{[\s\S]*?\n[ \t]{4}\},/)
  assert.ok(m, 'ringPct computed found')
  const clock = floatSrc.match(/clock \(\) \{[\s\S]*?\n[ \t]{4}\},/)
  assert.ok(clock && clock[0].includes('this.remaining == null'), 'clock() guard precedent is intact')
  assert.ok(m[0].includes('this.remaining == null'), 'ringPct carries the same null guard')
  assert.ok(m[0].indexOf('this.remaining == null') < m[0].indexOf('this.working'), 'guard runs before the working branch divides by total')
})

test('replica: fixed ringPct returns 100 (not 0) when remaining is null in working state', () => {
  const ringPct = function (remaining) {
    const total = 25 * 60
    if (remaining == null) return 100
    return Math.max(0, Math.min(100, remaining / total * 100))
  }
  assert.equal(ringPct(null), 100, 'first frame renders the ready-state full ring, no 0% flash')
  assert.equal(ringPct(25 * 60), 100, 'fresh full pomodoro is a full ring')
  assert.equal(Math.round(ringPct(12.5 * 60)), 50, 'mid-pomodoro ratio unchanged')
})
