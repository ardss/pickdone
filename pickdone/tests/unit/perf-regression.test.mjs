/**
 * Performance regression gate (SOP-06 supplement 8) - core compute paths must have quantified ceilings under large data volumes;
 * jank previously could only be discovered by user feel. Thresholds leave headroom for CI/slow machines and only catch order-of-magnitude degradations.
 * Run: npm test (auto-discovered by run-all)
 */
import '../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import todo from '../../renderer/js/store/todo.js'

const DAY = 86400000
const N = 5000

function bigState () {
  const now = Date.now()
  const cats = ['cat-a', 'cat-b', 'cat-c', '']
  const todoList = []
  for (let i = 0; i < N; i++) {
    todoList.push({
      taskId: 'p' + i,
      taskContent: '性能样本任务 ' + i + (i % 7 === 0 ? ' #标签' + i : ''),
      taskDescribe: i % 5 === 0 ? '描述文本'.repeat(20) : '',
      complete: i % 3 === 0,
      delete: false,
      todoTime: now + (i % 60 - 30) * DAY, // spread over +/-30 days
      createTime: now - i * 1000,
      updateTime: now - i * 500,
      completedAt: i % 3 === 0 ? now - (i % 14) * DAY : 0,
      categoryId: cats[i % 4] === '' ? 0 : i % 4,
      subtasks: i % 11 === 0 ? JSON.stringify([{ text: '子任务', done: i % 2 === 0 }]) : '',
      priority: i % 4,
      difficulty: i % 3
    })
  }
  return todoList
}

function fakeCtx (todoList) {
  const s = {
    todoList, recycleList: [], views: {}, viewsDirty: true,
    todosVersion: 0, version: 1, remoteVersion: 0, isSyncing: false,
    recentlyAddedTaskId: null, lastCreatedTodoTaskId: null, holidayList: []
  }
  return s
}

test(`perf: ${N} tasks computeViews full grouping computation`, async () => {
  const s = fakeCtx(bigState())
  const settings = { expCompletedTodoRange: '7d', expUncompletedTodoRange: '30d', upcomingTodoRange: '7d', showCompleted: true, showNoDate: true, sortMode: 'custom' }
  const rootState = { settings, todo: s }
  const ctx = {
    state: s, rootState,
    commit: (type, p) => { if (type === 'setViews') s.views = p },
    dispatch: async () => {}
  }
  const t0 = performance.now()
  // Inside a Vuex action this points to the store instance (computeViews reads this.state.todo)
  await todo.actions.computeViews.call({ state: { todo: s } }, ctx)
  const cost = performance.now() - t0
  const total = Object.values(s.views).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
  assert.ok(total > 0, `view arrays non-empty (the computation really happened), keys=${Object.keys(s.views).join(',')}`)
  assert.ok(cost < 3000, `computeViews took ${Math.round(cost)}ms for ${N} tasks, over the 3s ceiling (order-of-magnitude degradation)`)
  console.log(`    computeViews(${N}) = ${Math.round(cost)}ms`)
})

test(`perf: ${N} tasks review metrics build`, async () => {
  const { buildReviewMetrics } = await import('../../renderer/js/views/statistics/metrics.js')
  const todoList = bigState()
  const records = []
  for (let i = 0; i < 500; i++) {
    records.push({ succeed: true, focusDuration: 25, endTime: String(Date.now() - (i % 30) * DAY), dateKey: '' })
  }
  const period = { start: Date.now() - 7 * DAY, end: Date.now() + DAY, label: '近7天', days: 8 }
  const t0 = performance.now()
  const m = buildReviewMetrics({ todos: todoList, records, catNameOf: () => '未分类' }, period)
  const cost = performance.now() - t0
  assert.ok(m.done >= 0 && m.focusMins >= 0, 'metric structure complete')
  assert.ok(cost < 2000, `buildReviewMetrics took ${Math.round(cost)}ms, over the 2s ceiling`)
  console.log(`    buildReviewMetrics(${N}+500) = ${Math.round(cost)}ms`)
})
