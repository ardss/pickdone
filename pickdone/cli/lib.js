/**
 * Todo CLI core library — reuses the main process's db.js OPS table; write semantics aligned with renderer/js/store/todo.js
 * (add→status:'add' / update→'update' / delete→'delete'; completedAt written only on complete/undo;
 *   dayStart is derived from todoTime by db.js todoToRow; local writes do not advance meta.todosVersion — managed by the cloud-sync pipeline)
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const dayjs = require('dayjs')
require('dayjs/locale/zh-cn')
dayjs.locale('zh-cn')

// The CLI runs in pure Node; silence electron-log to keep logs out of the stdout JSON output
try {
  const log = require('electron-log')
  if (log.transports) {
    if (log.transports.console) log.transports.console.level = false
    if (log.transports.file) log.transports.file.level = false
  }
} catch (e) { /* ignore when electron-log is not installed */ }

const dbm = require('../src/main/db.js')
const core = require('../src/main/core/todo-core.js')
const audit = require('./audit.js')
const nlDate = require('./nl-date.cjs')

let opened = false
// Single source of truth for the userData directory name (a result of app.setName('pickdone'); audit.js reuses this export, do not assemble a third copy)
// Env var relationship (backward compatible):
//   TODO_DB_DIR          — legacy CLI-only override; points DIRECTLY at the data directory that contains todos.db (behavior unchanged)
//   TODO_USER_DATA_DIR   — the main-process isolation var (src/main/index.js); treated as the userData root, which also contains todos.db
//                          at its top level, so the CLI can reuse it directly. Priority: TODO_DB_DIR > TODO_USER_DATA_DIR > %APPDATA%/pickdone.
// Neither var set means the real user database — scripts that spawn the App MUST fail fast instead (see e2e-walkthrough.js / ui-smoke.js).
function userDataDir () {
  return process.env.TODO_DB_DIR ||
    process.env.TODO_USER_DATA_DIR ||
    path.join(process.env.APPDATA || '', 'pickdone')
}
/** True when an explicit isolation dir (TODO_DB_DIR or TODO_USER_DATA_DIR) is set */
function hasIsolationEnv () {
  return !!(process.env.TODO_DB_DIR || process.env.TODO_USER_DATA_DIR)
}
/** Open the database (idempotent). The TODO_DB_DIR env var can point to an isolated directory (for tests); defaults to the App's userData */
function open () {
  if (opened) return dbm
  // Main process reuse: when the App itself has already opened the DB with the same directory (CSV import goes through the main process IPC), init must not be run a second time to rebuild the connection
  if (dbm.isOpen && dbm.isOpen()) { opened = true; return dbm }
  const dir = userDataDir()
  dbm.init(dir)
  opened = true
  return dbm
}

/* ================= Errors ================= */
class CliError extends Error {
  constructor (message, code = 'CLI_ERROR') { super(message); this.code = code }
}

/* ================= Date parsing ================= */
/** Supports today/tomorrow/yesterday/+N/-N days, YYYY-MM-DD, YYYY-MM-DD HH:mm, timestamps */
function parseDate (s) {
  if (s == null || s === '') return 0
  const str = String(s).trim().toLowerCase()
  // Explicitly accept only 13-digit ms timestamps (avoids a 12-digit seconds value being parsed as ms → 1970)
  if (/^[+-]?\d{13}$/.test(str)) return parseInt(str, 10) // timestamp
  const now = dayjs()
  // Relative offsets: +3d / -1w / +2m, and offset-with-time like +2d 16:30
  const offTime = str.match(/^([+-])(\d+)([dwm])\s+(\d{1,2}):(\d{2})$/)
  const offMatch = str.match(/^([+-])(\d+)([dwm])$/)
  if (offTime || offMatch) {
    const sign = (offTime || offMatch)[1]
    const n = parseInt((offTime || offMatch)[2]) * (sign === '+' ? 1 : -1)
    const unit = { d: 'day', w: 'week', m: 'month' }[(offTime || offMatch)[3]]
    const base = now.add(n, unit)
    if (offTime) return +base.hour(+offTime[4]).minute(+offTime[5]).second(0).millisecond(0)
    return +base
  }
  if (str === 'today' || str === '今天') return +now
  if (str === 'tomorrow' || str === '明天') return +now.add(1, 'day')
  if (str === 'yesterday' || str === '昨天') return +now.subtract(1, 'day')
  // Keyword+time combos (tomorrow 09:00 / 明天11点) resolve deterministically before nlDate: "tomorrow" said in the small hours would
  // colloquially land on today's daytime per Chinese usage, but for the CLI's AI users tomorrow must be unambiguous (+1 day)
  const kw = str.match(/^(today|tomorrow|yesterday)\s+(\d{1,2}):(\d{2})$/)
  if (kw) {
    const base = { today: now, tomorrow: now.add(1, 'day'), yesterday: now.subtract(1, 'day') }[kw[1]]
    return +base.hour(+kw[2]).minute(+kw[3]).second(0).millisecond(0)
  }
  const d = dayjs(str)
  if (!d.isValid()) {
    // Chinese natural-language date fallback (后天/下周五/3天后/周末/M月D日…): same rule set as the renderer's nlDate, saving AI conversion tokens
    const nl = nlDate.parseNaturalDate(String(s).trim())
    if (nl && nl.date) return +nl.date
    throw new CliError(`cannot parse date: "${s}" (supported: today/tomorrow/+3d/YYYY-MM-DD[ HH:mm], plus Chinese forms like 后天/下周五/8月15日)`)
  }
  // dayjs silent carry-over (2025-02-29 → 2025-03-01) — split Y/M/D and validate explicitly, aligned with the renderer's nlDate
  const dateMatch = str.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/)
  if (dateMatch) {
    const y = +dateMatch[1]; const mo = +dateMatch[2]; const d2 = +dateMatch[3]
    const days = dayjs().year(y).month(mo - 1).daysInMonth()
    if (mo < 1 || mo > 12 || d2 < 1 || d2 > days) throw new CliError(`invalid date: "${s}" (${y}-${mo} has only ${days} days)`)
  }
  return +d
}

/** Deadline → 00:00 of that day (consistent with the renderer's dayjs(todoTime).startOf('day')) */
function dayStartOf (ts) { return ts ? +dayjs(ts).startOf('day') : 0 }

/* ---------------- Lunar annotation (solarlunar, same ISC dependency the App's calendar/repeat use) ---------------- */
let _solarlunar = null
function solarlunar () {
  if (!_solarlunar) _solarlunar = (r => (r && r.default) ? r.default : r)(require('solarlunar'))
  return _solarlunar
}

/** Short lunar annotation for a task's displayed date: "七月廿九" (null when the task has no date or the lib is missing) */
function lunarOf (t) {
  const ts = t && (t.todoTime || t.dayStart)
  if (!ts) return null
  try {
    const d = dayjs(ts)
    const l = solarlunar().solar2lunar(d.year(), d.month() + 1, d.date())
    return l && l.monthCn && l.dayCn ? l.monthCn + l.dayCn : null
  } catch { return null }
}

/** Full annotation for --json rows: "YYYY-MM-DD · 七月廿九" (null for undated tasks) */
function lunarAnnotate (t) {
  const short = lunarOf(t)
  if (!short) return null
  return dayjs(t.todoTime || t.dayStart).format('YYYY-MM-DD') + ' · ' + short
}

/* ================= Task resolution ================= */
function liveTasks () { return open().call('queryTodos', { deleted: 0, orderBy: 'scheduledDay ASC, sort ASC' }) }
function recycleTasks () { return open().call('queryTodos', { deleted: 1, orderBy: 'updatedAt DESC' }) }

/** Resolve user input into a task: exact match on a full taskId → otherwise unique substring match on content (case-insensitive) */
function resolveTask (input, pool) {
  const list = pool || [...liveTasks(), ...recycleTasks()]
  const byId = list.find(t => t.taskId === input)
  if (byId) return byId
  // Strip zero-width/full-width whitespace (IME candidates occasionally contain zero-width chars)
  // Same normalization on both sides: stripping it only from the input made any multi-word keyword unmatchable
  const norm = v => String(v).toLowerCase().replace(/[\s\u00A0\u3000\u200B\u2003]/g, '')
  const kw = norm(input)
  const hits = list.filter(t => norm(t.taskContent || '').includes(kw))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    throw new CliError(`"${input}" matched ${hits.length} tasks; use a more specific keyword or the full taskId:\n` +
      hits.slice(0, 10).map(t => `  - ${t.taskContent} (${t.taskId})`).join('\n'), 'AMBIGUOUS_MATCH')
  }
  throw new CliError(`task not found: "${input}"`, 'TASK_NOT_FOUND')
}

/** userId: take user_id from any row in the DB (consistent with the UI's login state) */
function guessUserId () {
  const row = open().call('queryTodos', { deleted: 0, limit: 1 })[0] ||
    open().call('queryTodos', { deleted: 1, limit: 1 })[0]
  return row ? row.userId : 0
}

const genTaskId = core.genTaskId

/* ================= Read commands ================= */
function listTodos (opts = {}) {
  const q = { deleted: 0, orderBy: 'scheduledDay ASC, sort ASC' }
  // Context protection: truncate by default when no limit is given, to avoid flooding the AI's context in one shot
  q.limit = opts.limit ? Math.min(parseInt(opts.limit, 10) || 50, 500) : 200
  const now = dayjs()
  if (opts.done != null) q.complete = opts.done
  if (opts.category != null) q.categoryId = opts.category
  if (opts.keyword) q.keyword = opts.keyword
  if (opts.noDate) q.noDate = true
  if (opts.quad) { q.important = opts.quad.important; q.urgent = opts.quad.urgent }
  if (opts.range === 'today') { q.dayStartFrom = +now.startOf('day'); q.dayStartTo = +now.endOf('day') }
  else if (opts.range === 'tomorrow') { const t = now.add(1, 'day'); q.dayStartFrom = +t.startOf('day'); q.dayStartTo = +t.endOf('day') }
  else if (opts.range === 'week') { q.dayStartFrom = +now.startOf('day'); q.dayStartTo = +now.add(7, 'day').endOf('day') }
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
  const f = from ? fmt(dayjs(from)) : fmt(now.subtract(6, 'day'))
  const t = to ? fmt(dayjs(to)) : fmt(now)
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
      // 口径对齐 App(metrics.js doneTsOf):按 completedAt 落在今天计完成,旧 done(按 dayStart)保留兼容
      doneToday: all.filter(t => t.complete && t.completedAt >= today0 && t.completedAt <= today24).length
    },
    overdue: all.filter(t => !t.complete && t.dayStart > 0 && t.dayStart < today0).length,
    noDate: all.filter(t => !t.dayStart).length,
    upcoming7days: all.filter(t => t.dayStart > today24 && t.dayStart <= week24).length,
    completedTotal: all.filter(t => t.complete).length,
    recycleBin: open().call('queryTodos', { deleted: 1 }).length,
    categories: open().call('getAllCategories').length
  }
}

/* ================= Projects (categories flagged via meta projectCategoryIds, shared data source with the UI's progressive disclosure) ================= */
const PROJECT_IDS_KEY = 'projectCategoryIds'

/** Single project four-question stats: when it started / how it is progressing / how much focus was invested / most recent activity */
function projectStatus (c) {
  const list = open().call('queryTodos', { deleted: 0, categoryId: c.categoryId })
  const done = list.filter(t => t.complete)
  // 真实专注口径:聚合挂在本项目任务上的 actual 专注记录(与 stats/tomato list 同源,预计番茄口径退役)
  const idset = new Set(list.map(t => t.taskId))
  const actualFocus = tomatoRecords().reduce((s, r) => s + (r.succeed !== false && r.focusTaskId && idset.has(r.focusTaskId) ? (Number(r.focusDuration) || 0) : 0), 0)
  const today0 = +dayjs().startOf('day')
  const week24 = +dayjs().add(7, 'day').endOf('day')
  const started = list.reduce((m, t) => Math.min(m, t.createTime || m), Infinity)
  return {
    categoryId: c.categoryId, name: c.categoryName, color: c.categoryColor,
    total: list.length, done: done.length,
    progress: list.length ? Math.round(done.length / list.length * 100) : 0,
    focusMinutes: actualFocus,
    startedAt: isFinite(started) ? started : 0,
    lastActivity: done.reduce((m, t) => Math.max(m, t.completedAt || 0), 0),
    overdue: list.filter(t => !t.complete && t.dayStart > 0 && t.dayStart < today0).length,
    next7days: list.filter(t => !t.complete && t.dayStart >= today0 && t.dayStart <= week24).length,
    deadline: getProjectDeadline(c.categoryId),
    // explicit user-set status (see setProjectStatus) — separate concern from the derived progress stats above
    status: explicitStatus(c.categoryId)
  }
}

