/**
 * Round-3 perf (ux-perf-finding-10): TodayXView's `groups` computed used to filter+sort the raw
 * todoList itself (two O(n) scans + one O(n log n) sort per recompute). It now reads the store's
 * precomputed views `todayXNext` / `todayXOpen`, built inside todo/computeViews.
 *
 * Guards (pure perf change — behavior must be preserved exactly):
 *   [1] equivalence: for a mixed fixture set, the groups computed over the NEW store views are
 *       identical (keys/counts/order) to the OLD direct-filter composition over the same raw list
 *   [2] uncapped x-next: an overdue task OLDER than expUncompletedDays still appears in the Next
 *       group (composing from recent.expiredUncompleted would silently drop it — the reason the
 *       store needed two new views instead of reusing existing ones)
 *   [3] x-open is independent of settings.showNoDate (TodayX always shows the unscheduled group;
 *       recent.noDate is gated and must not be substituted)
 *   [4] the TodayXView groups computed actually reads the new views (fails without the fix)
 *
 * Run: node --test tests/unit/renderer/round3-todayx-views.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from 'vuex'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import todo from '../../../renderer/js/store/todo.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const DAY = 86400000
const today = +dayjs().startOf('day')

const buildStore = (rows, settings = {}) => createStore({
  modules: {
    todo: { ...todo, state: () => ({ ...todo.state(), todoList: rows, viewsDirty: true }) },
    settings: {
      namespaced: true,
      state: { recycleBinAutoDeleteDays: 0, showNoDate: false, todoBoxCategoryId: -1, todoBoxSortOrder: 'asc', todoBoxSortMethod: 'created', sortMode: 'default', ...settings }
    }
  }
})

const row = (id, patch = {}) => ({
  taskId: id, taskContent: id, delete: false, complete: false,
  dayStart: 0, todoTime: 0, createTime: 1000, updateTime: 1000, completedAt: 0,
  ...patch
})

/** The OLD composition, verbatim from TodayXView.vue before the fix (filter + sort over raw todoList). */
function oldGroups (todoList, today0) {
  const undone = todoList
    .filter(t => !t.delete && !t.complete && t.dayStart && t.dayStart <= today0)
    .sort((x, y) => (x.dayStart - y.dayStart) || (x.todoTime - y.todoTime))
  const open = todoList.filter(t => !t.delete && !t.complete && !t.dayStart)
  return { next: undone, open }
}

async function viewsFor (rows, settings) {
  const store = buildStore(rows, settings)
  await store.dispatch('todo/computeViews')
  return store.state.todo.views
}

test('x-next + x-open via store views are identical to the old direct-filter composition', async () => {
  const rows = [
    row('today-a', { dayStart: today, todoTime: today + 3600000 }),
    row('today-b', { dayStart: today, todoTime: today }),
    row('overdue-1', { dayStart: today - DAY, todoTime: today - DAY }),
    row('overdue-40', { dayStart: today - 40 * DAY }), // older than the 30d uncompleted cap
    row('overdue-done', { dayStart: today - DAY, complete: true, completedAt: Date.now() }),
    row('tomorrow', { dayStart: today + DAY }),
    row('no-date-a'),
    row('no-date-b'),
    row('no-date-done', { complete: true, completedAt: today - 2 * DAY }),
    row('deleted', { delete: true }),
    row('future', { dayStart: today + 90 * DAY })
  ]
  const views = await viewsFor(rows)
  const old = oldGroups(rows, today)
  assert.deepEqual(views.todayXNext, old.next, 'x-next: same members, same (dayStart, todoTime) order')
  assert.deepEqual(views.todayXOpen, old.open, 'x-open: same members, same raw-list order')
  // overdue-40 must be IN x-next (uncapped) even though it is outside recent.expiredUncompleted
  assert.ok(views.todayXNext.some(t => t.taskId === 'overdue-40'))
  assert.ok(!views.recent.expiredUncompleted.some(t => t.taskId === 'overdue-40'), 'sanity: the capped view drops it')
})

test('x-next is uncapped: an overdue task older than expUncompletedDays stays in the Next group', async () => {
  const rows = [row('ancient', { dayStart: today - 200 * DAY, todoTime: today - 200 * DAY })]
  const views = await viewsFor(rows, { expiredUncompletedTodoRange: '30d' })
  assert.deepEqual(views.todayXNext.map(t => t.taskId), ['ancient'])
  assert.deepEqual(views.recent.expiredUncompleted, [], 'the Recent view stays capped — the two views are distinct')
})

test('x-open ignores settings.showNoDate (TodayX always shows the unscheduled group)', async () => {
  const rows = [row('unsched')]
  const hidden = await viewsFor(rows, { showNoDate: false })
  assert.deepEqual(hidden.todayXOpen.map(t => t.taskId), ['unsched'])
  assert.deepEqual(hidden.recent.noDate, [], 'recent.noDate stays gated by showNoDate — not a substitute')
  const shown = await viewsFor(rows, { showNoDate: true })
  assert.deepEqual(shown.todayXOpen.map(t => t.taskId), ['unsched'])
})

test('TodayXView groups computed reads the precomputed views (not the raw todoList)', async () => {
  const rows = [
    row('t1', { dayStart: today, todoTime: today + 1 }),
    row('o1', { dayStart: today - 3 * DAY }),
    row('n1')
  ]
  const views = await viewsFor(rows)
  // eval the groups computed from the SFC (source-level wiring guard, same technique as views-undo F5)
  const src = read('renderer/js/views/TodayXView.vue')
  const start = src.indexOf('groups () {')
  assert.ok(start >= 0, 'TodayXView groups computed present')
  const end = src.indexOf('\n  },', start) // end of the computed block (CRLF-safe)
  const chunk = src.slice(start, end).trim()
  const groups = new Function(`const computed = { ${chunk} }; return computed.groups`)()
    .call({ v: views, $t: k => k })
  assert.deepEqual(groups.map(g => g.key), ['x-next', 'x-open'])
  assert.deepEqual(groups[0].todos.map(t => t.taskId), ['o1', 't1'])
  assert.deepEqual(groups[1].todos.map(t => t.taskId), ['n1'])
  assert.ok(!src.includes("this.$store.state.todo.todoList\n        .filter"), 'groups must not re-filter the raw todoList anymore')
})
