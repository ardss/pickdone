/**
 * W5 S1 pilot: StatisticsView.vue chart-shaping logic extracted to
 * renderer/js/views/statistics/chartModels.js as pure functions.
 * These tests pin the extracted models (zero behavior change vs the former inline computeds):
 *   - heatmap levels / streak / window size
 *   - period bounds incl. custom range (exclusive end) + label keys
 *   - weekday / trend / focus-trend model shapes (title keys, baseline rounding)
 *   - timeline rows: dedup, session band merging, per-day done counts, injected translation
 *
 * Run: node --test tests/unit/components/w5-stats-chartmodels.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

// Browser-host globals before utils load (utils/core.js expects the UMD dayjs global, isoWeek extended).
const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
dayjs.extend(require_('dayjs/plugin/isoWeek'))
globalThis.window = globalThis // i18n/index.js reads window.VueI18n at import time (absent here -> plain fallback)
globalThis.dayjs = dayjs

const { periodBounds, buildHeatmap, countGiveUps7, buildWeekdayModel, buildTrendModel, buildFocusTrendModel, buildTimelineRows } =
  await import('../../../renderer/js/views/statistics/chartModels.js')

// Deterministic wall clock: 2026-09-12 12:00 local
const NOW = new Date(2026, 8, 12, 12, 0, 0).getTime()
const t = (k, p) => k + (p ? JSON.stringify(p) : '')

const todo = (id, { complete = true, del = false, ts = null, updateTime = null } = {}) =>
  ({ taskId: id, complete, delete: del, completedAt: ts, updateTime })

test('buildHeatmap: window is 26 or 52 weeks ending on the current week\'s Sunday; cells laid out col/dow', () => {
  const empty = { todos: [], records: [], weeks: 26, nowTick: NOW }
  const hm = buildHeatmap(empty)
  assert.equal(hm.cells.length, 26 * 7)
  assert.equal(hm.weeks, 26)
  assert.equal(hm.totalDone, 0)
  assert.equal(hm.streak, 0)
  // last cell is the upcoming Sunday, laid out at dow=6 of the last column
  const last = hm.cells[hm.cells.length - 1]
  const lastD = dayjs(last.key)
  assert.equal(lastD.day(), 0)
  assert.equal(last.dow, 6)
  assert.equal(last.col, 25)
  assert.equal(buildHeatmap({ ...empty, weeks: 52 }).cells.length, 52 * 7)
})

test('buildHeatmap: level thresholds follow done counts relative to maxDone (0/1/2/3/4)', () => {
  const day = 24 * 3600 * 1000
  const base = NOW - 3 * day // a few days back, inside the window
  const fmt = ts => dayjs(ts).format('YYYY-MM-DD')
  const todos = [
    todo('a', { ts: base }),                                        // 1 done vs max 4 -> level 1
    ...['b1', 'b2', 'b3', 'b4'].map(id => todo(id, { ts: base + day })), // max (4) -> level 4
    todo('c1', { ts: base + 2 * day }), todo('c2', { ts: base + 2 * day }), // 2 vs max 4 -> level 2 (>= 0.34*4, < 0.67*4)
    todo('z', { ts: NOW })                                          // today done -> feeds the trailing streak
  ]
  const hm = buildHeatmap({ todos, records: [], weeks: 26, nowTick: NOW })
  const byKey = Object.fromEntries(hm.cells.map(c => [c.key, c]))
  assert.equal(byKey[fmt(base)].level, 1)
  assert.equal(byKey[fmt(base + day)].level, 4)
  assert.equal(byKey[fmt(base + 2 * day)].level, 2)
  // trailing streak: today done, then 2/4/1 on the three prior days -> streak = 4
  // (the heatmap window ends on the upcoming Sunday, so "today" is NOT the last cell)
  assert.equal(hm.streak, 4)
  assert.equal(hm.totalDone, 8)
})

test('buildHeatmap: failed pomodoro records do not contribute focus minutes', () => {
  const day = 24 * 3600 * 1000
  const base = NOW - day
  const records = [
    { endTime: String(base + 3600 * 1000), succeed: true, focusDuration: 25 },
    { endTime: String(base + 7200 * 1000), succeed: false, focusDuration: 25 }
  ]
  const hm = buildHeatmap({ todos: [], records, weeks: 26, nowTick: NOW })
  const c = hm.cells.find(c => c.key === dayjs(base).format('YYYY-MM-DD'))
  assert.equal(c.focus, 25)
})

test('countGiveUps7: only failed records within the trailing 7 days', () => {
  const records = [
    { endTime: String(NOW - 1 * 24 * 3600 * 1000), succeed: false },
    { endTime: String(NOW - 6 * 24 * 3600 * 1000), succeed: false },
    { endTime: String(NOW - 8 * 24 * 3600 * 1000), succeed: false },
    { endTime: String(NOW - 2 * 24 * 3600 * 1000), succeed: true }
  ]
  assert.equal(countGiveUps7(records, NOW), 2)
})

test('periodBounds: named periods produce exclusive-end bounds with translated label keys', () => {
  const b7 = periodBounds('last7', null, NOW, t)
  assert.equal(b7.start, +dayjs(NOW).subtract(7, 'day').startOf('day'))
  assert.equal(b7.end, NOW)
  assert.ok(b7.label.startsWith('statsA.StatisticsView.period_last7'))

  const bc = periodBounds('custom', ['2026-09-01', '2026-09-07'], NOW, t)
  assert.equal(bc.start, +dayjs('2026-09-01').startOf('day'))
  // end is an exclusive upper bound covering the whole final day
  assert.equal(bc.end, +dayjs('2026-09-08').startOf('day'))
  assert.ok(bc.label.startsWith('statsA.StatisticsView.period_custom'))

  // custom with no range yet falls back to last-7-days
  const bc0 = periodBounds('custom', null, NOW, t)
  assert.equal(bc0.end, NOW)

  // inverted range normalization happened upstream; here a default 'thisWeek' branch is pinned
  const bw = periodBounds('thisWeek', null, NOW, t)
  assert.equal(bw.start, +dayjs(NOW).startOf('isoWeek'))
  assert.ok(bw.label.startsWith('statsA.StatisticsView.period_thisWeek'))
})

test('buildWeekdayModel: 7 bars + 7 overlay points, summary references the peak-focus weekday label', () => {
  const m = {
    doneByWeekday: [1, 2, 3, 0, 0, 0, 0],
    focusByWeekday: [10, 20, 5, 0, 0, 0, 0]
  }
  const model = buildWeekdayModel(m, t)
  assert.equal(model.modelType, 4)
  assert.equal(model.chartList.length, 7)
  assert.equal(model.overlayList.length, 7)
  assert.equal(model.chartList[2].value, 3)
  assert.ok(model.summary.includes('wd2')) // peak focus at index 1 -> label wd2
})

test('buildTrendModel/buildFocusTrendModel: baseline rounding (2 vs 1 decimal) and empty-baseline summary key', () => {
  const m = {
    doneByDay: [{ label: '09.12', value: 3 }],
    focusByDay: [{ label: '09.12', value: 75 }],
    baseline: { done: 1.234, focus: 12.34 }
  }
  const trend = buildTrendModel(m, t, 'RANGE')
  assert.equal(trend.modelType, 3)
  assert.equal(trend.baselineValue, 1.23)
  assert.equal(trend.subTitle, 'RANGE')
  const focus = buildFocusTrendModel(m, t, 'RANGE')
  assert.equal(focus.baselineValue, 12.3)
  assert.ok(focus.legendLabel.includes('legendFocusMins'))

  const empty = buildTrendModel({ doneByDay: [], focusByDay: [], baseline: { done: null, focus: null } }, t, 'R')
  assert.equal(empty.baselineValue, null)
  assert.ok(empty.summary.includes('trendSummaryEmpty'))
})

test('buildTimelineRows: 7 rows, per-day done counts, duplicate records deduped, sessions merged into bands', () => {
  const today = +dayjs(NOW).startOf('day')
  const noon = today + 12 * 3600 * 1000
  const fmt = ts => dayjs(ts).format('YYYY-MM-DD')
  const records = [
    // two consecutive pomodoros (25min focus + 5min rest, 30min apart) -> one band with 2 segs
    { tomatoId: 'p1', endTime: String(noon), focusDuration: 25, restDuration: 5, succeed: true, focus: 'TaskA' },
    { tomatoId: 'p2', endTime: String(noon + 30 * 60000), focusDuration: 25, restDuration: 5, succeed: true, focus: 'TaskA' },
    // exact duplicate of p1 -> drawn once
    { tomatoId: 'p3', endTime: String(noon), focusDuration: 25, restDuration: 5, succeed: true, focus: 'TaskA' }
  ]
  const todos = [todo('x', { ts: noon }), todo('y', { ts: noon }), todo('gone', { complete: false, ts: noon })]
  const rows = buildTimelineRows({ records, todos, t, now: NOW })
  assert.equal(rows.length, 7)
  assert.equal(rows[6].dateKey, fmt(today))
  assert.equal(rows[6].done, 2) // only completed todos count
  assert.equal(rows[6].count, 3) // failed/dup both count toward pomodoro tally? dup skipped before... p3 counted (count++ before dup check)
  assert.equal(rows[6].minutes, 75)
  const bands = rows[6].bands
  // 30min apart pomodoros, unit width 30min -> p2's unit starts exactly where p1's ends (<= 10min gap) -> one merged band
  assert.equal(bands.length, 1)
  assert.equal(bands[0].n, 2)
  assert.equal(rows[6].segments.filter(s => s.kind === 'unit').length, 2) // duplicate unit not re-drawn
  // band hover title resolved through the injected translator with the statsA key
  assert.ok(bands[0].title.includes('statsA.StatisticsView.segFocus'))
  assert.ok(bands[0].title.includes('TaskA'))
  // empty day rows are marked
  assert.equal(rows[0].empty, true)
})

test('buildTimelineRows: unit segs carry ff focus ratio and linked-task titles; rest-only records become rest segs', () => {
  const today = +dayjs(NOW).startOf('day')
  const recs = [
    { tomatoId: 'r1', endTime: String(today + 9 * 3600 * 1000), focusDuration: 0, restDuration: 5, succeed: false, focus: '' }
  ]
  const rows = buildTimelineRows({ records: recs, todos: [], t, now: NOW })
  assert.equal(rows[6].empty, false)
  const rest = rows[6].segments.find(s => s.kind === 'rest')
  assert.ok(rest, 'rest-only record renders a rest seg')
  assert.ok(rest.title.includes('segRest'))

  const unit = buildTimelineRows({
    records: [{ tomatoId: 'u1', endTime: String(today + 9 * 3600 * 1000), focusDuration: 25, restDuration: 5, succeed: true, focus: 'Write' }],
    todos: [], t, now: NOW
  })[6].segments.find(s => s.kind === 'unit')
  // 25 focus of 30 total -> ff ~83.3%
  assert.ok(Math.abs(unit.ff - (25 / 30 * 100)) < 0.01)
  assert.ok(unit.title.includes('Write'))
})
