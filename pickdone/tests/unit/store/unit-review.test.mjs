/**
 * Data-review engine unit tests - metrics.js metric extraction/baselines + insights.js rule-based composition.
 * Covers: normal data, empty data, single-day data, no pomodoro records, missing baselines, period selection.
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewMetrics, pctDiff, doneTsOf } from '../../../renderer/js/views/statistics/metrics.js'
import { composeReview, kpiDelta } from '../../../renderer/js/views/statistics/insights.js'
import { dayjs, DAY_MS } from '../../../renderer/js/utils/core.js'

const catNameOf = id => ({ 1: '学习', 2: '工作' }[id] || '未分类')

/** Builds a "this week" period (Monday 00:00 ~ now) */
function thisWeek (now = dayjs()) {
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  return { start, end: start + 7 * DAY_MS, label: '上周' }
}

const todo = (over = {}) => Object.assign({
  taskId: 't' + Math.random().toString(36).slice(2, 8),
  complete: false, completedAt: 0, updateTime: 0, createTime: 0,
  dayStart: 0, todoTime: 0, categoryId: 1, delete: false
}, over)

const record = (over = {}) => Object.assign({
  tomatoId: 'r' + Math.random().toString(36).slice(2, 8),
  endTime: 0, focusDuration: 25, restDuration: 5, succeed: true, focusTaskId: null
}, over)

test('pctDiff: null without a baseline; normal/zero-baseline/clamping', () => {
  assert.equal(pctDiff(10, null), null)
  assert.equal(pctDiff(10, 0), null)
  assert.equal(pctDiff(12, 10), 20)
  assert.equal(pctDiff(8, 10), -20)
  assert.equal(pctDiff(1000, 10), 199) // clamped
})

test('doneTsOf: completedAt takes precedence over updateTime', () => {
  assert.equal(doneTsOf({ completedAt: 2, updateTime: 3 }), 2)
  assert.equal(doneTsOf({ updateTime: 3 }), 3)
})

test('buildReviewMetrics: a normal week of data', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const todos = [
    todo({ complete: true, completedAt: start + DAY_MS, categoryId: 1 }),
    todo({ complete: true, completedAt: start + 2 * DAY_MS, categoryId: 2 }),
    todo({ complete: true, completedAt: start - 40 * DAY_MS }), // outside the period (history, used for the baseline)
    todo({ createTime: start + DAY_MS, dayStart: 0 }),          // added, incomplete
    todo({ delete: true, complete: true, completedAt: start + DAY_MS }) // deleted, not counted
  ]
  const records = [
    record({ endTime: start + 9 * 3600000 + 25 * 60000, focusDuration: 25, focusTaskId: 'x' }),
    record({ endTime: start + 10 * 3600000 + 25 * 60000, focusDuration: 25, focusTaskId: 'x' }),
    record({ endTime: start + 15 * 3600000 + 25 * 60000, focusDuration: 25, succeed: false })
  ]
  const m = buildReviewMetrics({ todos, records, catNameOf }, thisWeek(now))
  assert.equal(m.done, 2)
  assert.equal(m.added, 1)
  assert.equal(m.focusMins, 50)
  assert.equal(m.tomatoCount, 2)
  assert.equal(m.giveUps, 1)
  assert.ok(m.planned >= 0)
  assert.equal(m.catFocus[0].label, '未分类') // focusTaskId has no matching task
  assert.ok(m.doneByDay.length >= 1 && m.doneByDay.length <= 7)
  assert.ok(m.hourDist[9] === 25 && m.hourDist[10] === 25)
})

test('buildReviewMetrics: empty data does not throw; baseline is null', () => {
  const m = buildReviewMetrics({ todos: [], records: [], catNameOf }, thisWeek())
  assert.equal(m.done, 0)
  assert.equal(m.focusMins, 0)
  assert.equal(m.baseline.done, null)
  assert.equal(m.peakHours, null)
  assert.equal(m.doneRate, null)
})

