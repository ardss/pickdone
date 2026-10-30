/**
 * [w21-renderer] two-fixture fix batch (2026-10-30) — regression tests:
 *   1. [P1] historyPush 400ms merge window unconditionally REPLACED the stack top with the
 *      incoming snapshot. The before-hook in store/index.js fires for EVERY dispatch of a
 *      HISTORY_ACTION, including nested dispatches inside another action (completing a repeat
 *      task triggers the renewal addTodo; purge/restoreFromRecycle trigger internal strips), so
 *      the outer user operation's baseline snapshot was overwritten by a nested intermediate
 *      state — the "complete" step vanished from the undo chain (first Ctrl+Z only removed the
 *      renewal instance, the second jumped two real steps). Fix: merge only when the incoming
 *      snapshot EQUALS the stack top (same-content echo); a differing push inside the window is
 *      skipped, the outer baseline stays, and _histLastPushAt is left untouched.
 *   2. [P3] todoComputeViews: the main loop buckets dayStart with the coarse
 *      Math.round((dayStart - today) / DAY_MS) diff, but the yesterdayTodoList filter compared
 *      strictly (dayStart === today-1day). A clock-drifted dayStart a few hours off midnight
 *      rounded into the yesterday bucket in the loop while failing the strict filter (or vice
 *      versa) — rows silently switched groups / dropped out between surfaces. Fix: the yesterday
 *      filter uses the same coarse diff caliber.
 * Run: node --test tests/unit/renderer/w21-undo-nested-snapshot-and-yesterday-caliber.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStore } from 'vuex'
import todo from '../../../renderer/js/store/todo.js'
import { historyPush } from '../../../renderer/js/store/helpers/undo.js'
import { dayjs, DAY_MS } from '../../../renderer/js/utils/core.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const freshState = () => ({ undoStack: [], redoStack: [], _histLastPushAt: 0, _histBytes: 0, _histRedoBytes: 0, _histEpoch: 0 })

/* ---------- fix 1: nested HISTORY_ACTION snapshots must not displace the outer baseline ---------- */

test('w21-1: differing push inside the 400ms window is skipped — stack top (outer baseline) survives', () => {
  const s = freshState()
  historyPush(s, '{"todoList":[],"recycleList":[]}') // outer user op's pre-mutation baseline, starts the window
  const baseline = s.undoStack[s.undoStack.length - 1]
  // Nested dispatch's before-hook snapshot 100ms later: state already differs (post-mutation intermediate)
  historyPush(s, '{"todoList":[{"taskId":"renewal"}],"recycleList":[]}')
  assert.equal(s.undoStack.length, 1, 'no new entry stacked for the nested intermediate snapshot')
  assert.equal(s.undoStack[s.undoStack.length - 1], baseline, 'the OUTER baseline snapshot is still the stack top')
  assert.equal(s._histBytes, baseline.length, 'byte accounting untouched by the skipped push')
})

test('w21-1: _histLastPushAt is NOT refreshed by a skipped push (window does not extend)', async () => {
  const s = freshState()
  historyPush(s, 'A')
  const firstAt = s._histLastPushAt
  historyPush(s, 'B') // differing → skipped
  assert.equal(s._histLastPushAt, firstAt, 'skip leaves the window anchor at the outer push time')
})

test('w21-1: same-content push inside the window still merges (echo semantics preserved)', () => {
  const s = freshState()
  const snap = '{"todoList":[],"recycleList":[]}'
  historyPush(s, snap)
  historyPush(s, snap) // identical content (e.g. a dispatch that does not mutate) → merge branch
  assert.equal(s.undoStack.length, 1, 'identical snapshot merges into the top as before')
  assert.equal(s.undoStack[0], snap)
  assert.equal(s.redoStack.length, 0, 'merge still clears the redo stack')
})

