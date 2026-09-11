/**
 * Vuex store module unit tests - mutations called as pure functions / actions invoked with a fake bound context,
 * without starting a real Vuex container. Covers the three areas at highest recent regression risk:
 *   settings (merge/persistence) - ui (settings-modal open/close chain) - todo (computeViews view-grouping semantics + recycle-bin auto clear)
 * Run: npm test
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import settings from '../../../renderer/js/store/settings.js'
import ui from '../../../renderer/js/store/ui.js'
import todo from '../../../renderer/js/store/todo.js'

const DAY = 86400000
const today0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()

/* ---------- settings: merge and persistence ---------- */

test('settings: updateSettings merges the patch and writes localStorage', async () => {
  const state = { ...settings.state }
  settings.mutations.updateSettings(state, { weatherEnabled: true, weatherCity: '上海' })
  assert.equal(state.weatherEnabled, true)
  assert.equal(state.weatherCity, '上海')
  // persist is a 150ms debounced write
  await new Promise(r => setTimeout(r, 250))
  const saved = JSON.parse(globalThis.localStorage.getItem('settingsState'))
  assert.equal(saved.weatherCity, '上海')
})

test('settings: restore merges with DEFAULT_SETTINGS as the backstop', () => {
  const state = {}
  settings.mutations.restore(state, { colorMode: 'dark' })
  assert.equal(state.colorMode, 'dark')
  assert.equal(typeof state.recycleBinAutoDeleteDays, 'number')
  assert.equal(state.weekStartDay, 'mon')
})

test('settings: defaults - weather off by default, source open-meteo', () => {
  assert.equal(settings.state.weatherEnabled, false)
  assert.equal(settings.state.weatherSource, 'open-meteo')
})

/* ---------- ui: settings modal toggling (gear -> toggleSettings -> v-if) ---------- */

test('ui: toggleSettings set-true/toggle/string-arg safety', () => {
  const s = { showSettingsModal: false }
  ui.mutations.toggleSettings(s, true)
  assert.equal(s.showSettingsModal, true)
  ui.mutations.toggleSettings(s, undefined)
  assert.equal(s.showSettingsModal, false)
  ui.mutations.toggleSettings(s, false)
  assert.equal(s.showSettingsModal, false)
})

/* ---------- todo: computeViews view-grouping semantics (driven by fake this/ctx) ---------- */

function makeTodoCtx (todoState, settingsPatch = {}) {
  const committed = []
  const dispatched = []
  const ctx = {
    commit (name, payload) { committed.push([name, payload]) },
    dispatch (name, payload) { dispatched.push([name, payload]) },
    // Note: actions like purgeExpiredRecycle destructure state from ctx, while computeViews takes state via this
    state: { todo: todoState, recycleList: todoState.recycleList },
    rootState: { settings: { ...settings.state, recycleBinAutoDeleteDays: 30, ...settingsPatch } }
  }
  const fakeThis = { state: { todo: todoState } }
  return { committed, dispatched, run: () => todo.actions.computeViews.call(fakeThis, ctx) }
}

const baseTodoState = (todoList, recycleList = []) => ({
  todoList, recycleList, todayTimestamp: Date.now(), holidayList: []
})
const T = (over = {}) => ({
  taskId: 't' + Math.random().toString(36).slice(2),
  taskContent: '任务', dayStart: today0, todoTime: today0, createTime: Date.now(),
  updateTime: Date.now(), complete: false, delete: false, taskSort: 0,
  ...over
})
const viewsOf = (committed) => committed.find(([n]) => n === 'setViews')[1]

test('todo: computeViews - groups today/tomorrow/day-after/future/no-date/overdue-incomplete', async () => {
  const list = [
    T({ taskId: 'a', dayStart: today0 }),
    T({ taskId: 'b', dayStart: today0 + DAY }),
    T({ taskId: 'c', dayStart: today0 + 2 * DAY }),
    T({ taskId: 'd', dayStart: today0 + 10 * DAY }),
    T({ taskId: 'e', dayStart: 0 }),                       // no date
    T({ taskId: 'f', dayStart: today0 - 3 * DAY })         // overdue, incomplete
  ]
  const { committed, dispatched, run } = makeTodoCtx(baseTodoState(list))
  await run()
  const v = viewsOf(committed)
  assert.deepEqual(v.todayTodoList.map(t => t.taskId), ['a'])
  assert.equal(v.recent.tomorrow[0].taskId, 'b')
  assert.equal(v.recent.dayAfterTomorrow[0].taskId, 'c')
  assert.equal(v.recent.upcoming[0].taskId, 'd')
  assert.equal(v.recent.noDate[0].taskId, 'e')
  assert.equal(v.recent.expiredUncompleted[0].taskId, 'f')
  assert.equal(v.recent.expiredCompleted.length, 0)
  // purgeExpiredRecycle was triggered
  assert.ok(dispatched.some(([n]) => n === 'purgeExpiredRecycle'))
})