function getProjectIds () {
  try { const a = JSON.parse(open().call('getMeta', PROJECT_IDS_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

function getProjects () {
  const ids = getProjectIds()
  return open().call('getAllCategories').filter(c => ids.includes(c.categoryId)).map(projectStatus)
}

/** Set/unset as project (category name or id), with audit trail */
function setProjectFlag (input, flag) {
  const db = open()
  const id = resolveCategory(input)
  const cats = db.call('getAllCategories')
  const c = cats.find(x => x.categoryId === id)
  const ids = getProjectIds().filter(x => x !== id)
  if (flag) ids.push(id)
  db.call('setMeta', [PROJECT_IDS_KEY, JSON.stringify(ids)])
  audit.record({ action: 'project.set', targets: [{ taskId: 'cat:' + id, content: c ? c.categoryName : String(id) }], note: (flag ? 'set as project' : 'unset project') })
  return { categoryId: id, name: c ? c.categoryName : String(id), isProject: !!flag }
}

/* ================= Milestones (meta projectMilestones:<categoryId>, same source as the UI timeline) ================= */
const MS_KEY = id => 'projectMilestones:' + id

function msNormalize (list) {
  return (Array.isArray(list) ? list : []).filter(m => m && m.title && m.date)
    .map(m => ({
      id: m.id || ('ms_' + Date.now() + Math.random().toString(36).slice(2, 6)),
      title: String(m.title),
      date: Number(m.date),
      taskIds: Array.isArray(m.taskIds) ? m.taskIds.filter(Boolean) : []
    }))
    .sort((a, b) => a.date - b.date)
}

/** Milestone progress (N2): linked tasks → completion ratio; none linked → null (purely date-driven) */
function msProgress (m, tasks) {
  const ids = new Set(m.taskIds || [])
  if (!ids.size) return null
  const linked = tasks.filter(t => ids.has(t.taskId))
  if (!linked.length) return null
  const done = linked.filter(t => t.complete).length
  return { done, total: linked.length, pct: Math.round(done / linked.length * 100) }
}

function getMilestones (categoryInput) {
  const id = resolveCategory(categoryInput)
  let list = []
  try { list = JSON.parse(open().call('getMeta', MS_KEY(id)) || '[]') } catch { /* treat a corrupt row as empty */ }
  return { categoryId: id, milestones: msNormalize(list) }
}

/** Milestone date parsing: YYYY-MM-DD / MM-DD (current year) / today | +Nd (明天 supported in parse below) */
function parseMilestoneDate (input) {
  const s = String(input || '').trim().toLowerCase()
  if (!s) return null
  let d = dayjs(s)
  if (!d.isValid() && /^\d{1,2}-\d{1,2}$/.test(s)) d = dayjs(`${dayjs().year()}-${s}`)
  if (!d.isValid() && s === 'today') d = dayjs()
  if (!d.isValid() && s === '明天') d = dayjs().add(1, 'day')
  if (!d.isValid()) { const m = s.match(/^([+-])(\d+)d?$/); if (m) d = dayjs().add(m[1] === '+' ? +m[2] : -m[2], 'day') }
  return d.isValid() ? +d.startOf('day') : null
}

function addMilestone (categoryInput, title, dateInput) {
  const { categoryId } = getMilestones(categoryInput)
  if (!title || !String(title).trim()) throw new CliError('milestone title required', 'EMPTY_CONTENT')
  const date = parseMilestoneDate(dateInput)
  if (!date) throw new CliError(`cannot parse date: "${dateInput}" (supported: YYYY-MM-DD / MM-DD / today / +14d)`, 'BAD_DATE')
  const cat = open().call('getAllCategories').find(c => c.categoryId === categoryId)
  const list = msNormalize(getMilestones(categoryId).milestones.concat([{ title: String(title).trim(), date }]))
  open().call('setMeta', [MS_KEY(categoryId), JSON.stringify(list)])
  audit.record({ action: 'milestone.add', targets: [{ taskId: 'cat:' + categoryId, content: cat ? cat.categoryName : String(categoryId) }], note: `milestone "${title.trim()}" → ${dayjs(date).format('YYYY-MM-DD')}` })
  return { categoryId, milestones: list }
}

function removeMilestone (categoryInput, index) {
  const { categoryId, milestones } = getMilestones(categoryInput)
  const i = parseInt(index, 10) - 1
  if (!(i >= 0 && i < milestones.length)) throw new CliError(`milestone index out of range: ${index} (${milestones.length} total; use milestone list)`, 'MS_NOT_FOUND')
  const [removed] = milestones.splice(i, 1)
  open().call('setMeta', [MS_KEY(categoryId), JSON.stringify(milestones)])
  audit.record({ action: 'milestone.rm', targets: [{ taskId: 'cat:' + categoryId, content: removed.title }], note: 'milestone removed' })
  return { categoryId, milestones, removed }
}

/** Link/unlink a task to a milestone (N2): progress = completion ratio of linked tasks, same source as the UI */
function linkMilestone (categoryInput, index, taskInput, link = true) {
  const { categoryId, milestones } = getMilestones(categoryInput)
  const i = parseInt(index, 10) - 1
  if (!(i >= 0 && i < milestones.length)) throw new CliError(`milestone index out of range: ${index} (${milestones.length} total)`, 'MS_NOT_FOUND')
  const t = resolveTask(taskInput, liveTasks())
  const ms = milestones[i]
  const ids = new Set(ms.taskIds || [])
  link ? ids.add(t.taskId) : ids.delete(t.taskId)
  ms.taskIds = [...ids]
  open().call('setMeta', [MS_KEY(categoryId), JSON.stringify(milestones)])
  audit.record({
    action: link ? 'milestone.link' : 'milestone.unlink',
    targets: [{ taskId: 'cat:' + categoryId, content: ms.title }, t],
    note: (link ? 'link task to milestone (' : 'unlink task from milestone (') + ms.title + ')'
  })
  return { categoryId, milestone: ms, progress: msProgress(ms, open().call('queryTodos', { deleted: 0, categoryId })) }
}

/** Project deadline (meta projectDeadline:<id>, same source as the UI). Pass none/empty in dateInput to clear */
function setProjectDeadline (input, dateInput) {
  const id = resolveCategory(input)
  const cat = open().call('getAllCategories').find(c => c.categoryId === id)
  const key = 'projectDeadline:' + id
  let deadline = 0
  if (dateInput != null && dateInput !== '' && !/^(none|clear|清除|取消)$/i.test(dateInput)) {
    deadline = parseMilestoneDate(dateInput)
    if (!deadline) throw new CliError(`cannot parse date: "${dateInput}" (supported: YYYY-MM-DD / MM-DD / today / +14d / none to clear)`, 'BAD_DATE')
  }
  open().call('setMeta', [key, String(deadline)])
  audit.record({
    action: 'project.deadline',
    targets: [{ taskId: 'cat:' + id, content: cat ? cat.categoryName : String(id) }],
    note: deadline ? `deadline → ${dayjs(deadline).format('YYYY-MM-DD')}` : 'deadline cleared'
  })
  return { categoryId: id, name: cat ? cat.categoryName : String(id), deadline }
}

/** Read the project deadline (0 = not set) */
function getProjectDeadline (categoryId) {
  const v = open().call('getMeta', 'projectDeadline:' + categoryId)
  const n = Number(v) || 0
  return n
}

/* ---------------- Project explicit status (meta projectStatus:<categoryId>; same key the App reads; absent = 'active') ----------------
   This is a user-set lifecycle field, distinct from the derived progress stats in projectStatus() above. */
const PROJECT_STATUS_VALUES = ['active', 'paused', 'done', 'cancelled']
const projectStatusKey = id => 'projectStatus:' + id

/** Explicit project status; absent/invalid meta value falls back to 'active' */
function explicitStatus (categoryId) {
  const v = open().call('getMeta', projectStatusKey(categoryId))
  return PROJECT_STATUS_VALUES.includes(v) ? v : 'active'
}

/** Set the explicit project status; 'none' deletes the meta key so both ends fall back to 'active' */
function setProjectStatus (input, status) {
  const id = resolveCategory(input)
  const cat = open().call('getAllCategories').find(c => c.categoryId === id)
  const name = cat ? cat.categoryName : String(id)
  const before = explicitStatus(id)
  if (String(status || '').toLowerCase() === 'none' || status == null || status === '') {
    open().call('deleteMeta', projectStatusKey(id))
    audit.record({ action: 'project.status', targets: [{ taskId: 'cat:' + id, content: name }], changes: [{ before: { status: before }, after: { status: 'active' } }], note: 'project status cleared (falls back to active)' })
    return { categoryId: id, name, status: 'active', cleared: true }
  }
  const next = String(status).toLowerCase()
  if (!PROJECT_STATUS_VALUES.includes(next)) throw new CliError(`--status accepts ${PROJECT_STATUS_VALUES.join('|')}|none (got "${status}")`, 'USAGE')
  open().call('setMeta', [projectStatusKey(id), next])
  audit.record({ action: 'project.status', targets: [{ taskId: 'cat:' + id, content: name }], changes: [{ before: { status: before }, after: { status: next } }], note: 'project status → ' + next })
  return { categoryId: id, name, status: next }
}

// ---- Task dependencies (mirror of renderer store/todo.js helpers; both writers bypass each other) ----
function parsePredecessors (v) {
  if (Array.isArray(v)) return v.filter(Boolean)
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(Boolean) : [] } catch { return [] }
}
function listActive (db) { return db.call('queryTodos', { deleted: 0 }) }
function wouldCycle (db, taskId, newPreds) {
  const byId = {}
  for (const t of listActive(db)) byId[t.taskId] = t
  byId[taskId] = Object.assign({}, byId[taskId] || { taskId }, { predecessors: JSON.stringify(newPreds) })
  const done = {}; const visiting = {}
  const walk = id => {
    if (done[id]) return false
    if (visiting[id]) return true
    visiting[id] = true
    const t = byId[id]
    if (t) for (const p of parsePredecessors(t.predecessors)) { if (byId[p] && walk(p)) return true }
    visiting[id] = false; done[id] = true
    return false
  }
  return walk(taskId)
}
function normalizePreds (db, taskId, preds) {
  const next = (Array.isArray(preds) ? preds : parsePredecessors(preds)).filter(pid => pid && pid !== taskId)
  if (wouldCycle(db, taskId, next)) throw new CliError('dependency-cycle: this predecessor set closes a loop', 'DEP_CYCLE')
  return next.length ? JSON.stringify(next) : null
}
function addTodo ({ content, desc, date, reminder, category, difficulty, priority, important, urgent, repeatId = null, createTime = null, after = null }) {
  if (!content || !String(content).trim()) throw new CliError('task content required', 'EMPTY_CONTENT')
  const db = open()
  const now = Date.now()
  // createTime 可回填(--created-at):重建历史日程时「新增」统计才不失真;缺省=现在
  const createdTs = createTime ? parseDate(createTime) : now
  const todoTime = date ? parseDate(date) : 0
      // Renewal-instance idempotency: skip when an instance with the same rid + same dayStart exists (prevents duplicate CLI runs + concurrent multi-window generation creating two)
  if (repeatId && todoTime) {
    const targetDay = +dayjs(todoTime).startOf('day')
    const existing = db.call('queryTodos', { deleted: 0, repeatId, dayStartFrom: targetDay, dayStartTo: targetDay })
    if (Array.isArray(existing) && existing.length) return existing[0]
  }
  // Top-insert sort (renderer todo.js nextSort semantics): take min-100 within the target day's pool (or the no-date pool) so new tasks land on top
  const targetDay = todoTime ? +dayjs(todoTime).startOf('day') : 0
  const daySorts = db.call('queryTodos', { deleted: 0 })
    .filter(x => (x.dayStart || 0) === targetDay)
    .map(x => x.taskSort).filter(v => v != null)
  const t = {
    complete: false, createTime: createdTs, delete: false,
    reminderTime: reminder ? parseDate(reminder) : 0,
    estimate: 0, difficulty: difficulty != null ? Number(difficulty) : null,
    priority: priority != null ? Number(priority) : 0,
    important: important != null ? Number(important) : (Number(priority) === 3 ? 1 : 0),
    urgent: urgent != null ? Number(urgent) : 0,
    repeatId, subtasks: null, image: null, files: null,
    predecessors: (after && after.length) ? JSON.stringify(after) : null,
    categoryId: resolveCategory(category) || 0,
    updateTime: now, syncTime: 0,
    taskContent: String(content).trim(),
    taskDescribe: desc ? String(desc) : '',
    taskId: genTaskId(guessUserId(), now),
    taskSort: daySorts.length ? Math.fround(Math.min(...daySorts) - 100) : 0,
    todoTime,
    userId: guessUserId(), status: 'add', version: 0
  }
  db.call('upsert', t)
  const rowAfter = db.call('getById', t.taskId)
  audit.record({ action: 'add', targets: [t], changes: [{ after: rowAfter }] })
  // Tasks with an explicit time are auto-placed on the day timeline (user-finalized 2026-09-03): the reminder answers "when will you call me", the schedule chip answers "what should I do in this slot" — both are kept
  const mm = dateExplicitTime(date)
  if (mm) { try { planSet(t.taskId, mm) } catch { /* chip write failure must not block task creation */ } }
  return rowAfter
}

/** Whether the raw --date string carries an explicit time (tomorrow 12:00 / 2026-09-04 09:30); a bare date (tomorrow) returns null */
function dateExplicitTime (s) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''))
  return m ? m[1].padStart(2, '0') + ':' + m[2] : null
}