test('buildReviewMetrics: baseline = the mean daily value of the previous 4 equal-length windows (last-7-days convention)', () => {
  const now = dayjs()
  const start = +now.subtract(7, 'day').startOf('day')
  const period = { start, end: +now, label: '近7天' }
  // The previous 4 equal-length 7-day windows each completed 10 -> baseline daily mean 10/7
  const todos = []
  for (let w = 1; w <= 4; w++) {
    const ws = start - w * 7 * DAY_MS
    for (let i = 0; i < 10; i++) todos.push(todo({ complete: true, completedAt: ws + i * 3600000 }))
  }
  const m = buildReviewMetrics({ todos, records: [], catNameOf }, period)
  const days = Math.round((period.end - period.start) / DAY_MS) // same convention as the implementation (calendar days incl. today)
  assert.equal(m.days, days)
  assert.ok(Math.abs(m.baseline.done - 10 / days) < 0.01)
  const d = pctDiff(0, m.baseline.done)
  assert.equal(d, -100)
})

test('buildReviewMetrics: peak-hour identification', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const records = []
  for (let i = 0; i < 6; i++) records.push(record({ endTime: start + 9 * 3600000 + i * 3600000, focusDuration: 25 }))
  for (let i = 0; i < 1; i++) records.push(record({ endTime: start + 22 * 3600000 + i * 3600000, focusDuration: 25 }))
  const m = buildReviewMetrics({ todos: [], records, catNameOf }, thisWeek(now))
  assert.ok(m.peakHours)
  assert.equal(m.peakHours.startHour, 9)
  assert.ok(m.peakHours.share >= 30)
})

test('composeReview: a calm period outputs a gentle summary with no fabricated insights', () => {
  const now = dayjs()
  const m = buildReviewMetrics({ todos: [], records: [], catNameOf }, thisWeek(now))
  const r = composeReview(m)
  // Architecture: composeReview returns i18n keys (resolved by the view layer); assert structure, not copy
  assert.equal(r.headline.toneKey, 'statsA.Insights.headlineRest')
  assert.ok(r.insights.some(i => i.id === 'quiet'))
  assert.equal(r.advice.length, 0)
})

test('composeReview: a too-low completion rate triggers the overload suggestion; insights <=5, suggestions <=2', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const todos = []
  for (let i = 0; i < 10; i++) {
    todos.push(todo({ dayStart: start + i * DAY_MS, createTime: start + i * DAY_MS }))
    if (i < 2) todos.push(todo({ dayStart: start + i * DAY_MS, complete: true, completedAt: start + i * DAY_MS + 3600000 }))
  }
  const m = buildReviewMetrics({ todos, records: [], catNameOf }, { start, end: +now, label: '本周' })
  const r = composeReview(m)
  assert.ok(r.insights.length <= 5)
  assert.ok(r.advice.length <= 2)
  assert.ok(r.advice.some(a => a.id === 'overload'))
})

test('composeReview: the streak rule triggers gently', () => {
  const now = dayjs()
  const todos = []
  for (let i = 0; i < 5; i++) todos.push(todo({ complete: true, completedAt: +now.startOf('day') - i * DAY_MS + 3600000 }))
  const m = buildReviewMetrics({ todos, records: [], catNameOf }, thisWeek(now))
  const r = composeReview(m)
  assert.ok(r.insights.some(i => i.id === 'streak'))
})

test('kpiDelta: returns null below the significance threshold (avoids noise)', () => {
  assert.equal(kpiDelta(103, 100), null) // +3% is not significant
  const d = kpiDelta(120, 100)
  assert.equal(d.dir, 'up')
  assert.match(d.pct, /^\+20%$/)
})

test('day-count conventions for a complete "last week" vs a partial "this week" period', () => {
  const now = dayjs()
  const s = +now.subtract(1, 'week').startOf('isoWeek').subtract(7, 'day')
  const lastWeek = { start: s, end: s + 7 * DAY_MS, label: '上周' }
  const m = buildReviewMetrics({ todos: [], records: [], catNameOf }, lastWeek)
  assert.equal(m.days, 7)
})

/* ---------- 番茄×完成交叉口径（taskFocus / giveupNotes / 交叉洞察）---------- */

test('buildReviewMetrics: task-level focus aggregation (unlinked goes into the _free bucket)', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const records = [
    record({ endTime: start + 9 * 3600000, focusDuration: 25, focusTaskId: 'a' }),
    record({ endTime: start + 10 * 3600000, focusDuration: 25, focusTaskId: 'a' }),
    record({ endTime: start + 11 * 3600000, focusDuration: 25, focusTaskId: 'b' }),
    record({ endTime: start + 12 * 3600000, focusDuration: 25, focusTaskId: null })
  ]
  const m = buildReviewMetrics({ todos: [], records, catNameOf }, thisWeek(now))
  const byLabel = Object.fromEntries(m.taskFocus.map(i => [i.label, i.value]))
  assert.equal(byLabel.a, 50)
  assert.equal(byLabel.b, 25)
  assert.equal(byLabel._free, 25) // unlinked focus is listed separately, not lost
})

