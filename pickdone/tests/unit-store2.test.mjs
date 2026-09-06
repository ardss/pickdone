/**
 * Supplementary unit tests - nlDate week/month/year phrases, the store/todo action layer (soft delete/restore/reschedule derivation/completion cascade/history stack),
 * core / repeat boundaries. Goal: first-party code coverage >=90%.
 */
import './setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseNaturalDate } from '../renderer/js/utils/nlDate.js'
import { expandRepeatDates } from '../renderer/js/utils/repeat.js'
import { genTaskId, parseJSONSafe, reportError, dayjs, DAY_MS } from '../renderer/js/utils/core.js'

const base = dayjs(new Date(2026, 7, 28)) // 2026-08-28, Friday

test('nlDate: next Monday / Monday-after-next / this Sunday', () => {
  const a = parseNaturalDate('下周一开会', base)
  assert.equal(a.label, '下周一')
  assert.equal(a.date.isoWeekday(), 1)
  assert.equal(a.restText, '开会')

  const b = parseNaturalDate('下下周五交稿', base)
  assert.equal(b.label, '下下周五')
  assert.equal(b.date.isoWeekday(), 5)

  const c = parseNaturalDate('本周日复盘', base)
  assert.equal(c.label, '本周日')
  assert.equal(c.date.isoWeekday(), 7)
})

test('nlDate: weekend -> this weeks Saturday', () => {
  const r = parseNaturalDate('周末整理笔记', base)
  assert.equal(r.label, '周末')
  assert.equal(r.date.isoWeekday(), 6)
  assert.equal(r.restText, '整理笔记')
})

test('nlDate: N weeks later / N months later / three-years-after X月X日', () => {
  const a = parseNaturalDate('三周后验收', base)
  assert.equal(a.label, '3周后')
  assert.equal(a.date.diff(base, 'day'), 21)

  const b = parseNaturalDate('两个月后回访', base)
  assert.equal(b.label, '2个月后')
  assert.equal(b.date.month(), base.month() + 2)

  const c = parseNaturalDate('大后年10月1日')
  assert.equal(c.label, '大后年10月1日')
  assert.equal(c.date.year(), 2029)
  assert.equal(c.date.month(), 9)
  assert.equal(c.date.date(), 1)
})

test('nlDate: unparseable input returns restText unchanged', () => {
  const r = parseNaturalDate('随便什么时候', base)
  assert.equal(r.date, null)
  assert.equal(r.restText, '随便什么时候')
})

test('core: genTaskId unique / parseJSONSafe tolerant / reportError does not throw / DAY_MS', () => {
  const a = genTaskId('u1', 1000)
  const b = genTaskId('u1', 1000)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('tid_'))

  assert.deepEqual(parseJSONSafe('{"k":1}'), { k: 1 })
  assert.equal(parseJSONSafe('not-json'), null)
  assert.doesNotThrow(() => reportError('x', new Error('boom')))
  assert.equal(DAY_MS, 86400000)
})

test('repeat: month/year rules - intervals and instance counts', () => {
  const BASE = new Date(2026, 7, 28).getTime()
  const monthly = expandRepeatDates(BASE, { repeatType: '月', repeatInterval: 1 })
  assert.ok(monthly.length >= 3)
  assert.ok(Math.abs(+monthly[1] - +monthly[0]) / DAY_MS >= 28, 'monthly instances are at least 28 days apart')

  const yearly = expandRepeatDates(BASE, { repeatType: '年', repeatInterval: 1 })
  assert.ok(yearly.length >= 3)
  assert.ok(Math.abs(+yearly[1] - +yearly[0]) / DAY_MS >= 364, 'yearly instances are at least 364 days apart')
})

/* ---------- store/todo action layer: real actions driven through a stubbed bridge ---------- */

import todo from '../renderer/js/store/todo.js'
import settings from '../renderer/js/store/settings.js'

const upserts = []
globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    if (op === 'upsert' || op === 'upsertMany') { upserts.push(params); return true }
    if (op === 'getMeta') return null
    return true
  },
  deleteFile: async () => true,
  notification: async () => {}
}

const DAY = 86400000
const today0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
const T = (over = {}) => ({
  taskId: 't' + Math.random().toString(36).slice(2),
  taskContent: '任务', dayStart: today0, todoTime: today0, createTime: Date.now(),
  updateTime: Date.now(), complete: false, delete: false, taskSort: 0, status: 'sync', version: 1,
  ...over
})
const makeCtx = (todoState, settingsPatch = {}) => {
  const committed = []
  const dispatched = []
  const ctx = {
    commit (n, p) {
      committed.push([n, p])
      if (n === 'upsertLocal') { todo.mutations.upsertLocal(todoState, p); return }
      if (n === 'historyPush') { todo.mutations.historyPush(todoState, p); return }
      if (n === 'historyRestore' || n === 'setTodoList') {
        // Reuse the real mutations / replace the snapshot directly
        if (n === 'historyRestore') todo.mutations.historyRestore(todoState, p)
        else if (Array.isArray(p)) todoState.todoList = p
      }
    },
    dispatch (n, p) { dispatched.push([n, p]) },
    state: { todo: todoState, todoList: todoState.todoList, recycleList: todoState.recycleList || [], undoStack: todoState.undoStack || [], redoStack: todoState.redoStack || [] },
    rootState: { settings: { ...settings.state, recycleBinAutoDeleteDays: 30, ...settingsPatch } }
  }
  const fakeThis = { state: { todo: todoState } }
  // dispatch forwards to the real updateTodoFields/computeViews (toggleComplete relies on them for persistence and derivation)
  ctx.dispatch = (n, p) => {
    dispatched.push([n, p])
    if (n === 'updateTodoFields') return todo.actions.updateTodoFields.call(fakeThis, ctx, p)
    if (n === 'computeViews') return todo.actions.computeViews.call(fakeThis, ctx)
  }
  return { ctx, committed, dispatched, fakeThis }
}

