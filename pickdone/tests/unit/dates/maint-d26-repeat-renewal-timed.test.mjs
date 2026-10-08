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
