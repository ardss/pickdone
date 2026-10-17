/**
 * F2-P3 (2026-10-18): the anchor-MISMATCH branch of crossDayMovePatch — a todoTime anchored to a
 * third day (dayStart/todoTime already drifted) used to be omitted from the patch, so only
 * dayStart moved while the DB's scheduledDay (derived from todoTime) kept the row on the old day
 * and the move reverted on the next re-hydration. Same root cause as the A1/A2 fixes.
 * Run: node --test tests/unit/utils/cross-day-move-anchor3.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import { crossDayMovePatch, crossDayRevertPatch } from '../../../renderer/js/utils/crossDayMove.js'

const startOfDay = ts => +dayjs(ts).startOf('day')
const at = (dateStr, h, m = 0) => +dayjs(dateStr).hour(h).minute(m).second(0).millisecond(0)

test('third-day anchor: todoTime keeps its time-of-day and re-anchors to the new day', () => {
  const newDay = at('2026-10-18', 0)
  const oldDay = at('2026-10-10', 0)
  const patch = crossDayMovePatch({ dayStart: oldDay, todoTime: at('2026-10-01', 10, 30) }, newDay, startOfDay)
  assert.deepEqual(patch, {
    dayStart: newDay,
    todoTime: at('2026-10-18', 10, 30),
  }, 'todoTime day now matches dayStart (memory and DB agree)')
  // revert restores exactly the touched fields
  const revert = crossDayRevertPatch({ dayStart: oldDay, todoTime: at('2026-10-01', 10, 30) }, patch)
  assert.deepEqual(revert, { dayStart: oldDay, todoTime: at('2026-10-01', 10, 30) })
})

test('third-day anchor + store caliber: the re-anchored patch survives the dayStart re-derivation from todoTime', () => {
  // store/todo.js:312 re-derives dayStart from todoTime on every todoTime-bearing write
  // (`merged.dayStart = merged.todoTime ? +dayjs(merged.todoTime).startOf('day') : 0`), and the
  // chip-sync gate at :217 buckets by the same effectiveDay — a dayStart-only patch on a
  // third-day-anchored todoTime therefore reverts (or lands in the stale bucket) on the next
  // write/restart. After the fix, todoTime's own day IS the new day, so the re-derivation agrees.
  const newDay = at('2026-10-18', 0)
  const oldDay = at('2026-10-10', 0)
  // BEFORE (old dayStart-only behavior, reproduced inline): re-derivation snaps back to the third day
  const oldPatch = { dayStart: newDay } // todoTime stays 2026-10-01 10:30
  const drifted = Object.assign({ dayStart: oldDay, todoTime: at('2026-10-01', 10, 30) }, oldPatch)
  const before = +dayjs(drifted.todoTime).startOf('day')
  assert.equal(before, at('2026-10-01', 0), 'reproduces the bug: re-derived dayStart snaps to the stale todoTime day')
  const patch = crossDayMovePatch({ dayStart: oldDay, todoTime: at('2026-10-01', 10, 30) }, newDay, startOfDay)
  const after = +dayjs(patch.todoTime).startOf('day')
  assert.equal(after, newDay, 'after the fix the re-derived dayStart is the new day')
})