/** patch + audit. action explicitly states the semantics (edit/delete/restore/undo/subtask); defaults to edit */
function patchTodo (input, patch, { action, note } = {}) {
  const db = open()
  const t = resolveTask(input)
  // status follows this action's semantics: explicit delete/restore uses the patch's target state, other edits use update (aligned with the store)
  const act = patch.delete !== undefined ? (patch.delete ? 'delete' : 'update') : (t.delete ? 'delete' : 'update')
  if (patch.predecessors !== undefined) patch.predecessors = normalizePreds(db, t.taskId, patch.predecessors)
  const merged = { ...t, ...patch, updateTime: Date.now(), status: act }
  if (patch.todoTime !== undefined) merged.dayStart = dayStartOf(patch.todoTime)
  db.call('upsert', merged)
  const after = db.call('getById', t.taskId)
  audit.record({ action: action || 'edit', targets: [t], changes: [{ before: t, after }], note })
  return after
}

/** Clear a task's date → back to the todo box (`edit --date none|clear`). Field shape mirrors the App's
 *  date-removed path exactly (EditPanel.setDate('none') → applyDate(0) → queueSave → store/todo.js
 *  updateTodoFields): todoTime=0 with derived dayStart=0, and the main reminder drops to 0 along with the
 *  date (the App's applyDate(0) zeroes remindTs; reminders are date-anchored — scheduleReminder gates on
 *  dayStart); reminderExtra rows are kept as-is, same as the App. Schedule chips cannot survive without a
 *  day to live on: same snapshot→clear cascade as the App's rowChipSync date-removed branch
 *  (snapshotForDelete + clearTaskChips = snapshot to meta, then planDeleteTask) — the snapshot stays in
 *  meta so a later `restore` can still backfill. Already-undated task → no-op ({changed:false}, nothing
 *  written, no audit entry). */
function clearTodoDate (input) {
  const t = resolveTask(input, liveTasks())
  if (!t.todoTime && !t.dayStart) return { task: t, changed: false }
  const patch = { todoTime: 0 }
  if (t.reminderTime) patch.reminderTime = 0 // same as the App: the main reminder cannot outlive its date
  const after = patchTodo(t.taskId, patch, { action: 'edit', note: 'date cleared → todo box' })
  chipsSnapshotForDelete(t.taskId)
  return { task: after, changed: true }
}

/**
 * Complete/undo complete (semantics aligned with store/todo.js toggleComplete):
 * - On complete, writes completedAt and, per isCompleteWithSubtasks (default on), also checks all subtasks
 * - When completing the latest instance in a repeat group (repeatId), renews per the meta 'repeatRule:<rid>' rule to generate the next instance
 */
function toggleComplete (input, target, { withSubtasks, completedAt } = {}) {
  const db = open()
  const t = resolveTask(input)
  // isCompleteWithSubtasks gate (default on) — same gate as the renderer's toggleComplete (store/todo.js);
  // an explicit caller override (--no-sub-cascade) wins over the setting
  const cascade = withSubtasks != null ? !!withSubtasks : settingsDoc().isCompleteWithSubtasks !== false
  if (!target) {
    // Undo unchecks all subtasks too (symmetric with the complete cascade): without this, the UI's
    // subsCompleteTarget would instantly re-complete a parent whose subs are all checked (same as store/todo.js)
    const undoPatch = { complete: false, completedAt: 0 }
    if (cascade) {
      try {
        const subs = JSON.parse(t.subtasks || '[]')
        if (Array.isArray(subs) && subs.length && subs.some(s => s.checked)) {
          undoPatch.subtasks = JSON.stringify(subs.map(s => ({ ...s, checked: false })))
        }
      } catch { /* skip the cascade when subtask JSON is malformed */ }
    }
    return patchTodo(t.taskId, undoPatch, { action: 'undo' })
  }
  const patch = core.completePatch(t, { withSubtasks: cascade, completedAt })
  const merged = { ...t, ...patch, updateTime: Date.now(), status: 'update' }
  db.call('upsert', merged)

  // Repeat-group renewal (the store's ensureNextRepeatInstance semantics)
  let renewed = null
  if (t.repeatId) {
    const rid = t.repeatId
    const group = db.call('queryTodos', { deleted: 0, repeatId: rid })
    let rule = null
    try { rule = JSON.parse(db.call('getMeta', 'repeatRule:' + rid) || 'null') } catch { /* no rule means no renewal */ }
    const next = core.nextRepeatInstance(merged, group, rule, require('../src/main/core/holidays.js').getHolidayList())
    if (next) {
      // Renewal-instance idempotency: skip when an instance with the same rid + same dayStart exists (prevents duplicate CLI runs + concurrent multi-window generation creating two)
      const existing = db.call('queryTodos', { deleted: 0, repeatId: rid, dayStartFrom: next.todoTime, dayStartTo: next.todoTime })
      if (Array.isArray(existing) && existing.length) {
        renewed = existing[0]
      } else {
        const now = Date.now()
        const sameDay = db.call('queryTodos', { deleted: 0 }).filter(x => x.dayStart === dayStartOf(next.todoTime))
        const sameSorts = sameDay.map(x => x.taskSort).filter(v => v != null)
        const taskSort = sameSorts.length ? Math.fround((Math.min(...sameSorts) + Math.max(...sameSorts)) / 2) : 0
        let subs = null
        try { subs = t.subtasks ? JSON.parse(t.subtasks) : null } catch { /* keep null */ }
        const nt = {
          complete: false, createTime: now, delete: false,
          reminderTime: next.reminderTime, reminderOffsets: next.reminderOffsets || [], reminderExtra: Array.isArray(next.reminderExtra) ? next.reminderExtra : [], estimate: 0, difficulty: t.difficulty || 0,
          priority: t.priority || 0, deadlineTs: t.deadlineTs || 0, important: t.important || 0, urgent: t.urgent || 0,
          repeatId: rid,
          subtasks: subs ? JSON.stringify(subs.map(s => ({ ...s, checked: false }))) : null,
          image: null, files: null,
          categoryId: t.categoryId,
          updateTime: now, syncTime: 0,
          taskContent: t.taskContent,
          taskDescribe: t.taskDescribe || '',
          taskId: core.genTaskId(t.userId, now),
          taskSort,
          todoTime: next.todoTime,
          userId: t.userId, status: 'add', version: 0
        }
        db.call('upsert', nt)
        renewed = db.call('getById', nt.taskId)
      }
    }
  }
  const completed = db.call('getById', t.taskId)
  audit.record({
    action: 'done',
    targets: [t],
    changes: [{ before: t, after: completed }, ...(renewed ? [{ before: null, after: renewed }] : [])],
    note: renewed ? 'repeat renewed → ' + renewed.taskId : undefined
  })
  return { completed, renewed }
}

/** Soft delete → recycle bin (deletedAt drives the 30-day auto hard-delete and recycle-bin ordering, aligned with the renderer) */
function deleteTodo (input) {
  const after = patchTodo(input, { delete: true, deletedAt: Date.now() }, { action: 'delete' })
  chipsSnapshotForDelete(after.taskId) // snapshot chips → meta before clearing rows: prevents orphan chips while keeping restore backfill capability
  return after
}

/** Snapshot all of a task's chips into meta (planChipsSnapshot:<taskId>) before clearing its rows */
function chipsSnapshotForDelete (taskId) {
  try {
    const rows = open().call('planAll', []).filter(r => r.taskId === taskId)
    if (rows.length) open().call('setMeta', ['planChipsSnapshot:' + taskId, JSON.stringify(rows)])
    open().call('planDeleteTask', taskId)
  } catch { /* snapshot failure must not block deletion */ }
}

/** Clear a task's schedule chips across all days (hardDelete/purge paths; db layer cascades inline — this is a defensive explicit call) */
function chipsRemoveTask (taskId) {
  try { open().call('planDeleteTask', taskId); return 1 } catch { return 0 }
}

/** Day-change chip migration (same semantics as the UI's moveTaskChips and the `edit --date` follow-up):
 *  existing chips keep their times and follow the task to the new day. Best-effort — never blocks the patch. */
function migrateChipsOnDayChange (taskId, oldDay, newDay) {
  if (!oldDay || !newDay || oldDay === newDay) return 0
  try {
    const ymd = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
    if (ymd(oldDay) === ymd(newDay)) return 0
    open().call('planMoveTask', { taskId, fromDay: ymd(oldDay), toDay: ymd(newDay) })
    return 1
  } catch { return 0 }
}

/** Restore a task: backfill the schedule chips snapshotted before deletion */
function chipsRestoreSnapshot (taskId) {
  try {
    const raw = open().call('getMeta', 'planChipsSnapshot:' + taskId)
    if (!raw) return 0
    const rows = JSON.parse(raw)
    if (Array.isArray(rows) && rows.length) open().call('planAddMany', rows)
    open().call('setMeta', ['planChipsSnapshot:' + taskId, ''])
    return rows.length
  } catch { return 0 }
}

/** Restore from the recycle bin */
function restoreTodo (input) {
  if (input) { try { chipsRestoreSnapshot(resolveTask(input, recycleTasks()).taskId) } catch { /* no snapshot = originally had no schedule */ } }
  const db = open()
  const t = resolveTask(input, recycleTasks())
  const merged = { ...t, delete: false, deletedAt: 0, updateTime: Date.now(), status: 'update' }
  db.call('upsert', merged)
  const after = db.call('getById', t.taskId)
  audit.record({ action: 'restore', targets: [t], changes: [{ before: t, after }] })
  return after
}

/** Permanently empty the recycle bin (dangerous; the entry layer is responsible for confirmation). Each row is recorded before clearing, preserving the only traceable deletion evidence */
function purgeRecycleBin () {
  const db = open()
  const rows = recycleTasks()
  // Delete attachment files BEFORE clearing rows (files/<taskId>_<ts>_<name>, same prefix rule as the
  // App's purgeAttachmentFiles in src/main/index.js): purging rows only once left private attachments on disk
  let filesRemoved = 0
  try {
    const dir = path.join(userDataDir(), 'files')
    const prefixes = rows.map(r => `${r.taskId}_`)
    for (const f of fs.readdirSync(dir)) {
      if (prefixes.some(p => f.startsWith(p))) {
        try { fs.unlinkSync(path.join(dir, f)); filesRemoved++ } catch { /* best-effort, never block the purge */ }
      }
    }
  } catch { /* no files dir is fine */ }
  db.call('purgeRecycleBin')
  audit.record({
    action: 'purge',
    changes: rows.map(r => ({ before: r })),
    note: `purged ${rows.length} item(s) (irreversible), ${filesRemoved} attachment file(s) removed`
  })
  return true
}

