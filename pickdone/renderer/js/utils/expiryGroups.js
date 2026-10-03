import { rangeDays, rangeLabel } from './core.js'
import { dayShift } from './todayBounds.js'
import { calTitle } from './buckets.js'

/**
 * Expiry-window group builder shared by CategoryView and ProjectView (wave-5 dedup: the two
 * views previously kept ~27 verbatim lines each — same two-level expired ranges, same bucket
 * comparator (taskSort desc -> createTime desc), same 7 group buckets with the same
 * color/hasSettings/hasRecomplete props).
 * Differences kept as parameters: the i18n keys (CategoryView mixes statsI/statsE, ProjectView
 * uses statsB) and ProjectView's extra full-completed fallback group (projDone).
 * The group `key`s (catExpDone..catNoDate) are a shared UI contract (collapse maps, tests) and
 * stay unchanged.
 *
 * @param {Object} o
 * @param {Array}  o.list        rows of one list (the view's inCat)
 * @param {Object} o.settings    settings (expiredCompletedTodoRange/expiredUncompletedTodoRange)
 * @param {number} o.today      start-of-day timestamp
 * @param {Function} o.t        i18n function ($t)
 * @param {Object} o.keys       { expDone, expUndo, upcoming, noDate } i18n keys
 * @param {Array}  [o.extraGroups] extra trailing groups: { key, titleKey, filter, props }
 */
export function buildExpiryGroups ({ list, settings, today, t, keys, extraGroups }) {
  const R1 = rangeDays(settings.expiredCompletedTodoRange, 7)
  const R2 = rangeDays(settings.expiredUncompletedTodoRange, 30)
  const bucket = f => list.filter(f).sort((a, b) => b.taskSort - a.taskSort || b.createTime - a.createTime)
  const g = []
  const expDone = bucket(x => x.complete && x.dayStart && x.dayStart < today && x.dayStart >= dayShift(today, -R1))
  if (expDone.length) g.push({ key: 'catExpDone', title: t(keys.expDone, { r: rangeLabel(settings.expiredCompletedTodoRange, t) }), todos: expDone, showDate: true, hasSettings: true })
  const expUndo = bucket(x => !x.complete && x.dayStart && x.dayStart < today && x.dayStart >= dayShift(today, -R2)).sort((a, b) => a.dayStart - b.dayStart)
  if (expUndo.length) g.push({ key: 'catExpUndo', title: t(keys.expUndo, { r: rangeLabel(settings.expiredUncompletedTodoRange, t) }), todos: expUndo, showDate: true, color: 'color2', hasSettings: true, hasRecomplete: true })
  const td = bucket(x => !x.complete && x.dayStart === today)
  if (td.length) g.push({ key: 'catToday', title: calTitle(today), todos: td, color: 'color3' })
  // Shared invariant (D13 A1/A2): a task scheduled today and completed today matched NO bucket
  // (catExpDone requires dayStart < today, catToday requires !complete) and vanished from every
  // consumer without a projDone fallback until tomorrow. Every non-future task now lands in
  // exactly one group: completed today lives here.
  const tdd = bucket(x => x.complete && x.dayStart === today)
  if (tdd.length) g.push({ key: 'catTodayDone', title: calTitle(today), todos: tdd, color: 'color3' })
  // Sibling-day buckets step via dayShift (calendar semantics): `today + n*86400000` misses
  // stored dayStart rows across a DST transition (local midnights 23h/25h apart) — the exact
  // === filters silently dropped the whole bucket.
  const tm = bucket(x => x.dayStart === dayShift(today, 1))
  if (tm.length) g.push({ key: 'catTomorrow', title: calTitle(dayShift(today, 1)), todos: tm, color: 'color3' })
  const dat = bucket(x => x.dayStart === dayShift(today, 2))
  if (dat.length) g.push({ key: 'catDat', title: calTitle(dayShift(today, 2)), todos: dat, color: 'color3' })
  const up = bucket(x => !x.complete && x.dayStart > dayShift(today, 2))
  if (up.length) g.push({ key: 'catUpcoming', title: t(keys.upcoming), todos: up, showDate: true, color: 'color3', hasSettings: true })
  const nd = bucket(x => !x.complete && !x.dayStart)
  if (nd.length) g.push({ key: 'catNoDate', title: t(keys.noDate), todos: nd, hasSettings: true })
  for (const eg of extraGroups || []) {
    const rows = bucket(eg.filter)
    if (rows.length) g.push({ key: eg.key, title: t(eg.titleKey), todos: rows, ...(eg.props || {}) })
  }
  return g
}

/**
 * [B9] TagView's completed fallback predicate (the manual-builder twin of the D13-A2 projDone
 * extraGroup). TagView never received the fallback CategoryView/ProjectView got, so a completed
 * task 3+ days in the future (tagUpcoming requires !complete) or older than the R1 completed
 * window matched NO bucket and vanished from the tag page. True only for completions OUTSIDE
 * every other tag bucket (today / R1 window / tomorrow / day+2), keeping the exactly-one-group
 * invariant intact. Pure so the boundary behavior is unit-testable.
 *
 * @param {Object} t todo row ({ complete, dayStart })
 * @param {number} today start-of-day timestamp
 * @param {number} r1 expiredCompletedTodoRange in days
 */
export function tagStaleDone (t, today, r1) {
  if (!t || !t.complete || !t.dayStart) return false
  if (t.dayStart === today) return false
  return t.dayStart > dayShift(today, 2) || t.dayStart < dayShift(today, -r1)
}
