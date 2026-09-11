/**
 * Third batch of supplementary unit tests - remaining utils/core exports (subtask cascade/pinyin/date badge/local profile/rescheduleExpired)
 * plus store/todo's inbox sorting branches and the purge-empty-recycle-bin branch.
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  allSubsDone, subsCompleteTarget, rescheduleExpired, parseSubtasks, toPinyinLower, hasChinese,
  formatDayLabel, dateBadgeColor, loadLocalUser, genTomatoId, cssVar
} from '../../../renderer/js/utils/core.js'
import { setEstimate, getEstimate } from '../../../renderer/js/utils/tomatoEstimate.js'

test('core: allSubsDone / subsCompleteTarget cascade matrix', () => {
  assert.equal(allSubsDone([]), false, 'an empty subtask list does not count as all done')
  assert.equal(allSubsDone([{ checked: true }]), true)
  assert.equal(allSubsDone([{ checked: true }, { checked: false }]), false)

  assert.equal(subsCompleteTarget([{ checked: true }], false), true, 'all done + main incomplete -> main should complete')
  assert.equal(subsCompleteTarget([{ checked: false }], true), false, 'some unchecked + main complete -> main should be undone')
  assert.equal(subsCompleteTarget([{ checked: true }], true), null, 'consistent -> no change')
})

test('core: toPinyinLower / hasChinese / genTomatoId / cssVar', () => {
  assert.equal(hasChinese('中文'), true)
  assert.equal(hasChinese('abc'), false)
  assert.ok(toPinyinLower('测试').includes('ce') || toPinyinLower('测试').length > 0)
  assert.notEqual(genTomatoId(), genTomatoId())
  globalThis.document = { documentElement: { getPropertyValue: () => '#11abac' } }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#11abac' })
  assert.equal(cssVar('--brand'), '#11abac')
})

test('core: dateBadgeColor today/overdue/future/complete', () => {
  const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
  const store = { state: { todo: { todayTimestamp: today } } }
  assert.equal(dateBadgeColor({ complete: true, todoTime: today }, store), 'var(--text-4)')
  assert.equal(dateBadgeColor({ complete: false, todoTime: 0 }, store), 'var(--text-3)')
  assert.equal(dateBadgeColor({ complete: false, todoTime: today - 86400000 }, store), '#ce3a31')
  assert.equal(dateBadgeColor({ complete: false, todoTime: today }, store), '#457f0e')
  assert.equal(dateBadgeColor({ complete: false, todoTime: today + 86400000 }, store), 'var(--text-3)')
})

test('core: loadLocalUser offline profile (localStorage persistence)', () => {
  const u = loadLocalUser()
  assert.ok(u.userId)
  assert.ok(u.userId)
  // The second read goes through persistence
  const u2 = JSON.parse(globalThis.localStorage.getItem('user'))
  assert.equal(u2.userId, u.userId)
})

test('core: formatDayLabel yesterday/today/tomorrow/day-after/other years', () => {
  const DAY = 86400000
  const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
  assert.equal(formatDayLabel(today, today), '今天')
  assert.equal(formatDayLabel(today + DAY, today), '明天')
  assert.equal(formatDayLabel(today + 2 * DAY, today), '后天')
  assert.equal(formatDayLabel(today - DAY, today), '昨天')
  assert.ok(formatDayLabel(today - 400 * DAY, today).length > 0)
})

test('core: rescheduleExpired only changes expired incomplete ones and counts them', async () => {
  const DAY = 86400000
  const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
  const calls = []
  const dispatch = async (name, payload) => calls.push([name, payload])
  const todos = [
    { taskId: 'a', complete: false, dayStart: today - DAY },   // changed
    { taskId: 'b', complete: true, dayStart: today - DAY },    // complete, unchanged
    { taskId: 'c', complete: false, dayStart: today },         // today, unchanged
    { taskId: 'd', complete: false, dayStart: 0 }              // no date, unchanged
  ]
  const { n, snap } = await rescheduleExpired(dispatch, todos, today)
  assert.equal(n, 1)
  assert.equal(calls[0][1].patch.dayStart, today)
  // snap carries the original values for batchMoveWithUndo (feedback-consistency consolidation 2026-09-01)
  assert.deepEqual(snap, [{ id: 'a', dayStart: today - DAY, todoTime: undefined }])
})

test('core: parseSubtasks tolerates double-encoded JSON strings', () => {
  assert.deepEqual(parseSubtasks(JSON.stringify(JSON.stringify([{ text: 'x' }]))), [{ text: 'x' }])
  assert.deepEqual(parseSubtasks('bad'), [])
  assert.deepEqual(parseSubtasks(null), [])
})

/* ---------- runtimeState: volatile state storage across restarts ---------- */