test('w21-1: push after the window closes is a fresh independent entry (real undo points not lost)', () => {
  const s = freshState()
  historyPush(s, 'A')
  s._histLastPushAt = Date.now() - 500 // window expired
  historyPush(s, 'B')
  assert.equal(s.undoStack.length, 2, 'outside the window both entries stack as before')
  assert.deepEqual(s.undoStack, ['A', 'B'])
})

test('w21-1: repeat-task scenario — outer toggle baseline survives the nested renewal addTodo push', () => {
  const s = freshState()
  const beforeToggle = JSON.stringify({ todoList: [{ taskId: 'r1', complete: false }], recycleList: [] })
  const afterToggleBeforeRenewal = JSON.stringify({ todoList: [{ taskId: 'r1', complete: true }], recycleList: [] })
  const afterRenewal = JSON.stringify({ todoList: [{ taskId: 'r1', complete: true, updateTime: 2 }], recycleList: [] })
  historyPush(s, beforeToggle) // before-hook of the outer toggleComplete
  historyPush(s, afterToggleBeforeRenewal) // before-hook of the NESTED renewal addTodo (old code overwrote the baseline here)
  historyPush(s, afterRenewal) // before-hook of a further nested dispatch
  assert.equal(s.undoStack.length, 1)
  assert.equal(s.undoStack[0], beforeToggle, 'one undo lands on the pre-toggle state — the "complete" step stays undoable')
})

/* ---------- fix 2: yesterday filter uses the same coarse diff caliber as the loop ---------- */

const today = +dayjs().startOf('day')

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

test('w21-2: drifted yesterday dayStart lands in yesterdayTodoList AND the expired side consistently', async () => {
  // A few hours INTO yesterday (past its midnight): coarse round gives -1, the old strict === missed it
  const driftedEarly = today - DAY_MS + 5 * 3600 * 1000
  // A few hours BEFORE yesterday's midnight (drifted clock): coarse round still gives -1, old === missed it
  const driftedLate = today - DAY_MS - 5 * 3600 * 1000
  const store = buildStore([
    row('drift-early', { dayStart: driftedEarly }),
    row('drift-late', { dayStart: driftedLate }),
    row('exact-yesterday', { dayStart: today - DAY_MS }),
    row('today', { dayStart: today })
  ])
  await store.dispatch('todo/computeViews')
  const yIds = store.state.todo.views.yesterdayTodoList.map(t => t.taskId)
  assert.ok(yIds.includes('drift-early'), 'drifted-early row is grouped as yesterday (was silently dropped by the strict ===)')
  assert.ok(yIds.includes('drift-late'), 'drifted-late row stays grouped as yesterday')
  assert.ok(yIds.includes('exact-yesterday'), 'exact yesterday row unchanged')
  assert.ok(!yIds.includes('today'), 'today row not misfiled into yesterday')
  // Consistency with the loop's coarse buckets: a coarse -1 row must not appear in today/tomorrow
  const views = store.state.todo.views
  const allGrouped = [
    ...views.recent.today.map(t => t.taskId),
    ...views.recent.tomorrow.map(t => t.taskId),
    ...views.recent.dayAfterTomorrow.map(t => t.taskId)
  ]
  for (const id of ['drift-early', 'drift-late', 'exact-yesterday']) {
    assert.ok(!allGrouped.includes(id), `${id} does not double-list in the today/tomorrow/after2 groups`)
  }
})

test('w21-2: helper source — yesterday filter carries the coarse Math.round caliber (no strict === on dayStart)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../renderer/js/store/helpers/todoComputeViews.js'), 'utf8')
  const m = src.match(/const yesterday = live\.filter\([\s\S]*?\}\)/)
  assert.ok(m, 'yesterday filter block found')
  assert.ok(m[0].includes('Math.round'), 'uses the same coarse round diff as the main loop')
  assert.ok(!m[0].includes('=== +dayjs'), 'no strict dayStart === (startOf day -1) comparison left')
})