/* ================= Subtasks (subtasks JSON: [{text, checked}], structure aligned with EditPanel) ================= */
function parseSubs (t) {
  try { const a = JSON.parse(t.subtasks || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

/** Subtask resolution: 1-based index or unique text match */
function findSub (subs, key) {
  const s = String(key)
  if (/^\d+$/.test(s)) {
    const i = parseInt(s, 10) - 1
    if (i < 0 || i >= subs.length) throw new CliError(`subtask index out of range: ${key} (${subs.length} total)`, 'SUB_NOT_FOUND')
    return i
  }
  const kw = s.toLowerCase()
  const hits = subs.map((x, i) => (x.text || '').toLowerCase().includes(kw) ? i : -1).filter(i => i >= 0)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new CliError(`subtask keyword "${key}" matched ${hits.length}; use an index (get <task> --json to view subtasks)`, 'AMBIGUOUS_MATCH')
  throw new CliError(`subtask not found: "${key}"`, 'SUB_NOT_FOUND')
}

function mutateSubs (input, fn, { action = 'subtask', note } = {}) {
  const t = resolveTask(input)
  const subs = parseSubs(t)
  fn(subs)
  return patchTodo(t.taskId, { subtasks: JSON.stringify(subs) }, { action, note })
}

const addSubtask = (input, text) => {
  if (!text || !String(text).trim()) throw new CliError('subtask content required', 'EMPTY_CONTENT')
  return mutateSubs(input, subs => subs.push({ text: String(text).trim(), checked: false }), { note: 'subtask added: ' + String(text).trim() })
}
const checkSubtask = (input, key, checked = true) => mutateSubs(input, subs => { subs[findSub(subs, key)].checked = !!checked }, { note: (checked ? 'check' : 'uncheck') + ' subtask: ' + key })
const removeSubtask = (input, key) => mutateSubs(input, subs => subs.splice(findSub(subs, key), 1), { note: 'subtask removed: ' + key })

/** Environment self-check (modeled on remctl doctor): driver/DB file/read-write/scale */
function doctor () {
  const dir = userDataDir()
  const file = path.join(dir, 'todos.db')
  const checks = []
  // ok must stay strictly boolean: mixing true/'skipped'/'synced' made the top-level every() always truthy (string truthiness), so machine consumers could not tell;
  // 'skipped' (write probe skipped to protect real data) counts as passing, and the state field carries the raw status
  const add = (name, ok, detail) => checks.push({ check: name, ok: ok === true || ok === 'skipped', state: String(ok), detail: detail || '' })
  add('dataDir', fs.existsSync(dir), dir)
  add('dbFile', fs.existsSync(file), file)
  try {
    const db = open()
    const n = db.call('countAll')
    add('driver', true, 'better-sqlite3-multiple-ciphers (N-API prebuilt)')
    add('read', true, `${n} rows / recycle bin ${db.call('queryTodos', { deleted: 1 }).length} / categories ${db.call('getAllCategories').length}`)
    const ver = db.call('getMeta', 'todosVersion')
    add('meta', true, 'todosVersion ' + (ver != null ? 'synced' : 'local-only (db readable, no version stamp)'))
    add('write', 'skipped', 'write probe skipped to protect real data; only runs in TODO_DB_DIR isolated dir')
  } catch (e) {
    add('open', false, String(e.message || e))
  }
  return { dataDir: dir, ok: checks.every(c => c.ok), checks }
}

/** Launch/summon the Electron App: starts it when not running; when running, the single-instance lock brings the existing window to the front.
 *  Dev repo: spawn electron's cli.js against the project root.
 *  Packaged install: resources/cli has no node_modules — spawn the app exe at the install root instead. */
function launchApp ({ dev = false } = {}) {
  const root = path.join(__dirname, '..')
  const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js')
  if (fs.existsSync(electronCli)) {
    const child = spawn(process.execPath, [electronCli, '.', ...(dev ? ['--dev'] : [])], {
      cwd: root, detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOG_DUMP: '0' }
    })
    child.unref()
    return { pid: child.pid, dev }
  }
  // Packaged layout: __dirname = <install>\resources\cli → install root is two levels up
  const installRoot = path.dirname(path.dirname(__dirname))
  const exe = fs.readdirSync(installRoot).find(f => f.toLowerCase().endsWith('.exe') && fs.statSync(path.join(installRoot, f)).isFile())
  if (!exe) throw new CliError('app executable not found next to the install resources', 'NO_ELECTRON')
  const child = spawn(path.join(installRoot, exe), [], {
    cwd: installRoot, detached: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_ENABLE_LOG_DUMP: '0' }
  })
  child.unref()
  return { pid: child.pid, dev: false }
}

/* ---------------- Pomodoro command channel (CLI writes a meta command → the running App dispatches the existing tomato action → writes state back)
   State machine/idempotency/ledger all live in the App renderer's store/tomato.js; the CLI never writes pomodoro state in parallel. When the App is not running, status is marked pending. */
function writeTomatoCmd (cmd) {
  // Monotonically increasing sequence: the App drops stale commands via cmd.seq > lastTomatoSeq; two commands fired in the same millisecond via Date.now() would silently lose the second one
  // (common in scripted AI scenarios), so a persisted counter in meta is read-modify-written instead
  // Atomic increment (+1 inside SQL): two concurrent CLI processes writing the same seq would make the App's seq dedup silently drop the second command (audit H4)
  const seq = open().call('nextCliTomatoSeq')
  open().call('setMeta', ['cliTomatoCmd', JSON.stringify({ seq, at: Date.now(), ...cmd })])
  audit.record({ action: 'tomato.' + cmd.action, targets: cmd.taskId ? [{ taskId: cmd.taskId }] : [], changes: [], note: 'CLI tomato command (App executes and writes back cliTomatoState)' })
  return seq
}
function readTomatoState () {
  const raw = open().call('getMeta', 'cliTomatoState')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
/* Wait for the App's consumption receipt: cliTomatoState.seq catching up means executed. Returns null on timeout (App not running / locked).
   The HELP contract promises start errors when the App is not running — writing meta and reporting success once made scripts believe focus had begun */
async function waitForTomatoAck (seq, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = readTomatoState()
    if (st && st.seq >= seq) return st
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}
/** Live remaining seconds for status: remainSec is frozen at the last command time; during focus it is derived from startedAt; state not written back for over 5s is marked stale */
function tomatoLiveRemainSec (st) {
  if (!st) return 0
  if (st.status === 'startTomatoTime' && st.startedAt) {
    return Math.max(0, Math.round(st.tomatoTime * 60 - (Date.now() - st.startedAt) / 1000))
  }
  if (st.status === 'startRestTime' && st.startedAt) {
    return Math.max(0, Math.round((st.remainSec || 0) - (Date.now() - st.at) / 1000))
  }
  return st.remainSec || 0
}

/* ---------------- Repeat rules (meta repeatRule:<rid>; generation reuses the todo-core engine) ---------------- */
function buildRepeatRule (opts) {
  const rule = Object.assign({}, core.REPEAT_DEFAULTS)
  const type = opts.type || 'daily'
  const interval = Math.max(1, parseInt(opts.interval, 10) || 1)
  // count: 0 = unspecified → keep the engine defaults (day 90 / week 52 / month 24 / year 5, same as the renderer's RepeatModal form);
  // the old Math.max(1, …) coerced an absent --count to repeatDayCount=1, so `repeat on --type daily` generated ZERO future instances
  const count = parseInt(opts.count, 10) || 0
  if (type === 'daily') { rule.repeatType = 'day'; rule.repeatInterval = interval; if (count) rule.repeatDayCount = count }
  else if (type === 'weekly') {
    rule.repeatType = 'week'; rule.repeatInterval = 1
    if (opts.weekdays) rule.repeatWeekDays = String(opts.weekdays).split(/[,，]/).map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7)
    if (count) rule.repeatWeekCount = count
  } else if (type === 'monthly') {
    rule.repeatType = 'month'; rule.repeatInterval = interval
    if (opts.monthday) rule.repeatMonthDays = [parseInt(opts.monthday, 10) || 1]
    if (count) rule.repeatMonthCount = count
  } else if (type === 'yearly') {
    rule.repeatType = 'year'; rule.repeatInterval = interval
    if (count) rule.repeatYearCount = count
  } else throw new CliError('--type accepts daily|weekly|monthly|yearly', 'USAGE')
  if (opts['skip-weekends'] != null) rule.skipWeekends = true
  if (opts['skip-holidays'] != null) rule.skipStatutoryHolidays = true
  return rule
}
function repeatOn (input, rule, count) {
  const db = open()
  const t = resolveTask(input, liveTasks())
  if (t.complete) throw new CliError('task already completed; undo it before setting a repeat', 'INVALID_STATE')
  if (t.repeatId && String(t.repeatId).startsWith('repeat_')) throw new CliError('task already in a repeat group (' + t.repeatId + '); repeat off first, then re-set', 'ALREADY_REPEAT')
  const rid = 'repeat_' + t.userId + Date.now().toString(36) + Math.floor(Math.random() * 1e4)
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify(rule)])
  db.call('upsert', Object.assign({}, t, { repeatId: rid, updateTime: Date.now(), status: 'update' }))
  // Generate subsequent instances (the first day is the current task itself), reusing the todo-core engine's expansion
  const base = t.todoTime || t.dayStart || +dayjs().startOf('day')
  // Generation cap: explicit --count wins; otherwise the App's maxRepeat setting (default 2), same as RepeatModal
  const cap = count > 0 ? count : (parseInt(settingsDoc().maxRepeat, 10) || 2)
  // Template reminder keeps its wall-clock time on each instance (dayjs(ts).hour().minute() re-derive per instance,
  // same as RepeatModal) — copying the raw timestamp made reminders fire on the template's original date
  const tplRem = t.reminderTime > 0 ? dayjs(t.reminderTime) : null
  let made = 0
  for (const ts of core.expandRepeatDates(base, rule).map(d => +d).filter(ts => ts > base).slice(0, cap)) {
    const sameDay = db.call('queryTodos', { deleted: 0 }).filter(x => x.dayStart === dayStartOf(ts))
    const sorts = sameDay.map(x => x.taskSort).filter(v => v != null)
    const taskSort = sorts.length ? Math.fround((Math.min(...sorts) + Math.max(...sorts)) / 2) : 0
    let subs = null
    try { subs = t.subtasks ? JSON.parse(t.subtasks) : null } catch { /* keep null */ }
    const now = Date.now()
    db.call('upsert', {
      complete: false, createTime: now, delete: false,
      reminderTime: tplRem ? +dayjs(ts).hour(tplRem.hour()).minute(tplRem.minute()).second(0).millisecond(0) : 0,
      reminderOffsets: Array.isArray(t.reminderOffsets) ? t.reminderOffsets : [], reminderExtra: Array.isArray(t.reminderExtra) ? t.reminderExtra : [],
      priority: t.priority || 0, deadlineTs: t.deadlineTs || 0, important: t.important || 0, urgent: t.urgent || 0,
      estimate: 0, difficulty: t.difficulty || 0,
      repeatId: rid, subtasks: subs ? JSON.stringify(subs.map(x => ({ ...x, checked: false }))) : null,
      image: null, files: null, categoryId: t.categoryId,
      updateTime: now, syncTime: 0, taskContent: t.taskContent, taskDescribe: t.taskDescribe || '',
      taskId: core.genTaskId(t.userId, now), taskSort, todoTime: ts, userId: t.userId, status: 'add', version: 0
    })
    made++
  }
  audit.record({ action: 'repeat.on', targets: [t], changes: [{ after: { rid, rule, made } }], note: 'repeat set, ' + made + ' future instance(s) generated' })
  return { rid, made, task: t }
}
/* Repeat-group entry resolution: group instances share a name (same content, same date, different days), so AMBIGUOUS is meaningless for group ops — when several hits share a group, pick any one */
function resolveRepeatEntry (input) {
  const list = liveTasks()
  const byId = list.find(t => t.taskId === input)
  if (byId) return byId
  const norm = v => String(v).toLowerCase().replace(/[\s\u00A0\u3000\u200B\u2003]/g, '')
  const kw = norm(input)
  const hits = list.filter(t => norm(t.taskContent || '').includes(kw) && String(t.repeatId || '').startsWith('repeat_'))
  if (hits.length) return hits[0]
  return resolveTask(input, list)
}
function repeatOff (input, all) {
  const t = resolveRepeatEntry(input)
  const rid = t.repeatId
  if (!rid || !String(rid).startsWith('repeat_')) throw new CliError('task is not in a repeat group', 'NOT_REPEAT')
  let removed = 0
  if (all) {
    const now = Date.now()
    for (const x of open().call('queryTodos', { deleted: 0 })) {
      if (x.repeatId === rid && x.taskId !== t.taskId && !x.complete) {
        open().call('upsert', Object.assign({}, x, { delete: 1, deletedAt: now, updateTime: now, status: 'delete' }))
        chipsSnapshotForDelete(x.taskId) // same snapshot→clear cascade as deleteTodo: soft-deleted instances must not leave orphan chips
        removed++
      }
    }
    open().call('setMeta', ['repeatRule:' + rid, ''])
  }
  open().call('upsert', Object.assign({}, t, { repeatId: null, updateTime: Date.now(), status: 'update' }))
  audit.record({ action: 'repeat.off', targets: [t], changes: [{ before: { rid } }], note: all ? 'repeat group dissolved (soft-deleted ' + removed + ' future instance(s))' : 'left repeat group (this instance only)' })
  return { rid, removed }
}
function repeatRuleInfo (input) {
  const t = resolveRepeatEntry(input)
  const rid = t.repeatId
  if (!rid || !String(rid).startsWith('repeat_')) return { taskId: t.taskId, repeat: false }
  let rule = null
  try { rule = JSON.parse(open().call('getMeta', 'repeatRule:' + rid) || 'null') } catch { rule = null }
  return { taskId: t.taskId, repeat: true, rid, rule }
}