test('buildReviewMetrics: give-up notes collect non-empty abandon reasons with dates', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const records = [
    record({ endTime: start + 9 * 3600000, succeed: false, abandonReason: '被会议打断' }),
    record({ endTime: start + 10 * 3600000, succeed: false, abandonReason: '  ' }), // blank reason not recorded
    record({ endTime: start + 11 * 3600000, succeed: false }) // no reason field not recorded
  ]
  const m = buildReviewMetrics({ todos: [], records, catNameOf }, thisWeek(now))
  assert.equal(m.giveUps, 3)
  assert.equal(m.giveupNotes.length, 1)
  assert.equal(m.giveupNotes[0].text, '被会议打断')
  assert.match(m.giveupNotes[0].label, /^\d{2}\/\d{2}$/)
})

test('buildReviewMetrics: cross-metric days (focus≥25min counts as a focus day)', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const todos = [
    todo({ complete: true, completedAt: start + DAY_MS + 3600000 }),
    todo({ complete: true, completedAt: start + DAY_MS + 7200000 }),
    todo({ complete: true, completedAt: start + 3 * DAY_MS + 3600000 })
  ]
  const records = [
    // Day 1: 50 minutes focused + 2 completions; Day 2: 30 minutes focused + 0 completions; Day 3: 0 focus + 1 completion
    record({ endTime: start + DAY_MS + 9 * 3600000, focusDuration: 25 }),
    record({ endTime: start + DAY_MS + 10 * 3600000, focusDuration: 25 }),
    record({ endTime: start + 2 * DAY_MS + 9 * 3600000, focusDuration: 30 })
  ]
  const m = buildReviewMetrics({ todos, records, catNameOf }, thisWeek(now))
  assert.equal(m.focusNoDoneDays, 1)
  assert.equal(m.focusDaysAvgDone, 1)   // (2+0)/2
  assert.equal(m.noFocusDaysAvgDone, 1) // 1/1
})

test('composeReview: giveup-rate triggers on a high absolute abort ratio (no baseline needed)', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const records = [
    record({ endTime: start + 9 * 3600000, focusDuration: 25 }),
    record({ endTime: start + 10 * 3600000, succeed: false }),
    record({ endTime: start + 11 * 3600000, succeed: false }),
    record({ endTime: start + 12 * 3600000, succeed: false })
  ]
  const m = buildReviewMetrics({ todos: [], records, catNameOf }, thisWeek(now))
  const r = composeReview(m)
  assert.ok(r.insights.some(i => i.id === 'giveup-rate'))
})

test('composeReview: focus-no-done triggers when focus days leave no completions', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const records = []
  for (let i = 1; i <= 3; i++) records.push(record({ endTime: start + i * DAY_MS + 9 * 3600000, focusDuration: 25 }))
  const m = buildReviewMetrics({ todos: [], records, catNameOf }, thisWeek(now))
  assert.equal(m.focusNoDoneDays, 3)
  const r = composeReview(m)
  assert.ok(r.insights.some(i => i.id === 'focus-no-done'))
})

test('composeReview: sync-up triggers when focus days clearly out-complete no-focus days', () => {
  const now = dayjs()
  const start = +now.startOf('isoWeek').subtract(7, 'day')
  const todos = [
    // Focus day (Day 1): 3 completions; no-focus day (Day 2): 1 completion → avg 1
    todo({ complete: true, completedAt: start + DAY_MS + 3600000 }),
    todo({ complete: true, completedAt: start + DAY_MS + 7200000 }),
    todo({ complete: true, completedAt: start + DAY_MS + 10800000 }),
    todo({ complete: true, completedAt: start + 2 * DAY_MS + 3600000 })
  ]
  const records = [record({ endTime: start + DAY_MS + 9 * 3600000, focusDuration: 25 })]
  const m = buildReviewMetrics({ todos, records, catNameOf }, thisWeek(now))
  assert.equal(m.focusDaysAvgDone, 3)
  assert.equal(m.noFocusDaysAvgDone, 1)
  const r = composeReview(m)
  assert.ok(r.insights.some(i => i.id === 'sync-up'))
})
