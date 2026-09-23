/**
 * CalendarView perf helpers (domain-5, 2026-09-23 wave) — pure, unit-testable.
 * [Perf-E1] The time-block view used to run a full-table .filter per rendered cell
 *           (7 days × 18 hours = 126 filter passes over todoList per render). The
 *           bucket map builds once per todoList change (one O(n) pass) and every
 *           cell lookup becomes O(1).
 * [Perf-E2] fcEvents used to map the WHOLE todoList on every change and hand the
 *           full array to FullCalendar (full re-parse/re-layout); events are now
 *           pre-trimmed to the visible month ± a buffer. taskById replaces the
 *           linear todoList.find at every eventClick/eventDrop/peek site.
 * Semantics contract: the predicates below mirror the former inline filters 1:1
 * (guarded by tests/unit/renderer/dw5-calendar-perf.test.mjs equivalence tests).
 */

const HOUR = 3600000
const DAY = 86400000

/** O(1) lookup: taskId → todo row (replaces repeated todoList.find O(n) scans) */
export function indexById (list) {
  const m = new Map()
  for (const t of list) m.set(t.taskId, t)
  return m
}

/**
 * Bucket scheduled (timed) tasks by `${dayTs}:${hour}` for the time-block grid.
 * Mirrors the former tbTasksOf predicate exactly: skip complete/deleted/unscheduled/
 * all-day (todoTime === dayStart) rows; a task lands in the slot containing its raw
 * todoTime. `toDayTs` must map a ts to its LOCAL midnight (utils/todayBounds.js
 * dayStart) — dayStart values in the store are local-midnight ts, so raw UTC-day
 * floor arithmetic would mis-bucket every row east/west of UTC.
 */
export function buildTbBuckets (list, toDayTs) {
  const m = new Map()
  for (const t of list) {
    if (t.complete || t.delete || !t.todoTime || t.todoTime === t.dayStart) continue
    const dayTs = toDayTs(t.todoTime)
    const hour = Math.floor((t.todoTime - dayTs) / HOUR)
    // key = slot start ts: slot (d, 24) and (d+1day, 0) are arithmetically the same hour
    // and must collide into one bucket (matches the naive [slotStart, slotEnd) predicate)
    const key = dayTs + hour * HOUR
    let arr = m.get(key)
    if (!arr) { arr = []; m.set(key, arr) }
    arr.push(t)
  }
  return m
}

/** Same task order as the former per-cell .filter (todoList order preserved). */
export function tbBucketGet (buckets, dayTs, hour) {
  return buckets.get(dayTs + hour * HOUR) || []
}

/**
 * Whether a task's dayStart falls inside the visible cursor month ± `buffer` months.
 * cursorTs=0 (before the first datesSet fires) means "no cursor yet" → keep everything,
 * so the very first render sees the same event set as before the optimization.
 */
export function inCursorWindow (dayStart, cursorTs, buffer = 2) {
  if (!cursorTs) return true
  // cursorTs is always a local-midnight ts (datesSet stores dayStart(d)); ms arithmetic only —
  // no local-time day-boundary math, matching how dayStart values are stored everywhere here.
  return dayStart >= cursorTs - buffer * 31 * DAY && dayStart < cursorTs + (buffer + 1) * 31 * DAY
}
