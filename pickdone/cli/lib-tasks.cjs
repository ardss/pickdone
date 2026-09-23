'use strict'
/* Task read commands extracted verbatim from cli/lib.js (2026-09-23, #132 skipped P3-11 continuation:
   god-module split). Pure move — no behavior change; deps injected by lib.js so the db/bus seam stays single. */
module.exports = (deps) => {
  const { open, CliError, parseDate, dayjs } = deps
/* ================= Read commands ================= */
function listTodos (opts = {}) {
  const q = { deleted: 0, orderBy: 'scheduledDay ASC, sort ASC' }
  // Context protection: truncate by default when no limit is given, to avoid flooding the AI's context in one shot
  // Invalid --limit (NaN) must fall back to the same default 200 as absent, not a silent 50-row cap
  q.limit = opts.limit ? Math.min(parseInt(opts.limit, 10) || 200, 500) : 200
  const now = dayjs()
  if (opts.done != null) q.complete = opts.done
  if (opts.category != null) q.categoryId = opts.category
  if (opts.keyword) q.keyword = opts.keyword
  if (opts.noDate) q.noDate = true
  if (opts.quad) { q.important = opts.quad.important; q.urgent = opts.quad.urgent }
  if (opts.range === 'today') { q.dayStartFrom = +now.startOf('day'); q.dayStartTo = +now.endOf('day') }
  else if (opts.range === 'tomorrow') { const t = now.add(1, 'day'); q.dayStartFrom = +t.startOf('day'); q.dayStartTo = +t.endOf('day') }
  // Fix (2026-09-16): `week` now means the ISO week (Mon..Sun, same window as saved views' dateMode 'week' /
  // FilterView applyViewConds endOf('isoWeek')) instead of a rolling 7 days; the rolling semantics moved to the new `next7d` range so nothing is lost.
  else if (opts.range === 'week') { q.dayStartFrom = +now.startOf('day'); q.dayStartTo = +now.endOf('isoWeek') }
  else if (opts.range === 'next7d') { q.dayStartFrom = +now.startOf('day'); q.dayStartTo = +now.add(7, 'day').endOf('day') }
  else if (opts.range === 'overdue') { q.dayStartTo = +now.subtract(1, 'day').endOf('day') }
  else if (opts.range === 'future') { q.dayStartFrom = +now.add(1, 'day').startOf('day') }
  return open().call('queryTodos', q)
}

function getCategories () { return open().call('getAllCategories') }

function resolveCategory (input) {
  if (input == null || input === '' || input === 'none') return null
  const cats = getCategories()
  if (!cats.length) throw new CliError('no categories exist (categories are created in the UI, stored in the SQLite categories table)', 'NO_CATEGORIES')
  const byId = cats.find(c => String(c.categoryId) === String(input))
  if (byId) return byId.categoryId
  // Strip zero-width/full-width whitespace (IME candidates occasionally contain zero-width chars)
  const norm = v => String(v).toLowerCase().replace(/[\s\u00A0\u3000\u200B\u2003]/g, '')
  const kw = norm(input)
  const hits = cats.filter(c => norm(c.categoryName || '').includes(kw))
  if (hits.length === 1) return hits[0].categoryId
  if (hits.length > 1) throw new CliError(`category "${input}" is ambiguous: ${hits.map(c => c.categoryName).join(", ")}`, 'AMBIGUOUS_MATCH')
  throw new CliError(`category not found: "${input}" (available: ${cats.map(c => c.categoryName).join(", ")})`, 'CATEGORY_NOT_FOUND')
}

function stats ({ from, to } = {}) {
  const now = dayjs()
  const fmt = d => parseInt(d.format('YYYYMMDD'), 10)
  // Fix (2026-09-16): --from/--to go through the same parseDate as add/edit, so `stats --from today` /
  // `--from +7d` work; the old bare dayjs(from) turned keywords into Invalid Date and died inside the db layer as an opaque USAGE error.
  const f = from ? fmt(dayjs(parseDate(from))) : fmt(now.subtract(6, 'day'))
  const t = to ? fmt(dayjs(parseDate(to))) : fmt(now)
  const db = open()
  const plan = db.call('statsByDay', { from: f, to: t })
  const tomato = db.call('tomatoByDay', { from: f, to: t })
  const msToYmd = ms => parseInt(dayjs(ms).format('YYYYMMDD'), 10) // day_start ms → YYYYMMDD display key
  const focusByDay = Object.fromEntries(tomato.map(r => [Number(String(r.ds).replace(/-/g, "")), r.focus])) // 归一 YYYYMMDD 整数键
  // 并集:有任务的日(按 scheduledDay) ∪ 有完成记录的日 ∪ 有专注记录的日——只专注没建任务的天不能消失
  const days = new Map()
  for (const r of plan.rows) days.set(msToYmd(r.ds), { total: r.total, done: r.done || 0, doneCompleted: 0 })
  // done 口径分裂修复:done=按 scheduledDay(计划日)的完成;doneCompleted=按 completedAt(完成日)的完成,与 db.js doneByCompletionDay / 渲染端 metrics.js 的完成日口径对齐
  for (const d of plan.doneByCompletionDay) {
    const k = Number(d.ds)
    if (days.has(k)) days.get(k).doneCompleted = d.n
    else days.set(k, { total: 0, done: 0, doneCompleted: d.n })
  }
  for (const t of tomato) { const k = Number(String(t.ds).replace(/-/g, "")); if (!days.has(k)) days.set(k, { total: 0, done: 0, doneCompleted: 0 }) }
  return [...days.entries()].map(([day, v]) => ({ day, total: v.total, done: v.done, doneCompleted: v.doneCompleted, focusMinutes: focusByDay[day] || 0 }))
    .sort((a, b) => a.day - b.day)
}

function overview () {
  const now = dayjs()
  const today0 = +now.startOf('day')
  const today24 = +now.endOf('day')
  const week24 = +now.add(7, 'day').endOf('day')
  const all = open().call('queryTodos', { deleted: 0 })
  return {
    today: {
      total: all.filter(t => t.dayStart >= today0 && t.dayStart <= today24).length,
      done: all.filter(t => t.dayStart >= today0 && t.dayStart <= today24 && t.complete).length,
      // 口径对齐 App(metrics.js doneTsOf):按 completedAt 落在今天计完成,completedAt=0 的历史/异常行按
      // updateTime 兜底(P3 2026-09-23;与 db.js statsByDay doneByCompletionDay 同 commit 对齐,旧注释自称对齐实际没有)
      doneToday: all.filter(t => t.complete && (t.completedAt || t.updateTime || 0) >= today0 && (t.completedAt || t.updateTime || 0) <= today24).length
    },
    overdue: all.filter(t => !t.complete && t.dayStart > 0 && t.dayStart < today0).length,
    noDate: all.filter(t => !t.dayStart).length,
    upcoming7days: all.filter(t => t.dayStart > today24 && t.dayStart <= week24).length,
    completedTotal: all.filter(t => t.complete).length,
    recycleBin: open().call('queryTodos', { deleted: 1 }).length,
    categories: open().call('getAllCategories').length
  }
}

  return { listTodos, getCategories, resolveCategory, stats, overview }
}
