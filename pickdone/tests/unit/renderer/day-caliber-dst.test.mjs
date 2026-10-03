/**
 * Day-caliber DST regressions (2026-10-03): sibling-day stepping must use the calendar
 * primitive todayBounds.dayShift, never `ts ± n*86400000`. Local midnights are 23h/25h apart
 * across a DST transition, so ms arithmetic lands off-midnight and exact-equality dayStart
 * filters/bins silently drop rows or mislabel days.
 * The TZ is set BEFORE any import (static imports hoist above module code, so every import here
 * is dynamic); node --test runs each file in its own process, so this stays leak-free.
 * Run: node --test tests/unit/renderer/day-caliber-dst.test.mjs
 */
process.env.TZ = 'America/New_York'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
await import('../../setup.mjs')
const { dayShift, dayStart } = await import('../../../renderer/js/utils/todayBounds.js')
const { buildExpiryGroups } = await import('../../../renderer/js/utils/expiryGroups.js')
const { dayjs } = await import('../../../renderer/js/utils/core.js')

test('[day-caliber DST] dayShift crosses the 2026-11-01 fall-back (25h day) where ms arithmetic lands 23:00', () => {
  const nov1 = +dayjs('2026-11-01') // NY local midnight, GMT-4
  assert.equal(dayStart(nov1), nov1, 'precondition: the base is local midnight')
  assert.equal(dayShift(nov1, 1), +dayjs('2026-11-02'), '+1 day lands Nov 2 local midnight')
  assert.notEqual(dayShift(nov1, 1), nov1 + 86400000, 'ms step lands Nov 1 23:00 (25h day) — the old bug')
  assert.equal(dayShift(nov1, -1), +dayjs('2026-10-31'), '-1 day lands Oct 31 local midnight')
})

test('[day-caliber DST] dayShift crosses the 2026-03-08 spring-forward (23h day)', () => {
  const mar8 = +dayjs('2026-03-08')
  assert.equal(dayShift(mar8, 1), +dayjs('2026-03-09'), '+1 day lands Mar 9 local midnight')
  assert.equal(dayShift(mar8, 1) - mar8, 23 * 3600000, 'the calendar step is 23h, not 24h — exact equality on stored midnights only survives this')
})

test('[day-caliber DST] expiryGroups tomorrow/day-after/upcoming buckets survive fall-back (TD-D1a)', () => {
  // Stored dayStart rows are local midnights (src/main/db-rows.js scheduledDay). With the old
  // `today + DAY_MS` filters, across 2026-11-01 the ms-stepped comparison values were Nov 1
  // 23:00 / Nov 2 23:00 — no row matched catTomorrow/catDat at all and the upcoming threshold
  // mis-binned Nov 2 rows.
  const today = +dayjs('2026-11-01')
  const row = (dayStartTs, complete = false) => ({ taskId: 't' + dayStartTs, complete, dayStart: dayStartTs, taskSort: 0, createTime: 0 })
  const g = buildExpiryGroups({
    list: [row(+dayjs('2026-11-02')), row(+dayjs('2026-11-03')), row(+dayjs('2026-11-04'))],
    settings: {}, today, t: k => k,
    keys: { expDone: 'expDone', expUndo: 'expUndo', upcoming: 'upcoming', noDate: 'noDate' }
  })
  const keyOf = ts => (g.find(x => x.todos.some(r => r.dayStart === ts)) || {}).key
  assert.equal(keyOf(+dayjs('2026-11-02')), 'catTomorrow', 'Nov 2 row lands in catTomorrow')
  assert.equal(keyOf(+dayjs('2026-11-03')), 'catDat', 'Nov 3 row lands in catDat')
  assert.equal(keyOf(+dayjs('2026-11-04')), 'catUpcoming', 'Nov 4 row lands in catUpcoming')
})

test('[day-caliber DST] retention cutoff equals the todo-row purge calendar contract (TD-D1c)', () => {
  // The tombstone recovery cutoff must equal store/todo.js's purge contract:
  // +dayjs().startOf('day').subtract(days,'day'). The former ms arithmetic diverged by -3600000ms
  // here (Sat Mar 7 23:00 vs Sun Mar 8 00:00), letting the recovery entry expire while the rows
  // it recovers were still inside the retention window.
  const now = +dayjs('2026-03-09').hour(12)
  const days = 1
  const calendarCutoff = +dayjs(now).startOf('day').subtract(days, 'day')
  assert.equal(dayShift(dayStart(now), -days), calendarCutoff, 'dayShift(dayStart(now), -days) IS the purge contract')
  assert.equal(calendarCutoff, +dayjs('2026-03-08'), 'the contract cutoff is Mar 8 local midnight')
  assert.notEqual(dayStart(now) - days * 86400000, calendarCutoff, 'the old ms arithmetic lands Mar 7 23:00 — the removed bug')
})