/* ---------------- Categories write (same SQLite categories table as the UI; camelCase row mapping mirrors store/category.js toRow) ---------------- */
const CAT_COLORS = ['#0f9d8f', '#f76e6e', '#f2a63b', '#7ac74f', '#5aa9e6', '#9d8df1', '#eb96c3', '#98a4ae']
function catToRow (c) {
  return {
    id: c.categoryId, userId: c.userId != null ? c.userId : 840001,
    name: c.categoryName, color: c.categoryColor || null,
    createdAt: c.createTime || 0, sort: c.listSort || 0,
    isFolder: c.folderIs ? 1 : 0, parentId: c.folderId || 0, deleted: c.delete ? 1 : 0
  }
}
function addCategory (name, { color, parent, folder } = {}) {
  const db = open()
  const cats = db.call('getAllCategories')
  if (cats.some(c => c.categoryName === name)) throw new CliError('category "' + name + '" already exists (names must stay unique so the CLI can address them)', 'CATEGORY_EXISTS')
  let parentId = 0
  if (parent != null && parent !== true) {
    // resolveCategory returns the bare id — look the row back up before the folder check
    // (was: p.folderIs on a number, always undefined → `category add --parent` rejected every parent)
    const pid = resolveCategory(parent)
    const p = cats.find(c => c.categoryId === pid)
    if (!p || !p.folderIs) throw new CliError('parent "' + parent + '" is not a folder', 'CATEGORY_NOT_FOLDER')
    parentId = pid
  }
  const cat = {
    categoryId: Date.now() * 1000 + Math.floor(Math.random() * 1000), userId: 840001,
    categoryName: String(name), categoryColor: color && CAT_COLORS.includes(color) ? color : CAT_COLORS[cats.length % CAT_COLORS.length],
    createTime: Date.now(), listSort: Math.max(0, ...cats.map(c => c.listSort)) + 100,
    folderIs: !!folder, folderId: parentId, delete: false
  }
  db.call('upsertCategory', catToRow(cat))
  audit.record({ action: 'category.add', targets: [], changes: [{ after: { name, id: cat.categoryId } }], note: (folder ? 'folder' : 'category') + ' created' })
  return cat
}
function renameCategory (input, nextName) {
  const db = open()
  const id = resolveCategory(input)
  const cat = db.call('getAllCategories').find(c => c.categoryId === id)
  if (db.call('getAllCategories').some(c => c.categoryId !== id && c.categoryName === nextName)) throw new CliError('category "' + nextName + '" already exists', 'CATEGORY_EXISTS')
  const updated = Object.assign({}, cat, { categoryName: nextName })
  db.call('upsertCategory', catToRow(updated))
  audit.record({ action: 'category.rename', targets: [], changes: [{ before: { name: cat.categoryName }, after: { name: nextName } }], note: 'category renamed' })
  return updated
}
/** Soft delete (same as UI: delete flag + cascade to children; tasks keep categoryId and fall back to the default (uncategorized) in views). Project flag/deadline meta cleaned here. */
function deleteCategory (input) {
  const db = open()
  const id = resolveCategory(input)
  const all = db.call('getAllCategories')
  const cat = all.find(c => c.categoryId === id)
  const victims = [cat]
  if (cat.folderIs) {
    const mark = pid => { all.filter(c => c.folderId === pid).forEach(c => { victims.push(c); if (c.folderIs) mark(c.categoryId) }) }
    mark(id)
  }
  for (const c of victims) db.call('upsertCategory', catToRow(Object.assign({}, c, { delete: true })))
  // A deleted category must not linger as a project (UI comment: the caller removes the flag first when a category is deleted)
  const ids = getProjectIds().filter(x => !victims.some(v => v.categoryId === x))
  if (ids.length !== getProjectIds().length) db.call('setMeta', [PROJECT_IDS_KEY, JSON.stringify(ids)])
  for (const v of victims) { try { db.call('deleteMeta', 'projectDeadline:' + v.categoryId) } catch { /* absent is fine */ } }
  audit.record({ action: 'category.delete', targets: [], changes: [{ before: { names: victims.map(v => v.categoryName) } }], note: 'category soft-deleted (recoverable in UI), tasks kept' })
  return { deleted: victims.map(v => ({ id: v.categoryId, name: v.categoryName })) }
}

/** Move a category under a folder or back to root ('root'). Parity note: the App's hierarchy getter
 *  (renderer/js/store/category.js `hierarchical`) renders folders as roots and only nests non-folder
 *  children — a nested folder would be silently dropped from the sidebar — so folder→folder moves are rejected. */
function moveCategory (input, parentInput) {
  const db = open()
  const id = resolveCategory(input)
  const all = db.call('getAllCategories')
  const cat = all.find(c => c.categoryId === id)
  if (!cat) throw new CliError(`category not found: "${input}"`, 'CATEGORY_NOT_FOUND')
  const raw = String(parentInput == null ? '' : parentInput).trim().toLowerCase()
  let parentId = 0
  let parent = null
  if (raw && raw !== 'root' && raw !== 'none') {
    const pid = resolveCategory(parentInput)
    if (pid === id) throw new CliError('cannot move a category under itself', 'CATEGORY_CYCLE')
    parent = all.find(c => c.categoryId === pid)
    if (!parent) throw new CliError(`category not found: "${parentInput}"`, 'CATEGORY_NOT_FOUND')
    // Cycle guard first (more specific error): walk up from the parent; landing on the moved category closes a loop
    let cur = parent
    const seen = new Set()
    while (cur && cur.folderId && !seen.has(cur.categoryId)) {
      seen.add(cur.categoryId)
      if (cur.folderId === id) throw new CliError(`cannot move "${cat.categoryName}" into its own descendant (cycle)`, 'CATEGORY_CYCLE')
      cur = all.find(c => c.categoryId === cur.folderId)
    }
    if (!parent.folderIs) throw new CliError(`"${parent.categoryName}" is not a folder — the App only nests categories inside folders`, 'CATEGORY_NOT_FOLDER')
    if (cat.folderIs) throw new CliError(`"${cat.categoryName}" is a folder: the App renders folders as roots only (nested folders are dropped from the sidebar), so folder→folder moves are rejected`, 'CATEGORY_NESTED_FOLDER')
    parentId = pid
  }
  db.call('upsertCategory', catToRow(Object.assign({}, cat, { folderId: parentId })))
  audit.record({
    action: 'category.move',
    targets: [{ taskId: 'cat:' + id, content: cat.categoryName }],
    changes: [{ before: { parent: cat.folderId }, after: { parent: parentId } }],
    note: parent ? 'moved under folder "' + parent.categoryName + '"' : 'moved to root'
  })
  return { categoryId: id, name: cat.categoryName, folderId: parentId, parentName: parent ? parent.categoryName : null }
}

/** Flat rows for `categories --json`: getAllCategories rows (order unchanged) + additive parentName */
function categoryRows () {
  const cats = open().call('getAllCategories')
  const byId = new Map(cats.map(c => [c.categoryId, c]))
  return cats.map(c => ({
    ...c,
    folderIs: !!c.folderIs,
    parentName: c.folderId && byId.get(c.folderId) ? byId.get(c.folderId).categoryName : null
  }))
}

/** Display order for the `categories` text listing: folders are roots with their children indented under
 *  them (mirrors the App's `hierarchical` getter); orphans render at root level rather than vanishing. */
function categoryHierarchy () {
  const cats = categoryRows()
  const out = []
  const printed = new Set()
  for (const c of cats) {
    if (c.folderIs) {
      out.push({ row: c, depth: 0 })
      printed.add(c.categoryId)
      for (const ch of cats.filter(x => !x.folderIs && x.folderId === c.categoryId)) {
        out.push({ row: ch, depth: 1 })
        printed.add(ch.categoryId)
      }
    }
  }
  for (const c of cats) if (!printed.has(c.categoryId)) out.push({ row: c, depth: 0 })
  return out
}

/* ---------------- Tags (derived from #tag in content/description; rename/remove rewrite text across tasks — same regex semantics as SideNav) ---------------- */
// Character-for-character identical to renderer/js/utils/search.js TAG_RE (tags are derived from body text, no separate storage)
const TAG_RE = /#([^\s#,，。.!?！？]+)/g
function extractTagsCli (...texts) {
  const set = new Set()
  texts.forEach(t => {
    if (!t) return
    let m; TAG_RE.lastIndex = 0
    while ((m = TAG_RE.exec(String(t)))) set.add(m[1])
  })
  return [...set]
}
function tagEsc (name) { return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function listTags () {
  const count = {}
  for (const t of liveTasks()) {
    for (const name of extractTagsCli(t.taskContent, t.taskDescribe)) count[name] = (count[name] || 0) + 1
  }
  return Object.entries(count).map(([name, tasks]) => ({ name, tasks })).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name))
}
function rewriteTag (name, next, { remove } = {}) {
  const esc = tagEsc(name)
  // rename: #old(?=\s|$) → #new ; remove: leading whitespace swallowed too (\s*#old(?=\s|$) → '')
  const re = remove ? new RegExp('\\s*#' + esc + '(?=\\s|$)', 'g') : new RegExp('#' + esc + '(?=\\s|$)', 'g')
  let touched = 0
  for (const todo of liveTasks()) {
    const patch = {}
    if (todo.taskContent) {
      const v = remove ? todo.taskContent.replace(re, '').trim() : todo.taskContent.replace(re, '#' + next)
      if (v !== todo.taskContent) patch.taskContent = v
    }
    if (todo.taskDescribe) {
      const v = remove ? todo.taskDescribe.replace(re, '').trim() : todo.taskDescribe.replace(re, '#' + next)
      if (v !== todo.taskDescribe) patch.taskDescribe = v
    }
    if (Object.keys(patch).length) { patchTodo(todo.taskId, patch, { action: 'tag.' + (remove ? 'remove' : 'rename') }); touched++ }
  }
  return touched
}

/* ---------------- Batch operations (explicit taskIds only — no keyword matching; per-task failures never abort the run) ---------------- */
/** Exact-id resolution for batch: batch is explicit by design, so the keyword/ambiguity path of resolveTask is deliberately absent */
function resolveTaskExact (id, pool) {
  const t = (pool || liveTasks()).find(x => x.taskId === String(id))
  if (!t) throw new CliError(`task not found: "${id}" (batch takes exact taskIds only, no keyword matching)`, 'TASK_NOT_FOUND')
  return t
}

/** Add/remove one #tag on a single task — same title/description rewrite path as `tag rename`/`tag rm`
 *  (TAG_RE boundary regex); add appends " #name" to the title like the App's EditPanel.addTag. */
function batchTagOne (t, name, remove) {
  const esc = tagEsc(name)
  if (remove) {
    const re = new RegExp('\\s*#' + esc + '(?=\\s|$)', 'g')
    const patch = {}
    if (t.taskContent) { const v = t.taskContent.replace(re, '').trim(); if (v !== t.taskContent) patch.taskContent = v }
    if (t.taskDescribe) { const v = t.taskDescribe.replace(re, '').trim(); if (v !== t.taskDescribe) patch.taskDescribe = v }
    if (!Object.keys(patch).length) throw new CliError(`tag #${name} not present on this task`, 'TAG_NOT_PRESENT')
    return patchTodo(t.taskId, patch, { action: 'tag.remove' })
  }
  if (new RegExp('#' + esc + '(?=\\s|$)').test(t.taskContent || '')) throw new CliError(`tag #${name} already on this task`, 'TAG_PRESENT')
  return patchTodo(t.taskId, { taskContent: (t.taskContent || '').replace(/\s+$/, '') + ' #' + name }, { action: 'tag.add' })
}

/**
 * Run a batch op over explicit taskIds. Returns { op, matched, changed, failures, outcomes } where
 * outcomes carries the per-task line info for text rendering; failures never abort the remaining tasks.
 * Audit: one entry per task change (inherent — every op routes through patchTodo/toggleComplete).
 */
function batchRun (op, ids, { to, add, rm, dryRun } = {}) {
  const entries = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean)
  if (!entries.length) throw new CliError(`batch ${op} needs at least one taskId`, 'USAGE')
  let toTs = null
  let catId = null
  let tagName = null
  let removing = false
  if (op === 'date') {
    if (!to || to === true) throw new CliError('batch date needs --to <today|tomorrow|+Nd|YYYY-MM-DD[ HH:mm]>', 'USAGE')
    toTs = parseDate(to) // same parser as `edit --date`; throws on bad input before anything is written
  } else if (op === 'category') {
    if (!to || to === true) throw new CliError('batch category needs --to <name|id>', 'USAGE')
    catId = resolveCategory(to)
  } else if (op === 'tag') {
    const hasAdd = add != null && add !== true
    const hasRm = rm != null && rm !== true
    if (hasAdd === hasRm) throw new CliError('batch tag needs exactly one of --add <tag> | --rm <tag>', 'USAGE')
    tagName = String(hasAdd ? add : rm).replace(/^#/, '')
    if (!tagName) throw new CliError('tag name required (--add <tag> | --rm <tag>)', 'USAGE')
    removing = hasRm
  } else if (op !== 'done') {
    throw new CliError(`unknown batch op "${op}" (valid: done/date/category/tag)`, 'USAGE')
  }
  const pool = liveTasks()
  const describe = t => op === 'done' ? `complete "${t.taskContent}" (subtask cascade / repeat renewal apply)`
    : op === 'date' ? `reschedule "${t.taskContent}" → ${to}`
      : op === 'category' ? `recategorize "${t.taskContent}" → ${to}`
        : `${removing ? 'remove' : 'add'} #${tagName} ${removing ? 'on' : 'to'} "${t.taskContent}"`
  const exec = {
    done: t => toggleComplete(t.taskId, true),
    date: t => {
      const after = patchTodo(t.taskId, { todoTime: toTs }, { action: 'edit' })
      migrateChipsOnDayChange(t.taskId, t.dayStart, after.dayStart)
      return after
    },
    category: t => patchTodo(t.taskId, { categoryId: catId }, { action: 'edit' }),
    tag: t => batchTagOne(t, tagName, removing)
  }
  const failures = []
  const outcomes = []
  let changed = 0
  for (const id of entries) {
    let t = null
    try { t = resolveTaskExact(id, pool) } catch (e) {
      failures.push({ taskId: id, error: e.message })
      outcomes.push({ taskId: id, ok: false, error: e.message })
      continue
    }
    if (dryRun) { outcomes.push({ taskId: t.taskId, ok: true, dryRun: true, label: describe(t) }); continue }
    try {
      exec[op](t)
      changed++
      outcomes.push({ taskId: t.taskId, ok: true, label: describe(t) })
    } catch (e) {
      failures.push({ taskId: t.taskId, error: String(e.message || e) })
      outcomes.push({ taskId: t.taskId, ok: false, error: String(e.message || e) })
    }
  }
  if (dryRun) return { op, matched: entries.length, dryRun: true, plan: outcomes.filter(o => o.ok), failures, outcomes }
  return { op, matched: entries.length, changed, failures, outcomes }
}

