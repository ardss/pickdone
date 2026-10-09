/**
 * [maint/d26 P1] Repeat auto-renewal used to expand from the group's last DAY (a local midnight,
 * since isLastRepeatInstance keys on dayStart), so a TIMED instance (14:30) renewed on completion
 * became 00:00 (all-day) and stayed all-day for every subsequent generation — diverging from the
 * RepeatModal generation path, which expands from the timed todoTime.
 * Fix: nextRepeatInstance anchors the expansion at completedTodo.todoTime || lastDay, and the
 * next-occurrence filter compares start-of-day (a timed base would otherwise pass `ts > dayStart`
 * with its own same-day occurrence and re-mint today's completed instance).
 * Run: node --test tests/unit/dates/maint-d26-repeat-renewal-timed.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
dayjs.extend(require_('dayjs/plugin/isoWeek'))

const { nextRepeatInstance } = await import('../../../shared/repeat-core.mjs')

const deps = { dayjs, lunarToSolar: null }
const DAY = 86400000
// Oct 5 2026 is a Monday; the group's last instance lives on that day
const DAY0 = +dayjs(new Date(2026, 9, 5)).startOf('day')
const AT1430 = 14 * 3600000 + 30 * 60000

const completed = extra => ({
  dayStart: DAY0,
  todoTime: DAY0 + AT1430,
  reminderTime: DAY0 + 9 * 3600000,
  reminderOffsets: [],
  reminderExtra: [],
  ...extra
})
const group = [completed()]

test('timed daily repeat renews at the same time-of-day (not 00:00)', () => {
  const next = nextRepeatInstance(completed(), group, { repeatType: 'day', repeatInterval: 1 }, [], deps)
  assert.ok(next, 'renewal produced')
  assert.equal(next.todoTime, DAY0 + DAY + AT1430, 'next day, 14:30 preserved')
})

test('timed weekly repeat renews at the same time-of-day', () => {
  const next = nextRepeatInstance(completed(), group, { repeatType: 'week', repeatInterval: 1, repeatWeekDays: [1] }, [], deps)
  assert.ok(next)
  assert.equal(next.todoTime, DAY0 + 7 * DAY + AT1430, 'next Monday, 14:30 preserved')
})

test('timed monthly repeat renews at the same time-of-day', () => {
  const next = nextRepeatInstance(completed(), group, { repeatType: 'month', repeatInterval: 1, repeatMonthDays: [5] }, [], deps)
  assert.ok(next)
  assert.equal(next.todoTime, +dayjs(new Date(2026, 10, 5)) + AT1430, 'Nov 5, 14:30 preserved')
})

test('all-day instance (todoTime === dayStart) stays all-day', () => {
  const allDay = completed({ todoTime: DAY0 })
  const next = nextRepeatInstance(allDay, [allDay], { repeatType: 'day', repeatInterval: 1 }, [], deps)
  assert.ok(next)
  assert.equal(next.todoTime, DAY0 + DAY, 'next local midnight, still all-day')
})

test('the completed day itself is NOT re-minted (timed base must not pass the same-day filter)', () => {
  const next = nextRepeatInstance(completed(), group, { repeatType: 'day', repeatInterval: 1 }, [], deps)
  assert.equal(+dayjs(next.todoTime).startOf('day'), DAY0 + DAY, 'next occurrence is strictly on a later day')
})

test('reminder time-of-day follows the renewed instance', () => {
  const next = nextRepeatInstance(completed(), group, { repeatType: 'day', repeatInterval: 1 }, [], deps)
  assert.equal(next.reminderTime, DAY0 + DAY + 9 * 3600000, '09:00 reminder re-anchored to the renewed day')
})

/* ---------------- [P1 2026-10-09] reminderExtra drift on timed repeats (propagation miss) ----------------
 * Since the renewal base re-anchored to the completed instance's TIMED todoTime (2026-10-08),
 * renewalCarryFields' dayDiff = next.todoTime - t.dayStart included the time-of-day offset, so
 * every reminderExtra timestamp drifted FORWARD by the instance's time-of-day on EVERY generation
 * (a 14:30 task drifted +14.5h per generation). Root fix: dayDiff is a pure day diff
 * (startOf('day') of next.todoTime minus t.dayStart). */
const { renewalCarryFields } = await import('../../../shared/repeat-core.mjs')

test('reminderExtra keep their clock time on the renewed day when todoTime is timed (14:30)', () => {
  const extra09 = DAY0 + 9 * 3600000 // 09:00 reminder on the source day
  const src = completed({ reminderExtra: [extra09] })
  const next = { todoTime: DAY0 + DAY + AT1430, reminderTime: 0 }
  const out = renewalCarryFields(src, next)
  // RED before the fix: extra09 + (DAY + AT1430) -> the 09:00 reminder landed at 23:30 next day
  assert.equal(out.reminderExtra[0], DAY0 + DAY + 9 * 3600000,
    'the reminder stays at 09:00 on the new day — the time-of-day offset must not leak into the shift')
})

test('reminderExtra drift is stable across GENERATIONS (no per-generation accumulation)', () => {
  const extra09 = DAY0 + 9 * 3600000
  let carry = [extra09]
  let dayStart = DAY0
  for (let gen = 0; gen < 3; gen++) {
    const next = { todoTime: dayStart + DAY + AT1430, reminderTime: 0 }
    const out = renewalCarryFields({ dayStart, reminderExtra: carry }, next)
    carry = out.reminderExtra
    dayStart += DAY
  }
  assert.deepEqual(carry, [DAY0 + 3 * DAY + 9 * 3600000],
    'after 3 generations the extra is exactly 3 days later at 09:00 — zero accumulated drift')
})

test('all-day renewal (todoTime === dayStart) still shifts extras by whole days', () => {
  const extra09 = DAY0 + 9 * 3600000
  const out = renewalCarryFields({ dayStart: DAY0, reminderExtra: [extra09] }, { todoTime: DAY0 + 2 * DAY, reminderTime: 0 })
  assert.deepEqual(out.reminderExtra, [extra09 + 2 * DAY], 'pure 2-day shift, unchanged semantics')
})
