import { rangeDays, rangeLabel, DAY_MS } from './core.js'
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
  const expDone = bucket(x => x.complete && x.dayStart && x.dayStart < today && x.dayStart >= today - R1 * DAY_MS)
  if (expDone.length) g.push({ key: 'catExpDone', title: t(keys.expDone, { r: rangeLabel(settings.expiredCompletedTodoRange, t) }), todos: expDone, showDate: true, hasSettings: true })
  const expUndo = bucket(x => !x.complete && x.dayStart && x.dayStart < today && x.dayStart >= today - R2 * DAY_MS).sort((a, b) => a.dayStart - b.dayStart)
  if (expUndo.length) g.push({ key: 'catExpUndo', title: t(keys.expUndo, { r: rangeLabel(settings.expiredUncompletedTodoRange, t) }), todos: expUndo, showDate: true, color: 'color2', hasSettings: true, hasRecomplete: true })
  const td = bucket(x => !x.complete && x.dayStart === today)
  if (td.length) g.push({ key: 'catToday', title: calTitle(today), todos: td, color: 'color3' })
  const tm = bucket(x => x.dayStart === today + DAY_MS)
  if (tm.length) g.push({ key: 'catTomorrow', title: calTitle(today + DAY_MS), todos: tm, color: 'color3' })
  const dat = bucket(x => x.dayStart === today + 2 * DAY_MS)
  if (dat.length) g.push({ key: 'catDat', title: calTitle(today + 2 * DAY_MS), todos: dat, color: 'color3' })
  const up = bucket(x => !x.complete && x.dayStart > today + 2 * DAY_MS)
  if (up.length) g.push({ key: 'catUpcoming', title: t(keys.upcoming), todos: up, showDate: true, color: 'color3', hasSettings: true })
  const nd = bucket(x => !x.complete && !x.dayStart)
  if (nd.length) g.push({ key: 'catNoDate', title: t(keys.noDate), todos: nd, hasSettings: true })
  for (const eg of extraGroups || []) {
    const rows = bucket(eg.filter)
    if (rows.length) g.push({ key: eg.key, title: t(eg.titleKey), todos: rows, ...(eg.props || {}) })
  }
  return g
}