/* ---------------- Saved views (smart lists): the same SQLite `filters` table the App's FilterModal writes / FilterView consumes ----------------
   conds contract is pinned by db.js normConds (both ends' read path): { catId: -1|categoryId, priority: -1|N, dateMode: 'all'|'today'|'week'|'overdue'|'none' }
   with -1/'all' = condition off. Any other key would be stripped on read, so the CLI maps flags onto exactly this shape. */
function viewsList () { return open().call('filterList') }

function resolveView (input) {
  const rows = viewsList()
  const byId = rows.find(v => String(v.id) === String(input))
  if (byId) return byId
  const hits = rows.filter(v => v.name === input)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new CliError(`view "${input}" is ambiguous (${hits.length} saved views share this name); use the view id (view list --json)`, 'AMBIGUOUS_MATCH')
  throw new CliError(`view not found: "${input}" (view list to browse)`, 'VIEW_NOT_FOUND')
}

/** English one-line conds summary (the same conditions the App's FilterView header shows) */
function viewCondsSummary (conds) {
  const c = conds || {}
  const parts = []
  if (c.catId != null && c.catId !== -1) {
    const cat = open().call('getAllCategories').find(x => x.categoryId === c.catId)
    parts.push(cat ? 'cat:' + cat.categoryName : 'cat #' + c.catId)
  }
  if (c.priority != null && c.priority !== -1) parts.push('priority ' + c.priority)
  if (c.dateMode && c.dateMode !== 'all') parts.push(c.dateMode)
  return parts.join(' · ') || 'all undone tasks'
}

/** Create a saved view from CLI flags (duplicate names rejected). The conds shape always carries all
 *  three keys — that IS the renderer's parseConds output shape (-1/'all' = off). */
function viewAdd (name, { category, priority, overdue, nodate } = {}) {
  const clean = String(name || '').trim()
  if (!clean) throw new CliError('view add needs a name', 'USAGE')
  if (viewsList().some(v => v.name === clean)) throw new CliError(`view "${clean}" already exists (view list to browse)`, 'VIEW_EXISTS')
  const conds = { catId: -1, priority: -1, dateMode: 'all' }
  if (category != null && category !== true) conds.catId = resolveCategory(category)
  if (priority != null && priority !== true) {
    const p = parseInt(priority, 10)
    if (!(p >= 0 && p <= 3) || String(p) !== String(priority).trim()) throw new CliError('--priority accepts 0-3 (got "' + priority + '")', 'USAGE')
    conds.priority = p
  }
  const modes = [overdue ? 'overdue' : null, nodate ? 'none' : null].filter(Boolean)
  if (modes.length > 1) throw new CliError('--overdue and --nodate are mutually exclusive (both set the date condition)', 'USAGE')
  if (modes.length) conds.dateMode = modes[0]
  const id = open().call('filterUpsert', { name: clean, conds, sort: 0 })
  audit.record({ action: 'view.add', targets: [], changes: [{ after: { id, name: clean, conds } }], note: 'saved view created (same filters table as the App smart lists)' })
  return { id, name: clean, conds, sort: 0 }
}

/** Remove a saved view by name or id */
function viewRm (input) {
  const v = resolveView(input)
  open().call('filterDelete', v.id)
  audit.record({ action: 'view.rm', targets: [], changes: [{ before: { id: v.id, name: v.name, conds: v.conds } }], note: 'saved view removed' })
  return { id: v.id, name: v.name }
}

/** Apply a saved view's conds to a task pool — mirrors renderer FilterView.list exactly:
 *  undone only, catId/priority equality (-1 = off), dateMode today/isoWeek/overdue/none windows. */
function applyViewConds (conds, tasks) {
  const c = conds || {}
  const today0 = +dayjs().startOf('day')
  const weekEnd = +dayjs().endOf('isoWeek') // isoWeek plugin is extended by todo-core (shared dayjs instance)
  return tasks.filter(t => {
    if (t.delete || t.complete) return false
    if (c.catId != null && c.catId !== -1 && (t.categoryId || 0) !== c.catId) return false
    if (c.priority != null && c.priority !== -1 && (t.priority || 0) !== c.priority) return false
    if (c.dateMode && c.dateMode !== 'all') {
      const d = t.dayStart || 0
      if (c.dateMode === 'today' && d !== today0) return false
      if (c.dateMode === 'week' && !(d >= today0 && d <= weekEnd)) return false
      if (c.dateMode === 'overdue' && !(d && d < today0)) return false
      if (c.dateMode === 'none' && d !== 0) return false
    }
    return true
  })
}

/** listTodos fetch options for a saved view: push the view's dateMode/category down into the QUERY so the
 *  row cap (500) can no longer truncate away matching tasks before applyViewConds runs (review P1 2026-09-10:
 *  a 200-cap fetch filtered afterwards hid valid rows for >cap libraries). applyViewConds stays as the
 *  authoritative post-filter so the semantics remain byte-identical to the app's FilterView. */
function viewFetchOpts (conds) {
  const c = conds || {}
  const mode = c.dateMode
  return {
    range: mode === 'today' || mode === 'week' || mode === 'overdue' ? mode : null,
    noDate: mode === 'none',
    done: false, // views are undone-only (FilterView parity, same as applyViewConds)
    category: c.catId != null && c.catId !== -1 ? c.catId : null,
    limit: 500 // fetch max; user --limit narrows AFTER applyViewConds
  }
}

/* ---------------- Focus ledger (唯一事实源 = SQLite tomato_records 行表,同统计页/时间轴;CLI 直连 DB,无需 App 运行) ---------------- */
function tomatoRecords () {
  try {
    const rows = open().call('tomatoAll')
    return Array.isArray(rows) ? rows : []
  } catch { return [] }
}

/** Backfill one manual focus record: CLI 直写账本行(不再经 App 命令通道,App 关闭也可用)。
 *  tomatoId 与渲染端手动补录同形(幂等:重复导入同槽位不产生第二条)。 */
function backfillRecord ({ taskId = null, content = '', date, at = '20:00', minutes = 25 }) {
  // 600 = the DB-layer clamp (db.js _recToRow): silently truncating 720 to 240/600 reported success while a different duration landed
  const raw = parseInt(minutes, 10) || 25
  if (raw > 600) throw new CliError('backfill duration max is 600 minutes (DB-layer clamp); got ' + raw, 'USAGE')
  const min = Math.max(1, raw)
  const base = dayjs(date)
  if (!base || !base.isValid()) throw new CliError('bad backfill date: ' + date, 'USAGE')
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at))
  if (!m) throw new CliError('--at accepts HH:mm', 'USAGE')
  const endAt = base.hour(+m[1]).minute(+m[2]).second(0).millisecond(0)
  const endTime = endAt.valueOf()
  const startTs = endTime - min * 60000
  const rec = {
    tomatoId: 'tmt_m_' + startTs + '_' + min + '_' + String(taskId || 'free').slice(-8),
    endTime, dateKey: endAt.format('YYYY-MM-DD'),
    focus: content || '', focusTaskId: taskId || null,
    focusDuration: min, rest: 0, restDuration: 0,
    succeed: true, status: 'local', manual: true
  }
  open().call('tomatoAppendMany', rec)
  audit.record({ action: 'tomato.backfill', targets: taskId ? [{ taskId }] : [], changes: [], note: 'CLI backfill ' + min + 'min @ ' + rec.dateKey + ' ' + at + ' (ledger row direct)' })
  return rec
}

/* ---------------- Tomato estimate per task (meta tomatoEstimateState, taskId→0-20; same key as renderer utils/tomatoEstimate.js) ---------------- */
function setEstimate (input, n) {
  const t = resolveTask(input, liveTasks())
  const v = Math.max(0, Math.min(20, Math.round(Number(n) || 0)))
  let map = {}
  try { map = JSON.parse(open().call('getMeta', 'tomatoEstimateState') || '{}') } catch { /* corrupt → rebuild */ }
  if (v > 0) map[t.taskId] = v
  else delete map[t.taskId]
  // Timestamp convention mirrors the renderer's tomatoEstimate/initFromDb: when meta is newer it takes over LS at startup (otherwise CLI writes get clobbered by the UI's stale LS)
  open().call('setMeta', ['tomatoEstimateState', JSON.stringify(map)])
  open().call('setMeta', ['tomatoEstimateStateAt', String(Date.now())])
  audit.record({ action: 'edit', targets: [t], changes: [{ before: { tomatoEstimate: getEstimateOf(t.taskId, map) }, after: { tomatoEstimate: v || null } }], note: 'tomato estimate set to ' + (v || '(none)') })
  return { taskId: t.taskId, content: t.taskContent, tomatoEstimate: v }
}
function getEstimateOf (taskId, map) {
  try { const m = map || JSON.parse(open().call('getMeta', 'tomatoEstimateState') || '{}'); return m[taskId] || 0 } catch { return 0 }
}

/* ---------------- Manual ordering (taskSort midpoint insertion — same semantics as renderer todo/reorderTodos drag) ---------------- */
/** Reorder <task> relative to: top|bottom|up|down (within its day) or before|after <otherTask> (must share the day/no-date pool) */
function sortTask (input, pos, refInput) {
  const t = resolveTask(input, liveTasks())
  const pool = liveTasks().filter(x => x.dayStart === t.dayStart).sort((a, b) => (a.taskSort || 0) - (b.taskSort || 0))
  const idx = pool.findIndex(x => x.taskId === t.taskId)
  const mid = (a, b) => Math.fround((a + b) / 2)
  let newSort
  if (pos === 'top') newSort = (pool.length ? pool[0].taskSort || 0 : 0) - 100
  else if (pos === 'bottom') newSort = (pool.length ? pool[pool.length - 1].taskSort || 0 : 0) + 100
  else if (pos === 'up' || pos === 'down') {
    const neighbor = pos === 'up' ? pool[idx - 1] : pool[idx + 1]
    if (!neighbor) throw new CliError('task is already at the ' + (pos === 'up' ? 'top' : 'bottom') + ' of its list', 'ALREADY_AT_EDGE')
    const beyond = pos === 'up' ? pool[idx - 2] : pool[idx + 2]
    newSort = beyond ? mid(neighbor.taskSort || 0, beyond.taskSort || 0) : (pos === 'up' ? (neighbor.taskSort || 0) - 100 : (neighbor.taskSort || 0) + 100)
  } else if (pos === 'before' || pos === 'after') {
    if (!refInput) throw new CliError('sort before|after needs a reference task', 'USAGE')
    const ref = resolveTask(refInput, liveTasks())
    if (ref.dayStart !== t.dayStart) throw new CliError('reference task must be on the same day (or both without a date) — change date first with edit --date', 'CROSS_DAY_SORT')
    const ridx = pool.findIndex(x => x.taskId === ref.taskId)
    if (pos === 'before') {
      const beyond = ridx > 0 ? pool[ridx - 1] : null
      newSort = beyond ? mid(beyond.taskSort || 0, ref.taskSort || 0) : (ref.taskSort || 0) - 100
    } else {
      const beyond = ridx < pool.length - 1 ? pool[ridx + 1] : null
      newSort = beyond ? mid(ref.taskSort || 0, beyond.taskSort || 0) : (ref.taskSort || 0) + 100
    }
  } else throw new CliError('position must be top|up|down|bottom, or before|after <task>', 'USAGE')
  patchTodo(t.taskId, { taskSort: newSort }, { action: 'sort' })
  // Re-read the real persisted order (cannot reuse the pool above — it is a pre-move snapshot; the ★ marker would show at the old position)
  const after = liveTasks()
    .filter(x => x.dayStart === t.dayStart)
    .sort((a, b) => (a.taskSort || 0) - (b.taskSort || 0))
    .map(x => (x.taskId === t.taskId ? '★' : '') + x.taskContent)
  return { taskId: t.taskId, taskSort: newSort, dayOrder: after }
}

