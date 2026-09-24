/**
 * [maint-0924 A1/A2] shared cross-day move rules (renderer/js/utils/crossDayMove.js).
 * Single source for TodoItem drag / DayDeck card drop / TodoBoxView batch move-to-today.
 * Run: node --test tests/unit/utils/cross-day-move.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import { crossDayMovePatch, crossDayRevertPatch } from '../../../renderer/js/utils/crossDayMove.js'

const startOfDay = ts => +dayjs(ts).startOf('day')
const at = (dateStr, h, m = 0) => +dayjs(dateStr).hour(h).minute(m).second(0).millisecond(0)

test('time-of-day translation: 14:30 schedule and 08:00 reminder survive the move onto the new day', () => {
  const newDay = at('2026-09-24', 0)
  const oldDay = at('2026-09-10', 0)
  const patch = crossDayMovePatch(
    { dayStart: oldDay, todoTime: at('2026-09-10', 14, 30), reminderTime: at('2026-09-10', 8), reminderExtra: [at('2026-09-10', 9), at('2026-09-11', 18)] },
    newDay, startOfDay)
  assert.deepEqual(patch, {
    dayStart: newDay,
    todoTime: at('2026-09-24', 14, 30),
    reminderTime: at('2026-09-24', 8),
    reminderExtra: [at('2026-09-24', 9), at('2026-09-11', 18)] // extra anchored to another day stays untouched
  })
  // revert restores exactly the touched fields with the original values
  const revert = crossDayRevertPatch(
    { dayStart: oldDay, todoTime: at('2026-09-10', 14, 30), reminderTime: at('2026-09-10', 8), reminderExtra: [at('2026-09-10', 9), at('2026-09-11', 18)] },
    patch)
  assert.deepEqual(revert, {
    dayStart: oldDay,
    todoTime: at('2026-09-10', 14, 30),
    reminderTime: at('2026-09-10', 8),
    reminderExtra: [at('2026-09-10', 9), at('2026-09-11', 18)]
  })
})

test('cross-month / cross-year move keeps time-of-day across the calendar boundary', () => {
  // Mar 31 -> Apr 1: naive "same day offset" arithmetic would drift on DST zones; the
  // startOfDay-anchored subtraction must land exactly at 00:00 + time-of-day
  const newDay = at('2026-04-01', 0)
  const oldDay = at('2026-03-31', 0)
  const patch = crossDayMovePatch(
    { dayStart: oldDay, todoTime: at('2026-03-31', 23, 5), reminderTime: at('2026-03-31', 0, 1), reminderExtra: [at('2026-03-31', 12)] },
    newDay, startOfDay)
  assert.equal(patch.todoTime, at('2026-04-01', 23, 5))
  assert.equal(patch.reminderTime, at('2026-04-01', 0, 1))
  assert.deepEqual(patch.reminderExtra, [at('2026-04-01', 12)])
})

test('no time / misaligned times: fields not anchored to the old day are omitted from the patch', () => {
  const newDay = at('2026-09-24', 0)
  const oldDay = at('2026-09-10', 0)
  // plain dated task: no todoTime / reminders at all
  assert.deepEqual(crossDayMovePatch({ dayStart: oldDay }, newDay, startOfDay), { dayStart: newDay })
  // todoTime on a DIFFERENT day than dayStart (explicit datetime elsewhere) -> untouched
  assert.deepEqual(crossDayMovePatch({ dayStart: oldDay, todoTime: at('2026-09-05', 10), reminderTime: at('2026-09-01', 9) }, newDay, startOfDay), { dayStart: newDay })
  // revert of a marker-only patch restores dayStart only
  assert.deepEqual(crossDayRevertPatch({ dayStart: oldDay, todoTime: 0 }, { dayStart: newDay }), { dayStart: oldDay })
})
