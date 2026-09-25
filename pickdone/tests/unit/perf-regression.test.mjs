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
  // best-of-3 (2026-09-25 pre-commit 实锤:满载机器单次测量撞 3s 天花板,同 review-metrics 的
  // 暂停噪声问题)——min() 剔除 GC/JIT/并行负载暂停,真实量级退化每次都慢,天花板仍有效
  const runOnce = async () => {
    const t0 = performance.now()
    // Inside a Vuex action this points to the store instance (computeViews reads this.state.todo)
    await todo.actions.computeViews.call({ state: { todo: s } }, ctx)
    return performance.now() - t0
  }
  const cost = Math.min(await runOnce(), await runOnce(), await runOnce())
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
  // Control run on 1/8 of the data measures the MACHINE's current speed, not a fixed wall-clock
  // number: under the unit wall's parallel load a fixed 2s ceiling measured the load, not the
  // code (2026-09-23). The assertion is now the amplification ratio big-vs-control with a 20x
  // margin — an order-of-magnitude algorithmic regression still fails; shared-CPU noise doesn't.
  const control = todoList.slice(0, Math.ceil(todoList.length / 8))
  // best-of-3 for both runs: a single GC/JIT pause mid-measurement (common under the unit wall's
  // parallel load — 2026-09-25 full-suite red with cost > 20x control while the isolated run sat
  // at 5x) must not read as an algorithmic regression. min() strips pauses; real slowdowns raise
  // every repetition, so the 20x ceiling still catches order-of-magnitude regressions.
  const run = (todos, recs) => {
    const t = performance.now()
    buildReviewMetrics({ todos, records: recs, catNameOf: () => '未分类' }, period)
    return Math.max(performance.now() - t, 1)
  }
  const ctrlCost = Math.min(run(control, records.slice(0, 63)), run(control, records.slice(0, 63)), run(control, records.slice(0, 63)))
  const m = buildReviewMetrics({ todos: todoList, records, catNameOf: () => '未分类' }, period) // warm-up outside timing
  const cost = Math.min(run(todoList, records), run(todoList, records), run(todoList, records))
  assert.ok(m.done >= 0 && m.focusMins >= 0, 'metric structure complete')
  assert.ok(cost < ctrlCost * 20, `buildReviewMetrics took ${Math.round(cost)}ms vs ${Math.round(ctrlCost)}ms control — over the 20x amplification ceiling`)
  console.log(`    buildReviewMetrics(${N}+500) = ${Math.round(cost)}ms (control ${Math.round(ctrlCost)}ms)`)
})