/** All live tasks scheduled on a given date (with times) — the "what should I slot at 11am tomorrow" view */
function listOn (date) {
  const day = dayStartOf(parseDate(date))
  if (!day) throw new CliError('a date is required (today/tomorrow/YYYY-MM-DD)', 'USAGE')
  return liveTasks()
    .filter(t => t.dayStart === day)
    .sort((a, b) => (a.todoTime || a.dayStart) - (b.todoTime || b.dayStart) || (a.taskSort || 0) - (b.taskSort || 0))
    .map(t => ({ taskId: t.taskId, content: t.taskContent, time: t.todoTime ? dayjs(t.todoTime).format('HH:mm') : null, complete: t.complete, tomatoEstimate: getEstimateOf(t.taskId) }))
}

/** Resolve a focus record by full tomatoId or unique prefix (tomatoIds are long; prefix is the human/AI-friendly handle) */
function resolveRecord (ref) {
  const recs = tomatoRecords().filter(Boolean)
  const exact = recs.find(r => r.tomatoId === ref)
  if (exact) return exact
  const hits = recs.filter(r => r.tomatoId && String(r.tomatoId).startsWith(ref))
  if (!hits.length) throw new CliError('no focus record matches "' + ref + '" — tomato list to browse ids', 'RECORD_NOT_FOUND')
  if (hits.length > 1) {
    const preview = hits.slice(0, 10).map(r => `  - ${r.tomatoId}  ${r.dateKey} ${r.focusDuration}min ${r.focus || '(free)'}`).join('\n')
    throw new CliError(`"${ref}" matched ${hits.length} records; use a longer prefix:\n${preview}`, 'AMBIGUOUS_MATCH')
  }
  return hits[0]
}

/** Fix an existing focus record (wrong duration/time/task). Routed through the App command channel — the CLI never rewrites the ledger in parallel. */
function recordFix (ref, { minutes, date, at, rest, succeed, task, free }) {
  const rec = resolveRecord(ref)
  const patch = {}
  // 600 is the DB-layer clamp (db.js _recToRow): accepting 720 used to report success while 600 landed (audit drift)
  if (minutes != null) {
    const n = parseInt(minutes, 10) || 0
    if (n > 600) throw new CliError('focus duration max is 600 minutes (DB-layer clamp); got ' + n, 'USAGE')
    patch.focusDuration = Math.max(1, n)
  }
  if (rest != null) patch.restDuration = Math.max(0, Math.min(120, parseInt(rest, 10) || 0))
  if (succeed != null && succeed !== true) patch.succeed = !/^(false|no|0)$/i.test(String(succeed))
  if (date || at) {
    // endTime reposition: endTime defines placement; dateKey re-derived here (was App-side)
    const endBase = parseDate(date || dayjs(rec.endTime || Date.now()).format('YYYY-MM-DD'))
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || dayjs(rec.endTime || Date.now()).format('HH:mm')))
    if (!m) throw new CliError('--at accepts HH:mm', 'USAGE')
    patch.endTime = dayjs(endBase).hour(+m[1]).minute(+m[2]).second(0).millisecond(0).valueOf()
    patch.dateKey = dayjs(patch.endTime).format('YYYY-MM-DD')
  }
  if (free === true) patch.focusTaskId = null
  else if (task) patch.focusTaskId = resolveTask(task, liveTasks()).taskId
  const ok = open().call('tomatoUpdateById', { tomatoId: rec.tomatoId, patch })
  if (!ok) throw new CliError('record vanished from ledger: ' + rec.tomatoId, 'RECORD_NOT_FOUND')
  audit.record({ action: 'tomato.record-fix', targets: [], changes: [{ before: rec, after: Object.assign({}, rec, patch) }], note: 'CLI record fix (ledger row direct)' })
  return { rec: Object.assign({}, rec, patch) }
}

/** Delete an erroneous focus record (ledger row direct — the UI entry card deletes via the same op) */
function recordRemove (ref) {
  const rec = resolveRecord(ref)
  open().call('tomatoRemoveByIds', [rec.tomatoId])
  audit.record({ action: 'tomato.record-remove', targets: [], changes: [{ before: rec, after: null }], note: 'CLI record remove (ledger row direct)' })
  return { rec }
}

/** Reorder subtasks (subtasks array order — same storage as EditPanel drag) */
function moveSubtask (input, n, where, target) {
  const t = resolveTask(input, liveTasks())
  const subs = parseSubs(t)
  const idx = parseInt(n, 10) - 1
  if (!(idx >= 0 && idx < subs.length)) throw new CliError(`subtask #${n} not found (1-${subs.length})`, 'SUB_NOT_FOUND')
  let to
  if (where === 'up') to = idx - 1
  else if (where === 'down') to = idx + 1
  else if (where === 'top') to = 0
  else if (where === 'bottom') to = subs.length - 1
  else if (where === 'to') to = (parseInt(target, 10) || 0) - 1
  else throw new CliError('position must be up|down|top|bottom|to <n>', 'USAGE')
  if (!(to >= 0 && to < subs.length)) throw new CliError('target position out of range', 'SUB_NOT_FOUND')
  const [item] = subs.splice(idx, 1)
  subs.splice(to, 0, item)
  patchTodo(t.taskId, { subtasks: JSON.stringify(subs) }, { action: 'subtask' })
  return { taskId: t.taskId, order: subs.map((s, i) => `${i + 1}.${s.text}${s.checked ? '[x]' : ''}`) }
}

/* ---------------- Multiple reminders (reminderOffsets/reminderExtra — same todos columns the EditPanel writes) ---------------- */
/** Set reminder offsets: csv of minutes BEFORE the main reminder ("10,30" = 10/30 minutes early, stored as -10/-30;
 *  "0" = on-time; "none" clears). Requires the main reminder to exist (UI also gates the chips on remindTs>0). */
function setReminderOffsets (input, csv) {
  const t = resolveTask(input, liveTasks())
  if (!t.reminderTime) throw new CliError('task has no main reminder — set it first with edit --reminder <time>', 'NEEDS_MAIN_REMINDER')
  let offsets
  let zeroAbsorbed = false
  if (String(csv).trim().toLowerCase() === 'none') offsets = []
  else {
    offsets = String(csv).split(/[,，\s]+/).filter(Boolean).map(s => {
      const v = parseInt(s, 10)
      if (isNaN(v)) throw new CliError(`bad offset "${s}" (minutes before the main reminder, e.g. "10,30"; 0=on-time; none=clear)`, 'USAGE')
      // "0" (on-time) is explicitly absorbed: db normOffsets filters 0 out, so writing [0] would silently vanish — map to "no offset" instead
      return v === 0 ? null : -Math.abs(v)
    })
    zeroAbsorbed = offsets.includes(null)
    offsets = [...new Set(offsets.filter(v => v != null))].sort((a, b) => a - b)
  }
  patchTodo(t.taskId, { reminderOffsets: offsets }, { action: 'edit' })
  return {
    taskId: t.taskId, reminderTime: t.reminderTime, reminderOffsets: offsets,
    ...(zeroAbsorbed ? { note: '"0" (on-time) absorbed — no offset row written since the main reminder itself fires on time' } : {})
  }
}
/** Set extra absolute reminders (on top of the main one): comma-separated datetimes, same formats as --date; "none" clears */
function setReminderExtra (input, csv) {
  const t = resolveTask(input, liveTasks())
  let extras
  if (String(csv).trim().toLowerCase() === 'none') extras = []
  else {
    extras = String(csv).split(/[,，]/).map(s => s.trim()).filter(Boolean).map(s => parseDate(s))
    if (!extras.length) throw new CliError('no datetimes given (comma-separated, e.g. "2026-09-05 09:00, 2026-09-06 14:00")', 'USAGE')
  }
  patchTodo(t.taskId, { reminderExtra: extras }, { action: 'edit' })
  return { taskId: t.taskId, reminderExtra: extras.map(ts => dayjs(ts).format('YYYY-MM-DD HH:mm')) }
}