test('todo: today-completed grouped by completedAt (due yesterday, completed today -> completed today)', async () => {
  const list = [
    T({ taskId: 'done-today', dayStart: today0 - DAY, complete: true, completedAt: today0 + 3600000 }),
    T({ taskId: 'done-old', dayStart: today0 - 5 * DAY, complete: true, completedAt: today0 - 4 * DAY })
  ]
  const { committed, run } = makeTodoCtx(baseTodoState(list))
  await run()
  const v = viewsOf(committed)
  assert.deepEqual(v.todayDoneList.map(t => t.taskId), ['done-today'])
  // Expired-completed: dayStart < today and completion time within the retention window (done-today is also here because its due date passed - dual grouping)
  assert.deepEqual(v.recent.expiredCompleted.map(t => t.taskId), ['done-old', 'done-today']) // ascending by dayStart
})

test('todo: retention range "today" semantics (previously misparsed as 7 days by a NaN fallback)', async () => {
  const twoDaysAgoDone = T({ taskId: 'old', dayStart: today0 - 2 * DAY, complete: true, completedAt: today0 - 2 * DAY })
  const { committed, run } = makeTodoCtx(baseTodoState([twoDaysAgoDone]), { expiredCompletedTodoRange: 'today' })
  await run()
  assert.equal(viewsOf(committed).recent.expiredCompleted.length, 0)

  const { committed: c2, run: r2 } = makeTodoCtx(baseTodoState([twoDaysAgoDone]), { expiredCompletedTodoRange: '7d' })
  await r2()
  assert.equal(viewsOf(c2).recent.expiredCompleted.length, 1)
})

test('todo: recycle-bin view sorted by update time descending + soft-deleted tasks stay out of live views', async () => {
  const list = [T({ taskId: 'live', dayStart: today0 })]
  const recycle = [
    T({ taskId: 'r1', delete: true, updateTime: 100 }),
    T({ taskId: 'r2', delete: true, updateTime: 200 })
  ]
  const { committed, run } = makeTodoCtx(baseTodoState(list, recycle))
  await run()
  const v = viewsOf(committed)
  assert.deepEqual(v.recycleBin.map(t => t.taskId), ['r2', 'r1'])
  assert.ok(!v.todayTodoList.some(t => t.taskId.startsWith('r')))
})

test('todo: purgeExpiredRecycle - only clears recycled tasks past retention; days=0 (never) is a no-op', async () => {
  const old = T({ taskId: 'old', delete: true, deletedAt: today0 - 31 * DAY })
  const fresh = T({ taskId: 'fresh', delete: true, deletedAt: today0 - DAY })
  {
    const dispatched = []
    const ctx = { state: { recycleList: [old, fresh] }, commit () {}, dispatch: async (n, p) => dispatched.push([n, p]), rootState: { settings: { recycleBinAutoDeleteDays: 30 } } }
    await todo.actions.purgeExpiredRecycle.call({}, ctx)
    const purge = dispatched.find(([n]) => n === 'purgeIds')
    assert.deepEqual(purge[1], ['old'])
  }
  {
    const dispatched = []
    const ctx = { state: { recycleList: [old] }, commit () {}, dispatch: async (n, p) => dispatched.push([n, p]), rootState: { settings: { recycleBinAutoDeleteDays: 0 } } }
    await todo.actions.purgeExpiredRecycle.call({}, ctx)
    assert.equal(dispatched.length, 0)
  }
})

test('todo: inbox sorting (by creation date descending) and count stats', async () => {
  const list = [
    T({ taskId: 'n1', dayStart: 0, createTime: 100 }),
    T({ taskId: 'n2', dayStart: 0, createTime: 300 }),
    T({ taskId: 'n3', dayStart: 0, createTime: 200 })
  ]
  const { committed, run } = makeTodoCtx(baseTodoState(list), { todoBoxCategoryId: -1 })
  await run()
  const v = viewsOf(committed)
  assert.deepEqual(v.todoBox.map(t => t.taskId), ['n2', 'n3', 'n1'])
  assert.equal(v.todoBoxCount, 3)
})