test('todo action: deleteTodo - sets the local deleted state + deletedAt and persists via safeUpsert', async () => {
  const st = { todoList: [T({ taskId: 'x1' })], recycleList: [] }
  const { ctx, committed, fakeThis } = makeCtx(st)
  const target = st.todoList[0]
  await todo.actions.deleteTodo.call(fakeThis, ctx, target)
  assert.equal(st.todoList.length, 0, 'the live list should have it removed')
  const local = st.recycleList.find(t => t.taskId === 'x1')
  assert.ok(local, 'it should move into the recycle bin')
  assert.equal(local.delete, true)
  assert.ok(local.deletedAt > 0)
  assert.equal(local.status, 'delete')
  assert.equal(committed[0][0], 'upsertLocal')
  assert.ok(upserts.length > 0)
})

test('todo action: restoreFromRecycle - delete reset to 0, deletedAt reset to 0, computeViews re-run', async () => {
  const row = T({ taskId: 'x2', delete: true, deleting: true, deletedAt: today0 - DAY })
  const st = { todoList: [], recycleList: [row] }
  const { ctx, committed, fakeThis } = makeCtx(st)
  await todo.actions.restoreFromRecycle.call(fakeThis, ctx, row)
  // upsertLocal moves the restored row back into todoList (replaced with a new object); assert against the new object
  const restored = st.todoList.find(t => t.taskId === 'x2')
  assert.ok(restored, 'it should move back from the recycle bin into todoList')
  assert.equal(restored.delete, false)
  assert.equal(restored.deletedAt, 0)
  assert.equal(restored.status, 'update')
  assert.ok(committed.some(([n]) => n === 'upsertLocal'))
})

test('todo action: updateTodoFields - changing todoTime derives dayStart automatically', async () => {
  const tomorrow = today0 + DAY
  const row = T({ taskId: 'x3', dayStart: today0 })
  const st = { todoList: [row], recycleList: [] }
  const { ctx, fakeThis } = makeCtx(st)
  await todo.actions.updateTodoFields.call(fakeThis, ctx, { taskId: 'x3', patch: { todoTime: tomorrow + 3600000 } })
  assert.equal(row.dayStart, tomorrow)
  assert.equal(row.todoTime, tomorrow + 3600000)
})

test('todo action: toggleComplete - completion writes completedAt and the main task cascades checking its subtasks', async () => {
  const subs = [{ text: '子1', checked: false }, { text: '子2', checked: false }]
  const parent = T({ taskId: 'p1', subtasks: JSON.stringify(subs) })
  const st = { todoList: [parent], recycleList: [] }
  const { ctx, fakeThis } = makeCtx(st)
  await todo.actions.toggleComplete.call(fakeThis, ctx, parent)
  assert.equal(parent.complete, true)
  assert.ok(parent.completedAt > 0)
  const after = JSON.parse(parent.subtasks)
  assert.ok(after.every(s => s.checked), 'isCompleteWithSubtasks defaults on: completing the main task cascades checking subtasks')
})

test('todo action: history stack - undo rolls content back after push', async () => {
  const row = T({ taskId: 'h1', taskContent: '原' })
  const st = { todoList: [row], recycleList: [], undoStack: [], redoStack: [], _histLastPushAt: 0 }
  const { ctx, fakeThis } = makeCtx(st)
  // Push the original snapshot before editing; then simulate an edit changing it
  ctx.commit('historyPush', JSON.stringify(JSON.parse(JSON.stringify(st))))
  st.todoList[0].taskContent = '改'
  assert.equal(st.todoList[0].taskContent, '改')
  const r = await todo.actions.undo.call(fakeThis, ctx)
  assert.equal(r.ok, true)
  assert.equal(st.todoList[0].taskContent, '原')
})

test('settings action: update - commit merge + calls the main process updateSettings', async () => {
  const calls = []
  globalThis.window.todoAPI.updateSettings = async p => calls.push(p)
  const state = { ...settings.state }
  await settings.actions.update(
    { commit: (n, p) => settings.mutations.updateSettings(state, p) },
    { weatherCity: '北京' }
  )
  assert.equal(state.weatherCity, '北京')
  assert.deepEqual(calls[calls.length - 1], { weatherCity: '北京' })
})