/* ---------------- Attachments (userData/files + image/4 JSON — replicates main/attachments.js saveAttachment) ---------------- */
const ATTACH_MAX_BYTES = 50 * 1024 * 1024
const ATTACH_IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
// Allowlist kept in sync with attachments.js (a blocklist was once bypassed via Windows trailing dots; here we reuse the allowlist and trailing-dot stripping rules)
const ATTACH_ALLOWED_EXT = new Set([...ATTACH_IMG_EXT, 'pdf', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'json'])
const attachKeyOf = item => { try { return decodeURIComponent(String(item.url || '').replace(/^local:\/\//, '')) } catch { return '' } }

function addAttachment (input, file) {
  const t = resolveTask(input, liveTasks())
  const fs = require('fs')
  const path = require('path')
  if (!file || !fs.existsSync(file)) throw new CliError('file not found: ' + file, 'FILE_NOT_FOUND')
  const cleanName = path.basename(file).replace(/[. ]+$/, '')
  const ext = path.extname(cleanName).slice(1).toLowerCase()
  if (!ext || !ATTACH_ALLOWED_EXT.has(ext)) throw new CliError('extension not allowed: ' + (ext || '(none)'), 'EXT_NOT_ALLOWED')
  const raw = fs.readFileSync(file)
  if (!raw.length) throw new CliError('file is empty', 'EMPTY_FILE')
  if (raw.length > ATTACH_MAX_BYTES) throw new CliError('file too large (max 50MB)', 'FILE_TOO_LARGE')
  const dir = path.join(userDataDir(), 'files')
  fs.mkdirSync(dir, { recursive: true })
  const safe = `${t.taskId.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')}_${Date.now()}_${cleanName.replace(/[\\/:*?"<>|]/g, '_')}`
  fs.writeFileSync(path.join(dir, safe), raw)
  const item = { url: 'local://' + encodeURIComponent(safe), name: cleanName, size: raw.length }
  const field = ATTACH_IMG_EXT.has(ext) ? 'image' : 'files'
  let list = []
  try { list = JSON.parse(t[field] || '[]'); if (!Array.isArray(list)) list = [] } catch { list = [] }
  list.push(item)
  patchTodo(t.taskId, { [field]: JSON.stringify(list) }, { action: 'attachment.add' })
  return { taskId: t.taskId, kind: field === 'image' ? 'image' : 'file', name: item.name, size: item.size, index: list.length }
}
function listAttachments (input) {
  const t = resolveTask(input, liveTasks())
  const parse = s => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
  return { taskId: t.taskId, images: parse(t.image), files: parse(t.files) }
}
/** Remove the n-th image or file attachment (1-based). Unlinks the physical file best-effort (same as the UI delete flow). */
function removeAttachment (input, kind, n) {
  const t = resolveTask(input, liveTasks())
  const field = /^(img|image|i)$/i.test(kind) ? 'image' : /^(file|f)$/i.test(kind) ? 'files' : null
  if (!field) throw new CliError('kind must be img|file', 'USAGE')
  let list = []
  try { list = JSON.parse(t[field] || '[]'); if (!Array.isArray(list)) list = [] } catch { list = [] }
  const idx = parseInt(n, 10) - 1
  if (!(idx >= 0 && idx < list.length)) throw new CliError(`attachment #${n} not found (${list.length} total)`, 'ATTACH_NOT_FOUND')
  const [item] = list.splice(idx, 1)
  patchTodo(t.taskId, { [field]: JSON.stringify(list) }, { action: 'attachment.remove' })
  try { require('fs').unlinkSync(path.join(userDataDir(), 'files', attachKeyOf(item))) } catch { /* already gone is fine */ }
  return { taskId: t.taskId, removed: item.name }
}

/* ---------------- Settings (meta db.settingsState mirror; hot-synced to a running App via the main-process watcher) ----------------
   Manifest mirrors renderer store/settings.js DEFAULT_SETTINGS/SETTING_ENUMS (keep in sync; security keys are never settable here). */
const SETTINGS_MANIFEST = {
  boolean: ['autoDownloadUpdates', 'enableTomatoFloating', 'weatherEnabled', 'taskFlyAnimation', 'closeActionMinimize', 'isCompleteWithSubtasks', 'isTodoEditModalCloseAutoSave', 'isCompleteCheckboxColorFollow', 'runWhenComputerStart', 'hideMainWindowOnStartup', 'enableHardwareAcceleration', 'showNoDate', 'showCompleteNoDate', 'showComplete', 'developerMode', 'showHabitModule', 'showProjectsModule', 'showDepsModule', 'isShowSubTask', 'isCalendarDimUncompleted', 'isShowCalendarPrivacyMode', 'isDefaultSubTaskFolded', 'showHolidayMarkers', 'showTodoCheckboxOrder', 'enableSecurityLock', 'autoBackupEnabled', 'isCalendarBackgroundUserSelected'],
  number: ['dailyTomatoTarget', 'dailyLoadWarnThreshold', 'recycleBinAutoDeleteDays', 'notificationTimeoutInterval', 'todoDescriptionDisplayLineNumber', 'autoBackupIntervalMin', 'autoBackupKeep', 'whiteNoiseVolume', 'tomatoTimeDefault', 'restTimeDefault'],
  enum: {
    colorMode: ['light', 'dark', 'system'],
    calendarFontSize: ['small', 'medium', 'large'],
    weekStartDay: ['mon', 'sun'],
    newTodoDefaultSort: ['top', 'bottom'],
    calendarBackground: ['list', 'theme', 'system'],
    calendarFontColor: ['white', 'black'],
    sortMode: ['custom', 'created', 'difficulty'],
    expiredCompletedTodoRange: ['today', '7d', '15d', '30d'],
    expiredUncompletedTodoRange: ['today', '7d', '30d', '90d'],
    upcomingTodoRange: ['7d', '30d'],
    weatherSource: ['open-meteo', 'wttr'],
    todoBoxSortMethod: ['created', 'due', 'difficulty'],
    todoBoxSortOrder: ['desc', 'asc']
  },
  string: ['backupDir', 'whiteNoiseAudio', 'weatherCity', 'calendarCategory', 'searchDateRange', 'searchComplete', 'searchCategory', 'newTodoCategoryId', 'todoBoxCategoryId', 'maxRepeat']
}
const SETTINGS_DENIED = new Set(['securityLockPassword', 'securityLockQuestion', 'schemaV', '_savedAt'])

function settingsDoc () {
  try { const d = JSON.parse(open().call('getMeta', 'db.settingsState') || 'null'); return d && typeof d === 'object' ? d : {} } catch { return {} }
}
function settingsKnown (key) {
  if (SETTINGS_MANIFEST.boolean.includes(key)) return { type: 'boolean' }
  if (SETTINGS_MANIFEST.number.includes(key)) return { type: 'number' }
  if (SETTINGS_MANIFEST.enum[key]) return { type: 'enum', options: SETTINGS_MANIFEST.enum[key] }
  if (SETTINGS_MANIFEST.string.includes(key)) return { type: 'string' }
  return null
}
function settingsList () {
  const doc = settingsDoc()
  const rows = []
  const all = [
    ...SETTINGS_MANIFEST.boolean.map(k => [k, { type: 'boolean' }]),
    ...SETTINGS_MANIFEST.number.map(k => [k, { type: 'number' }]),
    ...Object.entries(SETTINGS_MANIFEST.enum).map(([k, o]) => [k, { type: 'enum', options: o }]),
    ...SETTINGS_MANIFEST.string.map(k => [k, { type: 'string' }])
  ]
  for (const [key, info] of all) rows.push({ key, type: info.type, options: info.options || null, value: key in doc ? doc[key] : null })
  return rows
}
function settingsSet (key, value) {
  if (SETTINGS_DENIED.has(key)) throw new CliError('"' + key + '" is a protected key and cannot be set via CLI', 'DENIED_KEY')
  const info = settingsKnown(key)
  if (!info) throw new CliError('unknown setting "' + key + '" — settings list to browse keys', 'UNKNOWN_KEY')
  let v = value
  if (info.type === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(String(value))) v = true
    else if (/^(false|0|no|off)$/i.test(String(value))) v = false
    else throw new CliError('"' + key + '" expects true|false', 'USAGE')
  } else if (info.type === 'number') {
    v = Number(value)
    if (isNaN(v)) throw new CliError('"' + key + '" expects a number', 'USAGE')
  } else if (info.type === 'enum') {
    if (!info.options.includes(String(value))) throw new CliError(`"${key}" expects one of: ${info.options.join(' | ')} (got "${value}")`, 'USAGE')
    v = String(value)
  }
  const doc = settingsDoc()
  const before = key in doc ? doc[key] : null
  doc[key] = v
  doc._savedAt = Date.now()
  doc.schemaV = doc.schemaV || 1
  open().call('setMeta', ['db.settingsState', JSON.stringify(doc)])
  audit.record({ action: 'settings.set', targets: [], changes: [{ before: { [key]: before }, after: { [key]: v } }], note: 'setting "' + key + '" changed (hot-synced to running App, applied on launch otherwise)' })
  return { key, value: v, previous: before }
}

function planDayKey (date) {
  if (!date) return dayjs().format('YYYY-MM-DD')
  return dayjs(dayStartOf(parseDate(date))).format('YYYY-MM-DD')
}
function planRows (day) {
  const rows = open().call('planAll', []).filter(r => !day || r.day === day)
  return rows
}
/** Place/schedule a task chip at HH:mm (one task can hold multiple chips = multiple expected pomodoros). --replace swaps all chips. */
function planSet (input, mm, { date, replace } = {}) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(mm))) throw new CliError('time must be HH:mm (00:00-23:59)', 'USAGE')
  const t = resolveTask(input, liveTasks())
  // Defaults to the task's own scheduled day (a future task's chips land on its task day, not today); explicit --date overrides
  const day = planDayKey(date != null && date !== true ? date : (t.dayStart ? dayjs(t.dayStart).format('YYYY-MM-DD') : null))
  const existing = planRows(day).filter(r => r.taskId === t.taskId)
  if (!replace && existing.some(r => r.mm === mm)) throw new CliError(`task already has a chip at ${mm} (plan list to inspect, --replace to rebuild)`, 'PLAN_EXISTS')
  if (replace && existing.length) open().call('planDeleteTaskDay', { taskId: t.taskId, day })
  open().call('planAddMany', [{ taskId: t.taskId, day, mm }])
  const chips = planRows(day).filter(r => r.taskId === t.taskId).map(r => r.mm).sort() // re-read actual state so the audit stays faithful
  audit.record({ action: 'plan.set', targets: [t], changes: [{ after: { day, chips } }], note: 'scheduled on the day timeline at ' + mm })
  return { taskId: t.taskId, content: t.taskContent, day, chips }
}
function planList (date) {
  const day = planDayKey(date)
  const live = liveTasks()
  const byTask = {}
  for (const r of planRows(day)) {
    if (!byTask[r.taskId]) byTask[r.taskId] = []
    byTask[r.taskId].push(r.mm)
  }
  return { day, tasks: Object.entries(byTask).map(([taskId, chips]) => {
    const t = live.find(x => x.taskId === taskId)
    return { taskId, content: t ? t.taskContent : '(deleted task)', complete: !!(t && t.complete), chips: chips.sort() }
  }) }
}
function planRemove (input, { date, at } = {}) {
  const t = resolveTask(input, liveTasks())
  const day = planDayKey(date)
  const arr = planRows(day).filter(r => r.taskId === t.taskId)
  if (!arr.length) throw new CliError(`task has no chips on ${day}`, 'PLAN_NOT_FOUND')
  let ids
  if (at) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new CliError('time must be HH:mm', 'USAGE')
    ids = arr.filter(r => r.mm === at).map(r => r.id)
    if (!ids.length) throw new CliError(`no chip at ${at} for this task on ${day}`, 'PLAN_NOT_FOUND')
  } else {
    ids = arr.map(r => r.id)
  }
  open().call('planRemoveIds', ids)
  audit.record({ action: 'plan.remove', targets: [t], changes: [{ before: { day, removed: ids.length } }], note: 'timeline chips removed' })
  return { taskId: t.taskId, day, removed: ids.length }
}


/* ---------------- Events import: rebuild a whole day's schedule from a structured event list (backfill/reconstruction scenarios) ----------------
   Event shape: { date:'YYYY-MM-DD', start:'HH:mm', end:'HH:mm'|'24:00', title, category:'工作|学习|生活|发布|<id>',
                  important:0|1, urgent:0|1, tags:['a','b'], estimate:N }
   Idempotent: dedupe by (dayStart, title); tasks already existing are skipped and not created again. */
function eventFocusMinutes (mins) {
  // Focus duration = wall-clock duration ×0.75 (reserving breaks), rounded to 25-min whole tomatoes, minimum one tomato
  return Math.max(25, Math.round(mins * 0.75 / 25) * 25)
}
function eventEnd (e) {
  let [h2, m2] = String(e.end || '').split(':').map(Number)
  if (h2 === 24) { h2 = 23; m2 = 59 }
  return { h: h2, m: m2 }
}
function eventKey (e) {
  return dayStartOf(parseDate(e.date + ' ' + e.start)) + '|' + String(e.title || '').trim()
}
async function importEvents (events, { onProgress = () => {} } = {}) {
  if (!Array.isArray(events) || !events.length) throw new CliError('events file must be a non-empty JSON array', 'EMPTY_EVENTS')
  const existing = liveTasks()
  const seen = new Set(existing.map(t => t.dayStart + '|' + String(t.taskContent || '').trim()))
  const recs = tomatoRecords() || []
  const hasRecord = tid => recs.some(r => r.manual && r.focusTaskId === tid)
  let created = 0, skipped = 0
  const failed = []
  for (const e of events) {
    const label = (e.date || '?') + ' ' + (e.start || '') + ' ' + (e.title || '').slice(0, 24)
    try {
      if (!e.date || !e.start || !e.end || !e.title) throw new CliError('missing date/start/end/title', 'BAD_EVENT')
      const key = eventKey(e)
      if (seen.has(key)) { skipped++; onProgress({ label, status: 'skipped-task' }); continue }
      const { h: h1, m: m1 } = (() => { const [a, b] = String(e.start).split(':').map(Number); return { h: a, m: b } })()
      const { h: h2, m: m2 } = eventEnd(e)
      let mins = (h2 * 60 + m2) - (h1 * 60 + m1)
      if (mins <= 0) mins += 1440
      const endClamp = (e.end === '24:00') ? '23:59' : e.end
      const tags = (e.tags || []).map(t => '#' + String(t).replace(/^#/, '')).join(' ')
      const t = addTodo({
        content: e.title, desc: tags, category: e.category != null ? String(e.category) : undefined,
        date: e.date + ' ' + e.start,
        important: e.important ? 1 : 0, urgent: e.urgent ? 1 : 0,
        createTime: e.date + ' ' + e.start
      })
      seen.add(key)
      if (e.estimate) { try { setEstimate(t.taskId, Math.min(20, Number(e.estimate) || 0)) } catch (er) { /* non-fatal */ } }
      toggleComplete(t.taskId, true, { completedAt: parseDate(e.date + ' ' + endClamp) })
      const focusMin = eventFocusMinutes(mins)
      backfillRecord({ taskId: t.taskId, content: e.title, date: e.date, at: e.start, minutes: focusMin })
      created++
      onProgress({ label, status: 'created', focusMin })
    } catch (er) {
      failed.push({ label, error: String(er.message || er) })
      onProgress({ label, status: 'failed', error: String(er.message || er) })
    }
  }
  return { created, skipped, failed, total: events.length, hasRecord }
}

function getTask (input) { const t = resolveTask(input); if (!t) throw new CliError('task not found: ' + input, 'TASK_NOT_FOUND'); return t }
// undone tasks whose predecessors are all complete (or none); optional categoryId scope. FS readiness read for humans and AI agents.
function listReady (categoryId = null) {
  const db = open()
  const list = listActive(db)
  const byId = {}
  for (const t of list) byId[t.taskId] = t
  return list.filter(t => {
    if (t.complete) return false
    if (categoryId != null && t.categoryId !== categoryId) return false
    const preds = parsePredecessors(t.predecessors)
    return preds.every(pid => { const p = byId[pid]; return !p || p.complete })
  })
}
module.exports = {
  CliError, open, parseDate, dayStartOf, launchApp, userDataDir, hasIsolationEnv,
  liveTasks, recycleTasks, resolveTask, resolveCategory,
  parsePredecessors, getTask, listReady,
  listTodos, getCategories, stats, overview,
  addTodo, patchTodo, clearTodoDate, toggleComplete, deleteTodo, restoreTodo, purgeRecycleBin, doctor, dateExplicitTime, chipsRemoveTask, chipsRestoreSnapshot,
  parseSubs, addSubtask, checkSubtask, removeSubtask,
  audit, readAuditLog: audit.readEntries,
  getProjects, getProjectIds, setProjectFlag, projectStatus, parseMilestoneDate,
  PROJECT_STATUS_VALUES, explicitStatus, setProjectStatus,
  getMilestones, addMilestone, removeMilestone, linkMilestone, msProgress,
  setProjectDeadline, getProjectDeadline,
  writeTomatoCmd, readTomatoState, waitForTomatoAck, tomatoLiveRemainSec, backfillRecord,
  buildRepeatRule, repeatOn, repeatOff, repeatRuleInfo,
  addCategory, renameCategory, deleteCategory, moveCategory, categoryRows, categoryHierarchy, listTags, rewriteTag, tomatoRecords,
  resolveTaskExact, batchRun, batchTagOne, migrateChipsOnDayChange,
  viewsList, resolveView, viewAdd, viewRm, applyViewConds, viewFetchOpts, viewCondsSummary,
  lunarOf, lunarAnnotate,
  setEstimate, sortTask, listOn, resolveRecord, recordFix, recordRemove, moveSubtask,
  setReminderOffsets, setReminderExtra, addAttachment, listAttachments, removeAttachment,
  settingsList, settingsSet, planSet, planList, planRemove,
  importEvents, eventFocusMinutes, eventKey
}
