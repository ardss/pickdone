/** Regression test: statistics-page weekdayModel crash (focusByWeekday undefined) - after the fix buildReviewMetrics must include a 7-element week distribution */
import './setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewMetrics } from '../renderer/js/views/statistics/metrics.js'

const DAY = 86400000
const today = new Date(); today.setHours(12, 0, 0, 0)
const end = +today + DAY
const start = end - 7 * DAY
const todos = [
  { taskId: 'a', taskContent: 'A', complete: true, delete: false, dayStart: start, completedAt: start + 3600000, createTime: start - DAY, categoryId: 0, todoTime: start, status: 'sync', version: 1 },
  { taskId: 'b', taskContent: 'B', complete: true, delete: false, dayStart: start + DAY, completedAt: start + DAY + 7200000, createTime: start, categoryId: 0, todoTime: start + DAY, status: 'sync', version: 1 }
]
const records = [
  { tomatoId: 't1', endTime: start + 7200000, startTime: start + 5400000, focusDuration: 25, succeed: true },
  { tomatoId: 't2', endTime: start + DAY + 10800000, startTime: start + DAY + 9000000, focusDuration: 25, succeed: true }
]

test('buildReviewMetrics returns a 7-element week distribution (regression: focusByWeekday undefined blanked the statistics page)', () => {
  const m = buildReviewMetrics({ todos, records, catNameOf: () => 'x' }, { start, end, label: '本周' })
  assert.ok(Array.isArray(m.doneByWeekday) && m.doneByWeekday.length === 7)
  assert.ok(Array.isArray(m.focusByWeekday) && m.focusByWeekday.length === 7)
})

test('week distribution counts correctly', () => {
  const m = buildReviewMetrics({ todos, records, catNameOf: () => 'x' }, { start, end, label: '本周' })
  assert.equal(m.doneByWeekday.reduce((s, v) => s + v, 0), 2)
  assert.equal(m.focusByWeekday.reduce((s, v) => s + v, 0), 50)
})
