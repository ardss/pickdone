import { FMT } from './core.js'
/**
 * Day-level bucketing utility (shared by three views) — aligned with the grouping semantics of the reference RecentTodoList
 * Past completed (R1) / overdue incomplete (R2, reschedulable) / today / tomorrow / day after tomorrow / upcoming / no date
 */
import { dayjs, tt, rangeDays } from './core.js'

/** Follows the title format of x.e: today/tomorrow/day after tomorrow → "Today WeekX"; further out → M/D WeekX; crossing years → YYYY/M/D */
export function calTitle (ts, now) {
  const d = dayjs(ts)
  const t = dayjs(now || undefined).startOf('day')
  const s = d.startOf('day')
  const wk = tt('statsA.core.weekOf', { w: tt('statsA.core.wd' + d.day()) })
  if (+s === +t) return tt('statsA.core.calToday', { w: wk })
  if (+s === +t.add(1, 'day')) return tt('statsA.core.calTomorrow', { w: wk })
  if (+s === +t.add(2, 'days')) return tt('statsA.core.calDat', { w: wk })
  return s.year() === t.year()
    ? tt('statsA.core.calMd', { m: s.month() + 1, d: s.date(), w: wk })
    : s.format(FMT.cnFull)
}

/**
 * B5/D14-B5 (2026-10-02): the hard `agoDays >= 30` cap ignored settings.expiredCompletedTodoRange —
 * the setting was dead on the Completed page, and with '30d' the 30th-day row appeared on
 * category/project pages (expiryGroups: dayStart >= today - R1 days) but not here. The cap now
 * follows the setting (same rangeDays semantics as buildExpiryGroups, defaulting to the legacy
 * 30 when no setting is passed) and the boundary is INCLUSIVE of the R1-th day, matching
 * expiryGroups' `>= dayShift(today, -R1)` comparison.
 * @param {Array}  list         completed todos
 * @param {number} today        start-of-day timestamp
 * @param {string} [rangeSetting] settings.expiredCompletedTodoRange ('7d'|'15d'|'30d'|...)
 */
export function buildCompletedBuckets (list, today = +dayjs().startOf('day'), rangeSetting) {
  const range = rangeDays(rangeSetting, 30)
  const defs = [
    { key: 'done-today', titleKey: 'statsA.core.today', min: 0, max: 1 },
    { key: 'done-yesterday', titleKey: 'statsA.core.yesterday', min: 1, max: 2 },
    { key: 'done-day2', title: 'statsA.core.dayBeforeYesterday', min: 2, max: 3 },
    { key: 'done-d7', title: 'statsA.core.d7Ago', min: 3, max: 7 },
    { key: 'done-d30', title: 'statsA.core.d30Ago', min: 7, max: range + 1 }
  ]
  const buckets = defs.map(d => ({ ...d, todos: [] }))
  for (const t of list) {
    const doneTs = t.completedAt || t.updateTime || 0
    if (!doneTs) continue
    // dayjs calendar-diff to compute day distance: millisecond division on a DST switch day (only 23h) would count yesterday's completions into today's bucket
    const agoDays = dayjs(today).startOf('day').diff(dayjs(doneTs).startOf('day'), 'day')
    if (agoDays > range) continue
    const b = buckets.find(x => agoDays >= x.min && agoDays < x.max)
    if (b) b.todos.push(t)
  }
  return buckets.filter(b => b.todos.length)
}
