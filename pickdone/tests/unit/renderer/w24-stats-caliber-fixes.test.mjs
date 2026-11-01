/**
 * W24 maintenance regression batch — statistics caliber fixes (behavior tests on the pure modules).
 *  - R1 metrics trend day count: periodBounds end = +now (today's current time, see chartModels.js),
 *    so `Math.round((end-start)/DAY_MS)` under-counted before noon (KPI window included today but the
 *    trend chart stopped at yesterday) and flipped at noon ("last 7 days" sprouted an 8th bar).
 *    Fixed to a calendar-day count (inclusive of both endpoint days), same caliber as byDaySeries.
 *  - R2 achievements focus total: `focusMins += r.focusDuration` ran before the endTime guard, so
 *    dirty rows without an endTime were counted by the achievement wall while metrics.js
 *    windowCounts (guard first, same round as w14) and the heatmap skipped them.
 * Run: node --test tests/unit/renderer/w24-stats-caliber-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReviewMetrics } from '../../../renderer/js/views/statistics/metrics.js'
import { windowCounts } from '../../../renderer/js/views/statistics/metrics.js'
import { buildAchievements } from '../../../renderer/js/views/statistics/achievements.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

const DAY = 24 * 3600 * 1000
const ctx = { todos: [], records: [], catNameOf: () => 'uncategorized' }

/* ===== R1: trend day count is stable across the day and always includes today ===== */

test('R1: days identical for a morning-end vs afternoon-end window, and today is on the trend', () => {
  const today = dayjs().startOf('day')
  const start = +today.subtract(6, 'day') // "last 7 days" style anchor: day-start 6 days ago
  const morningEnd = +today.add(10, 'hour')   // 10:00 today — pre-fix Math.round gave 6 days
  const afternoonEnd = +today.add(13, 'hour') // 13:00 today — pre-fix Math.round gave 7 days

  const m1 = buildReviewMetrics(ctx, { start, end: morningEnd, label: 'last7' })
  const m2 = buildReviewMetrics(ctx, { start, end: afternoonEnd, label: 'last7' })

  assert.equal(m1.days, 7, 'morning window must still count 7 calendar days')
  assert.equal(m2.days, 7, 'afternoon window must not count 8 calendar days')
  assert.equal(m1.doneByDay.length, 7)
  assert.equal(m2.doneByDay.length, 7)

  const todayLabel = today.format('MM/DD')
  assert.equal(m1.doneByDay[6].label, todayLabel, 'series must reach today in the morning')
  assert.equal(m2.doneByDay[6].label, todayLabel, 'series must reach today in the afternoon')
})

test('R1: today-completed todo falls inside both the KPI window and the drawn series', () => {
  const today = dayjs().startOf('day')
  const start = +today.subtract(6, 'day')
  const doneAt = +today.add(11, 'hour') // completion at 11:00 today
  const todos = [{ taskId: 't1', complete: true, completedAt: doneAt, createTime: doneAt, delete: false }]
  const m = buildReviewMetrics({ todos, records: [], catNameOf: () => 'u' }, { start, end: +today.add(12, 'hour'), label: 'last7' })
  assert.equal(m.done, 1, 'KPI counts today')
  assert.equal(m.doneByDay[6].value, 1, 'trend bar for today is drawn (pre-fix it was cut off before noon)')
})

test('R1: baseline windows stay day-aligned with the same days denominator', () => {
  const today = dayjs().startOf('day')
  const start = +today.subtract(6, 'day')
  const records = [{
    tomatoId: 'tm1', endTime: +today.subtract(3, 'day').add(8, 'hour'),
    focusDuration: 30, restDuration: 0, succeed: true, focusTaskId: 0
  }]
  const m = buildReviewMetrics({ todos: [], records, catNameOf: () => 'u' }, { start, end: +today.add(9, 'hour'), label: 'last7' })
  assert.equal(m.focusMins, 30)
  assert.ok(m.baseline.focus === null, 'all-zero history windows yield a null baseline (no misaligned spill)')
})

/* ===== R2: achievements focus total excludes endTime-less rows, same caliber as metrics ===== */

test('R2: record without endTime is excluded from achievements focus hours and from metrics focusMins', () => {
  const now = Date.now()
  const records = [
    { tomatoId: 'ok', endTime: now - DAY, focusDuration: 90, restDuration: 0, succeed: true, focusTaskId: 0 },
    { tomatoId: 'dirty', endTime: 0, focusDuration: 30, restDuration: 0, succeed: true, focusTaskId: 0 }
  ]
  const ach = buildAchievements({ todos: [], records })
  const metricsMins = windowCounts([], records, () => 'u', 0, now + DAY).focusMins
  assert.equal(metricsMins, 90, 'metrics caliber: dirty row excluded')
  assert.equal(ach.totals.focusHours, 1, 'achievements caliber now matches metrics (90 min = 1 h; pre-fix it summed 120 min = 2 h)')
})
