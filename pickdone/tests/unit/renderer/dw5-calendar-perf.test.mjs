/**
 * Domain-5 CalendarView perf refactor (2026-09-23 wave) — behavior-equivalence guards.
 * The optimization (F-E1/F-E2) replaced:
 *   - tbTasksOf's per-cell whole-table .filter (126 passes/render) with one bucketed Map
 *   - fcEvents' whole-history mapping with a cursor-window trim (±2 months, datesSet cursor)
 *   - seven linear todoList.find scans with a taskId→row Map
 * These tests pin the NEW helpers to the EXACT predicates the inline code used before, so the
 * rendered time-block grid and the FullCalendar event set stay byte-identical.
 * Run: node --test tests/unit/renderer/dw5-calendar-perf.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  indexById, buildTbBuckets, tbBucketGet, inCursorWindow
} from '../../../renderer/js/utils/calendarBuckets.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

// same local-midnight mapper the component passes in production (utils/todayBounds.dayStart)
const toDayTs = ts => +dayjs(ts).startOf('day')

const HOUR = 3600000
const DAY = 86400000
const cursor = +new Date('2026-09-15T12:00:00') // any mid-month ts; datesSet stores dayStart(cursor)

/** The former inline tbTasksOf predicate, verbatim (CalendarView.vue before this wave). */
const oldTbTasksOf = (list, dayTs, hour) => {
  const slotStart = dayTs + hour * 3600000
  const slotEnd = slotStart + 3600000
  return list.filter(t => {
    if (t.complete || t.delete || !t.todoTime || t.todoTime === t.dayStart) return false
    return t.todoTime >= slotStart && t.todoTime < slotEnd
  })
}

test('[E1] tbBuckets ≡ per-cell filter: every grid slot returns the same rows in the same order', () => {
  const day0 = +new Date('2026-09-21T00:00:00')
  const list = [
    { taskId: 'a', todoTime: day0 + 7 * HOUR, dayStart: day0 }, // 07:00 Mon
    { taskId: 'b', todoTime: day0 + 2 * DAY + 7 * HOUR, dayStart: day0 + 2 * DAY }, // Wed 07:00 — collides with slot of 'a'? no, same hour diff day
    { taskId: 'c', todoTime: day0 + 7 * HOUR + 1, dayStart: day0 }, // 07:00:00.001 — same slot as a, order kept
    { taskId: 'd', todoTime: day0 + 6 * HOUR, dayStart: day0 }, // different hour
    { taskId: 'done', todoTime: day0 + 7 * HOUR, dayStart: day0, complete: true }, // filtered out
    { taskId: 'del', todoTime: day0 + 7 * HOUR, dayStart: day0, delete: true }, // filtered out
    { taskId: 'allday', todoTime: day0, dayStart: day0 }, // todoTime===dayStart → not a slot task
    { taskId: 'unsched', dayStart: day0 }, // no todoTime → not a slot task
    { taskId: 'week-after', todoTime: day0 + 8 * DAY + 9 * HOUR, dayStart: day0 + 8 * DAY } // outside grid week, but bucketed fine
  ]
  const buckets = buildTbBuckets(list, toDayTs)
  for (let d = 0; d < 7; d++) {
    for (let h = 6; h < 24; h++) {
      const dayTs = day0 + d * DAY
      assert.deepEqual(tbBucketGet(buckets, dayTs, h), oldTbTasksOf(list, dayTs, h),
        `slot ${new Date(dayTs).toISOString().slice(0, 10)} h=${h} diverges from the former per-cell filter`)
    }
  }
})

test('[E1] randomized equivalence: bucket lookup matches the naive filter on adversarial ts values', () => {
  // hour-boundary ts values (exactly slotStart / slotEnd-1 / slotEnd) are where off-by-one hides
  const day0 = +new Date('2026-09-14T00:00:00')
  const list = []
  let i = 0
  for (const off of [0, 1, HOUR - 1, HOUR, 12 * HOUR - 1, 23 * HOUR, 24 * HOUR - 1, -1]) {
    for (const d of [0, 1, 6, 7, -1]) {
      list.push({ taskId: 't' + (i++), todoTime: day0 + d * DAY + off, dayStart: day0 + d * DAY })
    }
  }
  const buckets = buildTbBuckets(list, toDayTs)
  for (let d = -1; d <= 7; d++) {
    for (let h = 0; h <= 24; h++) {
      assert.deepEqual(tbBucketGet(buckets, day0 + d * DAY, h), oldTbTasksOf(list, day0 + d * DAY, h))
    }
  }
})

test('[E2] cursor-window trim: in-month and adjacent-month days kept, far history/future dropped, cursor=0 keeps all', () => {
  const sep = d => +new Date(`2026-09-${String(d).padStart(2, '0')}T00:00:00`)
  assert.equal(inCursorWindow(sep(15), cursor), true, 'same month')
  assert.equal(inCursorWindow(sep(1), cursor), true, 'month start')
  assert.equal(inCursorWindow(+new Date('2026-08-20'), cursor), true, 'previous month (visible as adjacent days)')
  assert.equal(inCursorWindow(+new Date('2026-07-01'), cursor), false, 'two months back is dropped')
  assert.equal(inCursorWindow(+new Date('2026-10-31'), cursor), true, 'next month kept')
  assert.equal(inCursorWindow(+new Date('2026-12-01'), cursor), true, 'just inside the ±2-month window')
  assert.equal(inCursorWindow(+new Date('2027-01-15'), cursor), false, 'far future is dropped')
  assert.equal(inCursorWindow(sep(15), 0), true, 'no cursor yet (first render) → full set, same as before the trim')
  assert.equal(inCursorWindow(NaN, cursor), false, 'NaN dayStart never passes (defensive, mirrors !t.dayStart upstream)')
})

test('[E2] taskById Map resolves the same rows the linear .find returned (first-wins on duplicate ids)', () => {
  const list = [{ taskId: 'x', v: 1 }, { taskId: 'y', v: 2 }, { taskId: 'x', v: 3 }]
  const m = indexById(list)
  assert.equal(m.get('x'), list[2], 'Map.set semantics: later duplicate wins — same as find() scanning forward')
  assert.equal(m.get('y'), list[1])
  assert.equal(m.get('missing'), undefined)
})