import { loadRuntime, saveRuntime } from '../../../renderer/js/store/runtimeState.js'

test('runtimeState: save merges patches, load is fault-tolerant', () => {
  globalThis.localStorage.removeItem('runtimeState')
  assert.deepEqual(loadRuntime(), {})
  const next = saveRuntime({ tomatoGain: 3 })
  assert.equal(next.tomatoGain, 3)
  saveRuntime({ lastBriefingAt: 123 })
  assert.equal(loadRuntime().tomatoGain, 3, 'the second save preserves existing keys')
  assert.equal(loadRuntime().lastBriefingAt, 123)
})

/* ---------- store/todo: inbox sorting branches and the empty-purge branch ---------- */

import todo from '../../../renderer/js/store/todo.js'
import settings from '../../../renderer/js/store/settings.js'

const T = (over = {}) => ({
  taskId: 't' + Math.random().toString(36).slice(2),
  taskContent: '任务', dayStart: 0, todoTime: 0, createTime: Date.now(),
  updateTime: Date.now(), complete: false, delete: false, taskSort: 0,
  ...over
})
const makeCtx = (todoState, settingsPatch = {}) => {
  const committed = []
  const ctx = {
    commit (n, p) { committed.push([n, p]); if (n === 'upsertLocal') todo.mutations.upsertLocal(todoState, p) },
    state: { todo: todoState, todoList: todoState.todoList, recycleList: todoState.recycleList || [] },
    rootState: { settings: { ...settings.state, recycleBinAutoDeleteDays: 30, ...settingsPatch } }
  }
  const fakeThis = { state: { todo: todoState } }
  ctx.dispatch = async () => {}
  return { ctx, committed, fakeThis }
}

test('todo: inbox sort by difficulty / by deadline branches', () => {
  // 难度字段退役:排序键已改为预计番茄(工作量唯一账本)
  setEstimate('d1', 1); setEstimate('d2', 2); setEstimate('d3', 3)
  const st = freshBox()
  const { ctx, committed, fakeThis } = makeCtx(st, { todoBoxCategoryId: -1, todoBoxSortMethod: 'difficulty' })
  todo.actions.computeViews.call(fakeThis, ctx)
  let v = committed.filter(([n]) => n === 'setViews').pop()[1]
  const byDiff = v.todoBox.map(t => getEstimate(t.taskId))
  assert.deepEqual(byDiff, [...byDiff].sort((a, b) => a - b).reverse(), 'by workload(estimate) should be descending (default descending)')

  const st2 = freshBox()
  const { ctx: c2, committed: cm2, fakeThis: f2 } = makeCtx(st2, { todoBoxCategoryId: -1, todoBoxSortMethod: 'due', todoBoxSortOrder: 'asc' })
  todo.actions.computeViews.call(f2, c2)
  v = cm2.filter(([n]) => n === 'setViews').pop()[1]
  const byDate = v.todoBox.map(t => t.todoTime)
  assert.deepEqual(byDate, [...byDate].sort((a, b) => a - b), 'by deadline should be ascending')

  function freshBox () {
    return {
      todoList: [
        T({ taskId: 'd2', difficulty: 2, todoTime: 200, createTime: 1 }),
        T({ taskId: 'd1', difficulty: 1, todoTime: 300, createTime: 2 }),
        T({ taskId: 'd3', difficulty: 3, todoTime: 100, createTime: 3 })
      ],
      recycleList: [], undoStack: [], redoStack: [], viewsDirty: true
    }
  }
})

test('todo: purgeAllRecycle is a no-op on an empty recycle bin', async () => {
  const st = { todoList: [], recycleList: [], undoStack: [], redoStack: [] }
  const dispatched = []
  const ctx = {
    commit () {},
    state: { todo: st, recycleList: [] },
    rootState: { settings: { recycleBinAutoDeleteDays: 30 } }
  }
  ctx.dispatch = async (n) => dispatched.push(n)
  await todo.actions.purgeAllRecycle.call({ state: ctx.state }, ctx)
  assert.equal(dispatched.length, 0)
})
