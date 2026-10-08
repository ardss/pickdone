/**
 * [maint-0924 A1/A2] shared cross-day move rules (renderer/js/utils/crossDayMove.js).
 * Single source for TodoItem drag / DayDeck card drop / TodoBoxView batch move-to-today.
 * Run: node --test tests/unit/utils/cross-day-move.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import { crossDayMovePatch, crossDayRevertPatch } from '../../../renderer/js/utils/crossDayMove.js'
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)

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
  // plain dated task: no todoTime / reminders at all -> the task is day-anchored on the new day
  assert.deepEqual(crossDayMovePatch({ dayStart: oldDay }, newDay, startOfDay), { dayStart: newDay, todoTime: newDay })
  // todoTime on a DIFFERENT day than dayStart (explicit datetime elsewhere) -> untouched
  assert.deepEqual(crossDayMovePatch({ dayStart: oldDay, todoTime: at('2026-09-05', 10), reminderTime: at('2026-09-01', 9) }, newDay, startOfDay), { dayStart: newDay })
  // revert of a marker-only patch restores dayStart only
  assert.deepEqual(crossDayRevertPatch({ dayStart: oldDay, todoTime: 0 }, { dayStart: newDay }), { dayStart: oldDay })
})

test('[restore-to-today fix] a no-time task moves to a new day as ALL-DAY (todoTime = newDay), so the DB scheduledDay derivation agrees', () => {
  // RecycleBinView.restore(patchToToday) on an undated/no-time row: the old dayStart-only patch
  // said "restored to today" in memory while db-rows.js todoToRow unconditionally wrote
  // scheduledDay = 0 for todoTime = 0 — the row silently fell back to the inbox on the next
  // re-hydration (getAll). Day-anchoring (todoTime = newDay, the all-day marker shape
  // calendarBuckets already understands) keeps memory and DB in agreement.
  const today = at('2026-10-08', 0)
  const patch = crossDayMovePatch({ taskId: 'nd1', dayStart: 0, todoTime: 0 }, today, startOfDay)
  assert.equal(patch.dayStart, today)
  assert.equal(patch.todoTime, today, 'todoTime is day-anchored to the new day, not left at 0')
  // the store/todo.js chip-sync gate (patch.todoTime !== undefined) now fires naturally
  assert.ok('todoTime' in patch, 'chip-sync gate is satisfied by the patch itself')
  // revert restores the original no-time shape exactly
  const revert = crossDayRevertPatch({ taskId: 'nd1', dayStart: 0, todoTime: 0 }, patch)
  assert.deepEqual(revert, { dayStart: 0, todoTime: 0 })
})

test('[restore-to-today fix] the day-anchored no-time patch derives scheduledDay = newDay via todoToRow', () => {
  // db-rows.js todoToRow is CJS — pull it through createRequire and prove the row mapper now
  // agrees with the memory patch (scheduledDay was the divergence surface).
  const { todoToRow } = require_('../../../src/main/db-rows.js')
  const today = at('2026-10-08', 0)
  const row = todoToRow({ taskId: 'nd2', dayStart: today, todoTime: today })
  assert.equal(row.scheduledDay, today, 'scheduledDay derives to the restored day, not 0')
})
