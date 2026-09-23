/**
 * dw wave — P2-2: repeat engine single source (shared/repeat-core.mjs).
 *
 * Behavior fixes pinned here (main process aligned to the renderer's semantics):
 *  - month branch end-of-month clamp: a monthly repeat on day 31 now yields the short month's
 *    last day instead of silently vanishing for 2/4/6/9/11 (old main process: `if (md > dim) continue`).
 *  - week branch weekday Set-dedupe: duplicated weekday entries no longer produce duplicate instances.
 *  - both sides (main-process todo-core.js and renderer utils/repeat.js) expand identical series.
 *
 * Run: node --test tests/unit/dates/dw-repeat-core-single-source.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const core = require_('../../../src/main/core/todo-core.js')
const { expandRepeatDates, setLunarLib } = await import('../../../renderer/js/utils/repeat.js')
const solar = require_('solarlunar')
setLunarLib(solar.default || solar)

// Anchor: 2026-01-31 09:00 local — a monthly day-31 repeat whose short months must clamp, not skip
const base = new Date(2026, 0, 31, 9, 0).getTime()

test('P2-2a: main-process monthly day-31 repeat clamps to the short month\u2019s last day (was silently skipped)', () => {
  const rule = { repeatType: 'month', repeatInterval: 1, repeatMonthCount: 12, repeatMonthDays: [31] }
  const dates = core.expandRepeatDates(base, rule).map(d => d.format('YYYY-MM-DD'))
  assert.ok(dates.includes('2026-02-28'), `Feb must clamp to its last day, got: ${dates.join(',')}`)
  assert.ok(dates.includes('2026-04-30'), 'Apr must clamp to 30')
  assert.ok(dates.includes('2026-11-30'), 'Nov must clamp to 30')
  assert.ok(dates.includes('2026-01-31') && dates.includes('2026-03-31'), '31-day months keep day 31')
  assert.equal(dates.length, 12, 'every month yields exactly one occurrence')
})

test('P2-2a: shared core and renderer produce the same clamped monthly series', () => {
  const rule = { repeatType: 'month', repeatInterval: 1, repeatMonthCount: 12, repeatMonthDays: [31] }
  const a = core.expandRepeatDates(base, rule).map(d => +d)
  const b = expandRepeatDates(base, rule).map(d => +d)
  assert.deepEqual(a, b)
})

test('P2-2b: duplicated weekday entries are deduped (no duplicate instances)', () => {
  const rule = { repeatType: 'week', repeatInterval: 1, repeatWeekCount: 4, repeatWeekDays: [1, 1, 3, 3] }
  const a = core.expandRepeatDates(base, rule).map(d => +d)
  assert.equal(new Set(a).size, a.length, 'main process must dedupe repeated weekdays')
  assert.equal(a.length, 6, 'anchor Sat Jan 31: its Mon/Wed are in the past, so 3 future weeks x 2 weekdays')
  const b = expandRepeatDates(base, rule).map(d => +d)
  assert.deepEqual(a, b, 'both sides identical')
})

test('P2-2: dirty repeatType still falls back to day expansion on both sides (no chain break)', () => {
  const rule = { repeatType: 'Weekly ', repeatInterval: 1, repeatDayCount: 5 }
  const a = core.expandRepeatDates(base, rule).length
  const b = expandRepeatDates(base, rule).length
  assert.ok(a > 0)
  assert.equal(a, b)
})

test('P2-2: lunar yearly repeats still resolve identically on both sides', () => {
  const rule = { repeatType: 'year', repeatInterval: 1, repeatYearCount: 3, repeatYearType: 'lunar', repeatYearMonth: 1, repeatYearMonthDay: 15 }
  const a = core.expandRepeatDates(base, rule).map(d => +d)
  const b = expandRepeatDates(base, rule).map(d => +d)
  assert.deepEqual(a, b)
  assert.ok(a.length > 0, 'lunar branch must expand (solarlunar injected)')
})
