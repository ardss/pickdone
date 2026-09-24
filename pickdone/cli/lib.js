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
// Explicit isoWeek extension (hardening, 2026-09-12): applyViewConds' week window uses endOf('isoWeek') but used
// to rely on todo-core's require side effect extending the shared instance. Extend our own instance so the CLI
// keeps correct 本周 semantics even if that import chain ever changes (same degrade as cli/nl-date.cjs).
try { dayjs.extend(require('../assets/vendor-lib/dayjs-plugin-isoWeek.js')) } catch (e) { /* degrade to default week start when the plugin is missing */ }
const { FOCUS_MAX_MINUTES, REST_MAX_MINUTES } = require('../shared/limits.mjs') // focus-duration clamp constants (single source with db.js / renderer, audit item 4); require(esm) — Node >= 22.12

// The CLI runs in pure Node; silence electron-log to keep logs out of the stdout JSON output
try {
  const log = require('electron-log')
  if (log.transports) {
    if (log.transports.console) log.transports.console.level = false
    if (log.transports.file) log.transports.file.level = false
  }
} catch (e) { /* ignore when electron-log is not installed */ }

const dbm = require('../src/main/db.js')
// Phase-2 command-bus write door (docs/refactor-command-bus.md): every CLI write goes through
// the bus (manifest entity/verb) — op-keyed db writes from the CLI are gone. preserveStamp: the
// CLI derives its own row ages exactly as before; the bus must not add fields the legacy calls
// never sent (sync LWW unchanged). P2-1 (R5) contract precision: preserveStamp keeps PAST
// stamps untouched, but an explicit stamp more than STAMP_CLAMP_MS into the future is still
// clamped to now (shared forgery guard — see command-bus.stampPayload).
const bus = require('../src/main/command-bus')
// open() first: several call sites used `open().call(op, …)` as their only DB touch — the bus
// commit must keep guaranteeing an initialized handle in pure-CLI sessions.
const commit = (entity, verb, payload) => { open(); return bus.commit(entity, verb, payload, { preserveStamp: true }) }
const core = require('../src/main/core/todo-core.js')
// Round-3 P1: ownership guard for attachment filenames (single source with the App's purge path,
// src/main/handlers/shared.js — pure, electron-free).
const { ownsAttachmentFile } = require('../src/main/handlers/shared.js')
const audit = require('./audit.js')
const nlDate = require('./nl-date.cjs')
const { parseMilestoneDateCore } = require('../shared/parse-date.mjs') // milestone-date core shared with the renderer (require(esm), same pattern as limits.mjs)
const { nextSort, moveWithin } = require('../shared/sort-core.mjs') // P3-7 / F-B2: sort-score single source with renderer utils/core.js (require(esm))
const { stripHabitsFamily } = require('../shared/settings-families.mjs') // F-B1: blob-family contract shared with lan-sync-bootstrap foldSettingsIntoBlob (require(esm))
const { localDayKey } = require('../src/main/fix-util.js') // P3-8: single source for the local YYYY-MM-DD key (same require the lib-attachments module already uses)

let opened = false
// P3-9 (dw wave): the userData directory has ONE source — src/main/user-dir.js (no third copy;
// audit.js defaultDirResolver reads the same module). Env priority: TODO_DB_DIR > TODO_USER_DATA_DIR > platform default.
const { userDataDir, hasIsolationEnv } = require('../src/main/user-dir.js')
/** Open the database (idempotent). The TODO_DB_DIR env var can point to an isolated directory (for tests); defaults to the App's userData */
function open () {
  if (opened) return dbm
  // Main process reuse: when the App itself has already opened the DB with the same directory (CSV import goes through the main process IPC), init must not be run a second time to rebuild the connection
  if (dbm.isOpen && dbm.isOpen()) { opened = true; return dbm }
  const dir = userDataDir()
  dbm.init(dir)
  // One-shot tomato ledger migration (review P2 2026-09-11): the App runs tomatoMigrateFromMeta on startup, but a CLI-only session after the ledger-schema upgrade used to read an empty ledger — and worse, a CLI backfill landing rows first made the migration's table-not-empty guard throw the old meta blob ledger away forever (the blob-deletion sentinel runs regardless). Running the migration sentinel here, BEFORE any CLI write, keeps both ends converging on the same row table. Idempotent by design: "meta blob absent" is the migrated marker, so repeat calls on already-migrated DBs are no-ops.
  try { commit('tomato', 'migrateFromMeta') } catch (e) { /* migration failure must not block the CLI (same tolerance as the App's startup call) */ }
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
  // Bare M/D, M.D, M-D (no year) must be intercepted BEFORE dayjs(): V8's fallback Date parse
  // turns '9/22' into 2001-09-22 and reports it valid (P2-1). Current year + explicit month/day
  // validation, same interception the shared parseMilestoneDateCore applies.
  const bareMd = str.match(/^(\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (bareMd) {
    const mo = +bareMd[1]; const d2 = +bareMd[2]
    if (mo < 1 || mo > 12) throw new CliError(`invalid date: "${s}" (month ${mo} does not exist)`)
    const days = dayjs().month(mo - 1).daysInMonth()
    if (d2 < 1 || d2 > days) throw new CliError(`invalid date: "${s}" (${mo}-${d2} is not a valid month/day — month ${mo} has ${days} days)`)
    let base = dayjs().month(mo - 1).date(d2)
    if (bareMd[3] != null) base = base.hour(+bareMd[3]).minute(+bareMd[4]).second(0).millisecond(0)
    else base = base.startOf('day')
    return +base
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
// F-B5 (dw wave 3): single keyword normalization — was 3 verbatim copies (resolveTask, resolveRepeatEntry,
// lib-tasks.cjs resolveCategory; the last now receives it via the existing deps injection). NFKC aligns
// the CLI with the renderer's search normalization (utils/search.js normalize('NFKC')) — full-width
// input ('Ａ１') used to match in the App but not in the CLI. BEHAVIOR CHANGE (NFKC alignment), noted.
const normKey = v => String(v).normalize('NFKC').toLowerCase().replace(/[\s\u00A0\u3000\u200B\u2003]/g, '')
function liveTasks () { return open().call('queryTodos', { deleted: 0, orderBy: 'scheduledDay ASC, sort ASC' }) }
function recycleTasks () { return open().call('queryTodos', { deleted: 1, orderBy: 'updatedAt DESC' }) }

/** Resolve user input into a task: exact match on a full taskId → otherwise unique substring match on content (case-insensitive).
 *  Default pool (review P2 2026-09-11): live tasks only. A soft-deleted (recycle-bin) task is still returned when it is the
 *  UNIQUE match, but with an explicit stderr warning — `done`/`edit` silently mutating recycled rows was the bug; dropping
 *  the fallback entirely would break existing keyword workflows against a task the user just deleted by mistake. Explicit
 *  intent keeps working: restore/delete pass an explicit recycle pool, so they never hit this warning path. */
function resolveTask (input, pool) {
  // Strip zero-width/full-width whitespace (IME candidates occasionally contain zero-width chars) Same normalization on both sides: stripping it only from the input made any multi-word keyword unmatchable
  const matchIn = list => {
    const byId = list.find(t => t.taskId === input)
    if (byId) return [byId]
    const kw = normKey(input)
    return list.filter(t => normKey(t.taskContent || '').includes(kw))
  }
  const liveHits = matchIn(pool || liveTasks())
  if (liveHits.length === 1) return liveHits[0]
  if (liveHits.length > 1) {
    throw new CliError(`"${input}" matched ${liveHits.length} tasks; use a more specific keyword or the full taskId:\n` +
      liveHits.slice(0, 10).map(t => `  - ${t.taskContent} (${t.taskId})`).join('\n'), 'AMBIGUOUS_MATCH')
  }
  if (pool) throw new CliError(`task not found: "${input}"`, 'TASK_NOT_FOUND')
  const recHits = matchIn(recycleTasks())
  if (recHits.length === 1) {
    const t = recHits[0]
    console.error(`warning: "${input}" matched a soft-deleted task in the recycle bin (${t.taskId}) — run "restore ${t.taskId}" first if it should be live`)
    return t
  }
  if (recHits.length > 1) {
    throw new CliError(`"${input}" matched ${recHits.length} soft-deleted tasks in the recycle bin; restore them first or use the full taskId:\n` +
      recHits.slice(0, 10).map(t => `  - ${t.taskContent} (${t.taskId})`).join('\n'), 'AMBIGUOUS_MATCH')
  }
  throw new CliError(`task not found: "${input}"`, 'TASK_NOT_FOUND')
}

/** userId: take user_id from any row in the DB (consistent with the UI's login state).
 *  Empty-DB fallback is 840001 — the same hard-coded userId the renderer uses (renderer/js/utils/core.js
 *  userId: 840001, demo-data.js alike). The old fallback 0 created tasks the App could not associate with
 *  the logged-in user. (todo-core.js genTaskId takes the userId as a parameter; no shared constant exists.) */
function guessUserId () {
  const row = open().call('queryTodos', { deleted: 0, limit: 1 })[0] ||
    open().call('queryTodos', { deleted: 1, limit: 1 })[0]
  return row ? row.userId : 840001
}

/** Semver-aware comparison for release tags/versions ("v" prefix optional). Returns -1/0/1.
 *  The previous update-command comparator split on '.' and coerced to Number, so every prerelease
 *  segment became NaN, collapsed to 0 through `|| 0` — a 0.4.0-beta.15 user was told v0.4.0 was
 *  not newer (up to date) even though semver puts 0.4.0 strictly above 0.4.0-beta.15.
 *  Rules (semver §11): numeric core segments first; a version WITH a prerelease outranks nothing —
 *  release > prerelease of the same core; prerelease identifiers compare numerically when both are
 *  numeric, otherwise lexicographically, and numeric < alphanumeric; fewer identifiers loses. */
function compareVersions (a, b) {
  const parse = v => {
    const s = String(v).replace(/^v/, '')
    const dash = s.indexOf('-')
    const core = (dash < 0 ? s : s.slice(0, dash)).split('.').map(Number)
    const pre = dash < 0 ? null : s.slice(dash + 1).split('.')
    return { core, pre }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] || 0) - (y.core[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (!x.pre && !y.pre) return 0
  if (!x.pre) return 1   // release outranks prerelease of the same core
  if (!y.pre) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pNum = /^\d+$/.test(p), qNum = /^\d+$/.test(q)
    if (pNum && qNum) { const d = Number(p) - Number(q); if (d) return d < 0 ? -1 : 1 }
    if (pNum !== qNum) return pNum ? -1 : 1 // numeric identifiers < alphanumeric
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

const genTaskId = core.genTaskId

/* ---------------- Split sub-modules (2026-09-23, #132 skipped P3-11 continuation) ----------------
   Read commands and the projects/milestones/status block moved verbatim to lib-tasks.cjs /
   lib-projects.cjs; deps are injected so the db/bus/audit seams stay single-sourced here. */
const {
  listTodos, getCategories, resolveCategory, stats, overview,
} = require('./lib-tasks.cjs')({ open, CliError, parseDate, dayjs, normKey }) // F-B5: normKey injected (resolveCategory's copy removed)
const {
  getProjects, getProjectIds, setProjectFlag, projectStatus,
  getMilestones, parseMilestoneDate, addMilestone, removeMilestone, linkMilestone, msProgress,
  setProjectDeadline, getProjectDeadline,
  PROJECT_STATUS_VALUES, explicitStatus, setProjectStatus,
  PROJECT_IDS_KEY, projectFlagKey, projectStatusKey, MS_KEY,
} = require('./lib-projects.cjs')({ open, CliError, dayjs, commit, audit, resolveCategory, resolveTask, liveTasks, tomatoRecords, parseDate, dayStartOf, parseMilestoneDateCore })


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
/** F3 (2026-09-21): sort convention — baseline 1024 for the first row, ±512 step (addToTop → max+512, else min-512).
 *  P3-7: the CLI's verbatim nextSortCli copy is gone; shared/sort-core.mjs is imported as nextSort above. */
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
  // Insert sort unified on renderer nextSort semantics (F3 2026-09-21, shared nextSort): the side
  // (top/bottom) follows newTodoDefaultSort; the ±32 jitter keeps concurrently identical sorts distinct.
  const targetDay = todoTime ? +dayjs(todoTime).startOf('day') : 0
  const daySorts = db.call('queryTodos', { deleted: 0 })
    .filter(x => (x.dayStart || 0) === targetDay)
    .map(x => x.taskSort).filter(v => v != null)
  const addToTop = String(settingsDoc().newTodoDefaultSort || 'top') !== 'bottom'
  const taskSort = Math.fround(
    nextSort(addToTop, daySorts.length ? Math.min(...daySorts) : 0, daySorts.length ? Math.max(...daySorts) : 0) +
    (Math.random() - 0.5) * 64)
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
    taskSort,
    todoTime,
    userId: guessUserId(), status: 'add', version: 0
  }
  commit('todo', 'put', t)
  const rowAfter = db.call('getById', t.taskId)
  audit.record({ action: 'add', targets: [t], changes: [{ after: rowAfter }] })
  // Tasks with an explicit time are auto-placed on the day timeline (user-finalized 2026-09-03): the reminder answers "when will you call me", the schedule chip answers "what should I do in this slot" — both are kept
  // Fix (2026-09-19): NL times (明天9点/下午3点) resolved a timed todoTime but no chip — derive HH:mm from todoTime when the raw string has an NL marker and no HH:mm (bare dates must not fabricate chips).
  let mm = dateExplicitTime(date)
  if (!mm && todoTime && NL_TIME_MARKER_RE.test(String(date || '')) && !dayjs(todoTime).startOf('day').isSame(dayjs(todoTime))) {
    mm = dayjs(todoTime).format('HH:mm')
  }
  if (mm) { try { planSet(t.taskId, mm) } catch { /* chip write failure must not block task creation */ } }
  return rowAfter
}

/** Whether the raw --date string carries an explicit time (tomorrow 12:00 / 2026-09-04 09:30); a bare date (tomorrow) returns null */
function dateExplicitTime (s) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''))
  return m ? m[1].padStart(2, '0') + ':' + m[2] : null
}

/** Natural-language time markers (明天9点 / 下午3点 / 9点半 / 3pm): the raw string carries a time of day even without HH:mm */
const NL_TIME_MARKER_RE = /(\d{1,2}\s*[点:：]|\d{1,2}\s*[:：]\s*\d{1,2}|[上午下午晚上早上凌晨中午]|半|\d{1,2}\s*(?:am|pm)\b)/i

/** Reminder re-anchor on a reschedule (review P1 2026-09-11; renderer parity: EditPanel.applyDate).
 *  Shared by `edit --date` (pickdone.js) and `batch date` (batchRun) — the two channels used to diverge:
 *  batch bypassed the entry-layer re-anchor and left the main reminder on the old day. Moving the date
 *  carries reminders along: the main reminder re-anchors to the new date at its original time-of-day
 *  (stays absent when there was none) and reminderExtra rows shift by the same day-diff. Returns the
 *  fields to merge into the patch; empty object when there is nothing to carry. */
function dateChangeReminderPatch (before, newTodoTime) {
  const patch = {}
  if (!newTodoTime || !before) return patch
  if (before.reminderTime) {
    // EditPanel.applyDate takes hour/minute from the OLD reminder; seconds/millis too, so relative date
    // parses (which carry the current clock's seconds) stay deterministic
    const r = dayjs(before.reminderTime)
    patch.reminderTime = +dayjs(newTodoTime).hour(r.hour()).minute(r.minute()).second(r.second()).millisecond(r.millisecond())
  }
  const extras = Array.isArray(before.reminderExtra) ? before.reminderExtra : []
  const oldDay = before.todoTime ? +dayjs(before.todoTime).startOf('day') : 0
  if (extras.length && oldDay) {
    const shift = +dayjs(newTodoTime).startOf('day').diff(oldDay, 'day')
    if (shift) patch.reminderExtra = extras.map(x => +dayjs(x).add(shift, 'day'))
  }
  return patch
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
  commit('todo', 'put', merged)
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
    const undone = patchTodo(t.taskId, undoPatch, { action: 'undo' })
    // F3 P2 (2026-09-21): undoing an auto-renewed completion used to leave the renewed next instance
    // behind (the App's undo path removes it), so an accidental `done` on the group's last instance
    // permanently seeded a phantom tomorrow/future instance that only a manual delete would clear.
    // The renewal below only fires when the completed row is the group's LAST live instance — so on
    // undo, remove the instance that renewal created: same rid, nearest later dayStart, still the
    // group's last, and not itself completed. Any earlier sibling (a genuine older instance the user
    // un-did) is left alone.
    try {
      if (t.repeatId && t.dayStart) {
        const group = db.call('queryTodos', { deleted: 0, repeatId: t.repeatId })
          .filter(x => x.taskId !== t.taskId && x.dayStart > 0)
          .sort((a, b) => a.dayStart - b.dayStart)
        const lastDay = group.length ? group[group.length - 1].dayStart : 0
        const renewedNext = group.find(x => x.dayStart > t.dayStart)
        if (renewedNext && !renewedNext.complete && renewedNext.dayStart === lastDay) {
          const now = Date.now()
          // version: 0 (deleteTodo parity) so the soft delete re-enters the sync snapshot
          commit('todo', 'put', Object.assign({}, renewedNext, { delete: 1, deletedAt: now, updateTime: now, version: 0, status: 'delete' }))
          chipsSnapshotForDelete(renewedNext.taskId) // same snapshot→clear cascade as deleteTodo
          audit.record({ action: 'undo', targets: [renewedNext], changes: [{ before: renewedNext, after: null }], note: 'auto-renewed instance removed with the undo' })
        }
      }
    } catch { /* best-effort: the undo itself must succeed even if the cleanup hits a snag */ }
    return undone
  }
  const patch = core.completePatch(t, { withSubtasks: cascade, completedAt })
  const merged = { ...t, ...patch, updateTime: Date.now(), status: 'update' }
  commit('todo', 'put', merged)

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
        // F3 P2 (2026-09-21, D5 renderer parity — store/todo.js ensureNextRepeatInstance carries
        // `estimate: t.estimate || 0` AND copies it into the per-task meta key, while the CLI twin
        // hardcoded estimate:0): a renewed instance used to silently lose its estimated workload.
        // Fix (2026-09-22): read the LIVE meta estimate of the instance being renewed
        // (getEstimateOf(旧taskId)) — the row's estimate COLUMN is dead post-X2 (bumpSnow writes
        // accumulated focus minutes into it), so clamping it 0-20 turned "focused 150 min" into
        // "estimated 20 tomatoes" on the renewed instance.
        const estimate = clampEstimate(getEstimateOf(t.taskId, t.estimate))
        // F3 P2-4 single source: carried attributes come from core.renewalCarryFields via
        // buildRenewalInstance (F-B4) — the exact same set the renderer's ensureNextRepeatInstance
        // maps onto addTodo.
        const nt = buildRenewalInstance(t, next, { estimate })
        commit('todo', 'put', nt)
        // F3 P2: the estimate column is write-once at the DB layer (U-1) — the live value lives in the
        // per-task meta key `tomatoEstimateState:<taskId>`; copy it there so the renewal keeps its
        // estimate on both ends (renderer twin: setEstimate in ensureNextRepeatInstance).
        if (estimate > 0) {
          try {
            commit('meta', 'put', [estimateKey(nt.taskId), String(estimate)])
            commit('meta', 'put', ['tomatoEstimateStateAt', String(Date.now())]) // same stamp convention as setEstimate
          } catch { /* estimate is advisory */ }
        }
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

/** F-B4 (dw wave 3): single constructor for CLI renewal instances — the done path (repeat renewal on
 *  complete) and repeatOn's future-instance expansion (expand) carried two ~40-line near-verbatim
 *  object literals. Behavior preserved exactly, including expand's historical estimate:0 (no silent
 *  behavior change; the done path keeps its live getEstimateOf readback). Sort keeps the legacy
 *  length-keyed bottom-insert convention (min-512 / empty-day 1024; see the inline note for why
 *  nextSort's own empty check is not used here). */
function buildRenewalInstance (t, next, { estimate = 0, todoTime = next.todoTime, reminderTime, extra = {} } = {}) {
  const now = Date.now()
  const sameDay = open().call('queryTodos', { deleted: 0 }).filter(x => x.dayStart === dayStartOf(todoTime))
  const sameSorts = sameDay.map(x => x.taskSort).filter(v => v != null)
  // P2 2026-09-20 convention (renderer renewal: store/todo.js addToTop:false → nextSort): bottom-insert
  // min-512, empty day 1024. The EMPTY-day case is keyed on sameSorts.length, NOT nextSort's internal
  // `!minS && !maxS` check — a day whose existing sorts are all exactly 0 (midpoint arithmetic can
  // produce 0) must take the min-512 branch (-512), not the empty-day 1024 baseline (review fix).
  const taskSort = sameSorts.length ? Math.fround(Math.min(...sameSorts) - 512) : 1024
  let subs = null
  try { subs = t.subtasks ? JSON.parse(t.subtasks) : null } catch { /* keep null */ }
  return {
    complete: false, createTime: now, delete: false,
    ...core.renewalCarryFields(t, next),
    reminderTime: reminderTime !== undefined ? reminderTime : next.reminderTime,
    estimate,
    subtasks: subs ? JSON.stringify(subs.map(s => ({ ...s, checked: false }))) : null,
    image: null, files: null,
    categoryId: t.categoryId,
    updateTime: now, syncTime: 0,
    taskContent: t.taskContent,
    taskDescribe: t.taskDescribe || '',
    taskId: core.genTaskId(t.userId, now),
    taskSort,
    todoTime,
    userId: t.userId, status: 'add', version: 0,
    ...extra
  }
}

/** Soft delete → recycle bin (deletedAt drives the 30-day auto hard-delete and recycle-bin ordering, aligned with the renderer) */
function deleteTodo (input) {
  // version reset to 0 (renderer parity: store/todo.js deleteTodo, P3 2026-09-12): syncTodos excludes
  // delete rows already acked with version > 0, so keeping the old version meant a re-delete after
  // restore never re-entered the sync snapshot and the deletion silently never propagated.
  const after = patchTodo(input, { delete: true, deletedAt: Date.now(), version: 0 }, { action: 'delete' })
  chipsSnapshotForDelete(after.taskId) // snapshot chips → meta before clearing rows: prevents orphan chips while keeping restore backfill capability
  return after
}

/** Snapshot all of a task's chips into meta (planChipsSnapshot:<taskId>) before clearing its rows */
function chipsSnapshotForDelete (taskId) {
  try {
    const rows = open().call('planAll', []).filter(r => r.taskId === taskId)
    if (rows.length) commit('meta', 'put', ['planChipsSnapshot:' + taskId, JSON.stringify(rows)])
    commit('plan', 'deleteTask', taskId)
  } catch { /* snapshot failure must not block deletion */ }
}

/** P3-10 (dw wave): chipsRemoveTask deleted — dead export (zero callers repo-wide; deleteTodo goes
 *  through chipsSnapshotForDelete, purgeRecycleBin relies on the db-layer cascade). */

/** Day-change chip migration (same semantics as the UI's moveTaskChips and the `edit --date` follow-up):
 *  existing chips keep their times and follow the task to the new day. Best-effort — never blocks the patch. */
function migrateChipsOnDayChange (taskId, oldDay, newDay) {
  if (!oldDay || !newDay || oldDay === newDay) return 0
  try {
    if (localDayKey(oldDay) === localDayKey(newDay)) return 0
    commit('plan', 'moveTask', { taskId, fromDay: localDayKey(oldDay), toDay: localDayKey(newDay) })
    return 1
  } catch { return 0 }
}

/** Restore a task: backfill the schedule chips snapshotted before deletion */
function chipsRestoreSnapshot (taskId) {
  try {
    const raw = open().call('getMeta', 'planChipsSnapshot:' + taskId)
    if (!raw) return 0
    const rows = JSON.parse(raw)
    if (Array.isArray(rows) && rows.length) commit('plan', 'putMany', rows)
    // Round-3 P1: '' → deleteMeta (file-wide convention, renderer clearSnapshot parity) — a ''
    // value is NOT a tombstone here, it is a stale meta row a later task-id collision could
    // misread as an (empty) snapshot; deleteMeta propagates the removal to peers too.
    commit('meta', 'delete', 'planChipsSnapshot:' + taskId)
    return rows.length
  } catch { return 0 }
}

/** Restore from the recycle bin */
function restoreTodo (input) {
  // Row first, snapshot second (verify-then-commit, renderer parity: store/todo.js restoreFromRecycle):
  // chipsRestoreSnapshot clears the one-shot snapshot meta as a side effect, so consuming it before the
  // resolve+upsert was confirmed meant a mid-way failure (re-resolve throwing, upsert failing) permanently
  // lost the snapshot. The row update alone is harmless to retry; only after it succeeds do we spend it.
  const db = open()
  const t = resolveTask(input, recycleTasks())
  const merged = { ...t, delete: false, deletedAt: 0, updateTime: Date.now(), status: 'update' }
  commit('todo', 'put', merged)
  const after = db.call('getById', t.taskId)
  try { chipsRestoreSnapshot(t.taskId) } catch { /* no snapshot = originally had no schedule */ }
  audit.record({ action: 'restore', targets: [t], changes: [{ before: t, after }] })
  return after
}

/** Permanently empty the recycle bin (dangerous; the entry layer is responsible for confirmation). Each row is recorded before clearing, preserving the only traceable deletion evidence */
function purgeRecycleBin () {
  open() // ensure the DB is open — the purge commits through the bus, which resolves this same module
  const rows = recycleTasks()
  // Delete attachment files BEFORE clearing rows (files/<taskId>_<ts>_<name>, same prefix rule as the
  // App's purgeAttachmentFiles in src/main/index.js): purging rows only once left private attachments on disk
  let filesRemoved = 0
  try {
    const dir = path.join(userDataDir(), 'files')
    for (const f of fs.readdirSync(dir)) {
      // Round-3 P1: the old bare startsWith(`${taskId}_`) prefix let a task whose id is a PREFIX
      // of another id ('a' vs 'a_b') delete the other task's files. Use the App's
      // ownsAttachmentFile guard (segment after the id must be the all-digit timestamp).
      if (rows.some(r => ownsAttachmentFile(f, r.taskId))) {
        try { fs.unlinkSync(path.join(dir, f)); filesRemoved++ } catch { /* best-effort, never block the purge */ }
      }
    }
  } catch { /* no files dir is fine */ }
  // Snapshot meta must die with the rows (review P2 2026-09-11): the App's purge path clears
  // planChipsSnapshot:<id>, the CLI purge left the meta behind — a later task-id collision could
  // backfill a purged task with someone else's chips, and the meta rows just leaked.
  for (const r of rows) { try { commit('meta', 'delete', 'planChipsSnapshot:' + r.taskId) } catch { /* absent is fine */ } try { commit('meta', 'delete', ESTIMATE_KEY_PREFIX + r.taskId) } catch { /* M-11: estimate key dies with the row too */ } }
  // F3 P2 (2026-09-21, D5 renderer parity — store/todo.js scrubMilestonesForPurged, the renderer got
  // this fix on both purge paths while the CLI twin kept the bug): purge used to leave the purged
  // taskIds inside projectMilestones:<catId> blobs. A past milestone whose last link was purged then
  // kept a phantom taskId set, and milestoneState (ids.size > 0, zero EXISTING linked tasks) fell
  // through to the date-driven 'done' branch — flipping an UNMET milestone to done. Scrub the ids
  // from every milestone blob before the rows die; milestones keep their other links.
  let msScrubbed = 0
  try {
    const purgedIds = new Set(rows.map(r => r.taskId))
    if (purgedIds.size) {
      for (const k of open().call('listMetaKeys') || []) {
        if (!String(k).startsWith('projectMilestones:')) continue
        let list
        try { list = JSON.parse(open().call('getMeta', k) || '[]') } catch { continue /* corrupt blob → leave alone */ }
        if (!Array.isArray(list)) continue
        let changed = false
        for (const m of list) {
          if (Array.isArray(m.taskIds) && m.taskIds.some(id => purgedIds.has(id))) {
            m.taskIds = m.taskIds.filter(id => !purgedIds.has(id))
            changed = true
          }
        }
        if (changed) { commit('meta', 'put', [k, JSON.stringify(list)]); msScrubbed++ }
      }
    }
  } catch { /* best-effort: the purge itself must not fail on meta scrubbing */ }
  commit('todo', 'purgeBin')
  audit.record({
    action: 'purge',
    changes: rows.map(r => ({ before: r })),
    note: `purged ${rows.length} item(s) (irreversible), ${filesRemoved} attachment file(s) removed` + (msScrubbed ? `, milestone scrub: ${msScrubbed} blob(s)` : '')
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
  commit('meta', 'put', ['cliTomatoCmd', JSON.stringify({ seq, at: Date.now(), ...cmd })])
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


/* ---------------- LAN sync command channel (feat/cli-sync-pair): same contract as the tomato channel —
   CLI writes meta cliSyncCmd (seq via atomic nextCliSyncSeq) → the running App's main process
   dispatches into db-sync-ops (the Device Center's own registry) → writes the receipt to
   cliSyncState. The receipt wait matches the seq EXACTLY (not >=): a long-running pair must not
   have its waiter satisfied by a later status command's higher seq landing first. */
function writeSyncCmd (cmd) {
  const seq = open().call('nextCliSyncSeq')
  commit('meta', 'put', ['cliSyncCmd', JSON.stringify({ seq, at: Date.now(), ...cmd })])
  audit.record({ action: 'sync.' + cmd.action, targets: [], changes: [], note: 'CLI sync command (App executes and writes back cliSyncState)' })
  return seq
}
function readSyncState () {
  const raw = open().call('getMeta', 'cliSyncState')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
async function waitForSyncAck (seq, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = readSyncState()
    if (st && st.seq === seq) return st
    await new Promise(r => setTimeout(r, 200))
  }
  return null
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
    // Fix (2026-09-19): --interval was ignored for weekly (hardcoded 1) while daily/monthly honored it
    rule.repeatType = 'week'; rule.repeatInterval = interval
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
  const t = resolveTask(input, liveTasks())
  if (t.complete) throw new CliError('task already completed; undo it before setting a repeat', 'INVALID_STATE')
  if (t.repeatId && String(t.repeatId).startsWith('repeat_')) throw new CliError('task already in a repeat group (' + t.repeatId + '); repeat off first, then re-set', 'ALREADY_REPEAT')
  const rid = 'repeat_' + t.userId + Date.now().toString(36) + Math.floor(Math.random() * 1e4)
  // Fix (2026-09-19): no CLI flags for the yearly anchor — a Jan-1 default rule is re-anchored from the task's todoTime (explicit anchors stay authoritative).
  if (rule.repeatType === 'year' && t.todoTime &&
      rule.repeatYearMonth === core.REPEAT_DEFAULTS.repeatYearMonth &&
      rule.repeatYearMonthDay === core.REPEAT_DEFAULTS.repeatYearMonthDay) {
    const anchor = dayjs(t.todoTime)
    rule.repeatYearMonth = anchor.month() + 1
    rule.repeatYearMonthDay = anchor.date()
  }
  commit('meta', 'put', ['repeatRule:' + rid, JSON.stringify(rule)])
  commit('todo', 'put', Object.assign({}, t, { repeatId: rid, updateTime: Date.now(), status: 'update' }))
  // Generate subsequent instances (the first day is the current task itself), reusing the todo-core engine's expansion
  const base = t.todoTime || t.dayStart || +dayjs().startOf('day')
  // Generation cap: explicit --count wins; otherwise the App's maxRepeat setting (default 2), same as RepeatModal
  const cap = count > 0 ? count : (parseInt(settingsDoc().maxRepeat, 10) || 2)
  // Template reminder wall-clock re-derivation now happens per instance inside the loop (F-B4).
  let made = 0
  // P2 2026-09-20: pass the holiday list — expandRepeatDates(base, rule) defaulted to [] so a
  // skipStatutoryHolidays rule still expanded ONTO statutory holidays on the CLI (the renderer
  // passes its holidayList here; the CLI complete-renewal path below already does). Mirrors
  // cli/lib.js:655.
  const holidayList = require('../src/main/core/holidays.js').getHolidayList()
  for (const ts of core.expandRepeatDates(base, rule, holidayList).map(d => +d).filter(ts => ts > base).slice(0, cap)) {
    // F-B4: shared renewal-instance constructor (done-path parity). reminderTime keeps the template's
    // wall-clock time on each instance (dayjs re-derive per instance, same as RepeatModal — copying
    // the raw timestamp made reminders fire on the template's original date). estimate stays 0 and
    // carries NO meta write-back — historical D5-parity known gap, preserved as-is.
    const tplRem = t.reminderTime > 0 ? +dayjs(ts).hour(dayjs(t.reminderTime).hour()).minute(dayjs(t.reminderTime).minute()).second(0).millisecond(0) : 0
    commit('todo', 'put', buildRenewalInstance(t, { todoTime: ts, reminderTime: 0 }, {
      todoTime: ts,
      reminderTime: tplRem,
      extra: { repeatId: rid }
    }))
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
  const kw = normKey(input)
  const hits = list.filter(t => normKey(t.taskContent || '').includes(kw) && String(t.repeatId || '').startsWith('repeat_'))
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
        // version: 0 (deleteTodo parity, 2026-09-12 P3): syncTodos excludes delete rows already acked
        // with version > 0, so keeping the old version meant the soft-deleted repeat instances never
        // re-entered the sync snapshot and the deletion silently never propagated.
        commit('todo', 'put', Object.assign({}, x, { delete: 1, deletedAt: now, updateTime: now, version: 0, status: 'delete' }))
        chipsSnapshotForDelete(x.taskId) // same snapshot→clear cascade as deleteTodo: soft-deleted instances must not leave orphan chips
        removed++
      }
    }
    // Fix (2026-09-19): '' → deleteMeta (file-wide convention) so the rule row is actually removed.
    commit('meta', 'delete', 'repeatRule:' + rid)
  }
  commit('todo', 'put', Object.assign({}, t, { repeatId: null, updateTime: Date.now(), status: 'update' }))
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
    if (folder) throw new CliError('nested folders are not supported — the App renders folders as roots only (same guard as category move)', 'CATEGORY_NESTED_FOLDER')
    parentId = pid
  }
  const cat = {
    categoryId: Date.now() * 1000 + Math.floor(Math.random() * 1000), userId: 840001,
    categoryName: String(name), categoryColor: color && CAT_COLORS.includes(color) ? color : CAT_COLORS[cats.length % CAT_COLORS.length],
    createTime: Date.now(), listSort: Math.max(0, ...cats.map(c => c.listSort)) + 100,
    folderIs: !!folder, folderId: parentId, delete: false
  }
  commit('category', 'put', catToRow(cat))
  audit.record({ action: 'category.add', targets: [], changes: [{ after: { name, id: cat.categoryId } }], note: (folder ? 'folder' : 'category') + ' created' })
  return cat
}
function renameCategory (input, nextName) {
  const db = open()
  const id = resolveCategory(input)
  const cat = db.call('getAllCategories').find(c => c.categoryId === id)
  if (db.call('getAllCategories').some(c => c.categoryId !== id && c.categoryName === nextName)) throw new CliError('category "' + nextName + '" already exists', 'CATEGORY_EXISTS')
  const updated = Object.assign({}, cat, { categoryName: nextName })
  commit('category', 'put', catToRow(updated))
  audit.record({ action: 'category.rename', targets: [], changes: [{ before: { name: cat.categoryName }, after: { name: nextName } }], note: 'category renamed' })
  return updated
}
/** Best-effort meta read for the delete backup path ('' when the row/host is absent) */
function safeGetMeta (k) { try { return open().call('getMeta', k) || '' } catch { return '' } }
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
  for (const c of victims) commit('category', 'put', catToRow(Object.assign({}, c, { delete: true })))
  // Round-3 P1 (U-4 parity with renderer category.js backupThenClearProjectMeta): back up the
  // project meta surfaces into `catProjectMetaBak.<id>` BEFORE clearing them — the UI's recover
  // path restores exactly this blob, and the CLI used to hard-delete the keys with no backup,
  // making a recovered category lose its project flag/status/deadline/milestones irreversibly.
  // (Must run before ANY live-key deletion below.)
  const catMetaBakKey = vid => 'catProjectMetaBak.' + vid
  for (const v of victims) {
    const vid = String(v.categoryId)
    const blob = {
      flag: (safeGetMeta(projectFlagKey(vid)) === '1'),
      status: safeGetMeta(projectStatusKey(vid)) || '',
      deadline: safeGetMeta('projectDeadline:' + vid) || '',
      milestones: safeGetMeta(MS_KEY(vid)) || ''
    }
    if (blob.flag || blob.status || blob.deadline || blob.milestones) {
      commit('meta', 'put', [catMetaBakKey(vid), JSON.stringify(blob)])
    }
  }
  // A deleted category must not linger as a project: X3 flag keys are removed per victim; the
  // legacy whole-doc array (read fallback) is pruned only when it actually lost an id.
  for (const v of victims) { try { commit('meta', 'delete', projectFlagKey(v.categoryId)) } catch { /* absent is fine */ } }
  let legacyIds = []
  try { const a = JSON.parse(open().call('getMeta', PROJECT_IDS_KEY) || '[]'); if (Array.isArray(a)) legacyIds = a } catch { /* corrupt → leave alone */ }
  const pruned = legacyIds.filter(x => !victims.some(v => String(v.categoryId) === String(x)))
  if (pruned.length !== legacyIds.length) commit('meta', 'put', [PROJECT_IDS_KEY, JSON.stringify(pruned)])
  for (const v of victims) {
    try { commit('meta', 'delete', projectFlagKey(v.categoryId)) } catch { /* absent is fine */ }
    try { commit('meta', 'delete', 'projectDeadline:' + v.categoryId) } catch { /* absent is fine */ }
    // same lifecycle cleanup for the explicit status meta (review P2 2026-09-11): a later category id
    // reuse would inherit the deleted project's stale status on both ends (key = projectStatus:<id>)
    try { commit('meta', 'delete', projectStatusKey(v.categoryId)) } catch { /* absent is fine */ }
    // milestones die with the deletion too (backed up above — renderer parity backupThenClearProjectMeta)
    try { commit('meta', 'delete', MS_KEY(v.categoryId)) } catch { /* absent is fine */ }
  }
  // P1-3 (R5, sync-visible parity with renderer category.js purgeFiltersForVictims): saved
  // filters whose conds.catId references a cascade victim must die with the category — the
  // renderer cascades them (and its undo reports "{n} saved filter(s) removed"), the CLI used
  // to leave them behind pointing at a dead category id. Tombstone each victim filter through
  // the bus (filter.delete), back the set up in `catFiltersBak.<rootId>` for recover symmetry
  // (same pattern as catProjectMetaBak above), and report the count in the command output.
  const deadCatIds = new Set(victims.map(v => String(v.categoryId)))
  const catFiltersBakKey = 'catFiltersBak.' + id
  let removedFilters = 0
  let doomedFilters = []
  try {
    doomedFilters = (db.call('filterList') || []).filter(f => f && f.conds && deadCatIds.has(String(f.conds.catId)))
  } catch { /* degraded read: leave filters alone rather than half-cascading */ }
  if (doomedFilters.length) {
    commit('meta', 'put', [catFiltersBakKey, JSON.stringify(doomedFilters.map(f => ({ id: f.id, name: f.name, conds: f.conds, sort: f.sort })))])
    for (const f of doomedFilters) {
      try { commit('filter', 'delete', f.id); removedFilters++ } catch { /* skip and keep cascading */ }
    }
  }
  audit.record({ action: 'category.delete', targets: [], changes: [{ before: { names: victims.map(v => v.categoryName) } }], note: 'category soft-deleted (recoverable in UI), tasks kept' + (removedFilters ? `, ${removedFilters} saved filter(s) removed` : '') })
  return { deleted: victims.map(v => ({ id: v.categoryId, name: v.categoryName })), removedFilters }
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
  commit('category', 'put', catToRow(Object.assign({}, cat, { folderId: parentId })))
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
      // Same reminder re-anchor as `edit --date` (dateChangeReminderPatch): batch date used to patch
      // todoTime bare and leave the main reminder on the old day (semantic split between the channels)
      const patch = { todoTime: toTs, ...dateChangeReminderPatch(t, toTs) }
      const after = patchTodo(t.taskId, patch, { action: 'edit' })
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
    if (op === 'done' && t.complete) {
      // review P2 (2026-09-10): batch done used to rewrite completedAt and count the row as changed
      outcomes.push({ taskId: t.taskId, ok: true, skipped: true, label: `already complete "${t.taskContent}"` })
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
  const id = commit('filter', 'put', { name: clean, conds, sort: 0 })
  audit.record({ action: 'view.add', targets: [], changes: [{ after: { id, name: clean, conds } }], note: 'saved view created (same filters table as the App smart lists)' })
  return { id, name: clean, conds, sort: 0 }
}

/** Remove a saved view by name or id */
function viewRm (input) {
  const v = resolveView(input)
  commit('filter', 'delete', v.id)
  audit.record({ action: 'view.rm', targets: [], changes: [{ before: { id: v.id, name: v.name, conds: v.conds } }], note: 'saved view removed' })
  return { id: v.id, name: v.name }
}

/** Apply a saved view's conds to a task pool — mirrors renderer FilterView.list exactly:
 *  undone only, catId/priority equality (-1 = off), dateMode today/isoWeek/overdue/none windows.
 *  opts.done override (review P1 2026-09-12): an explicit `list --view X --done/--undone` owns the completion
 *  filter — default false keeps the FilterView undone-only parity, true skips the complete check (the fetch
 *  already filtered by the explicit flag) so done tasks are no longer silently dropped. */
function applyViewConds (conds, tasks, { done = false } = {}) {
  const c = conds || {}
  const today0 = +dayjs().startOf('day')
  const weekEnd = +dayjs().endOf('isoWeek') // isoWeek plugin extended explicitly at the top of this file
  return tasks.filter(t => {
    if (t.delete) return false
    if (done === false && t.complete) return false
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
  // FOCUS_MAX_MINUTES = the DB-layer clamp (shared/limits.mjs, db.js _recToRow): silently truncating 720 to 240/600 reported success while a different duration landed
  const raw = parseInt(minutes, 10) || 25
  if (raw > FOCUS_MAX_MINUTES) throw new CliError('backfill duration max is ' + FOCUS_MAX_MINUTES + ' minutes (DB-layer clamp); got ' + raw, 'USAGE')
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
  // Single-row CLI path fails fast: a rejected row (bad at → NaN endTime etc.) must not print success
  // or write audit. Row-level tolerance ({accepted, rejected}) is for the renderer's batch queue.
  const res = commit('tomato', 'appendMany', rec)
  if (res && Array.isArray(res.rejected) && res.rejected.length) {
    throw new CliError('backfill rejected: ' + res.rejected.map(r => r.reason).join(', '), 'LEDGER_REJECT')
  }
  audit.record({ action: 'tomato.backfill', targets: taskId ? [{ taskId }] : [], changes: [], note: 'CLI backfill ' + min + 'min @ ' + rec.dateKey + ' ' + at + ' (ledger row direct)' })
  return rec
}

/* ---------------- Tomato estimate per task (per-task meta keys = plain integer string; X2 2026-09-20 contract) ----------------
   F-B3 (dw wave 3): the storage contract (key prefix / 0..20 clamp / TS_KEY / legacy blob key) moved
   to shared/estimate-core.mjs — single source with the renderer's utils/tomatoEstimate.js (the
   renderer consumes the same module in its wave). */
const { ESTIMATE_KEY_PREFIX, estimateKeyOf, clampEstimate, TS_KEY: ESTIMATE_TS_KEY, LEGACY_KEY: ESTIMATE_LEGACY_KEY } = require('../shared/estimate-core.mjs')
const estimateKey = estimateKeyOf
/** Lazy legacy migration (first write): old whole-doc blob → per-task keys, then the legacy doc key
 *  is deleteMeta'd (a sync tombstone, so peers drop it too). Corrupt blob → dropped, not fatal. */
function migrateLegacyEstimateBlob () {
  const legacy = open().call('getMeta', ESTIMATE_LEGACY_KEY)
  if (legacy == null) return null
  let map = {}
  try { map = JSON.parse(legacy) || {} } catch { /* corrupt → drop */ }
  for (const [taskId, v] of Object.entries(map)) {
    const n = clampEstimate(v)
    if (n > 0) commit('meta', 'put', [estimateKey(taskId), String(n)])
  }
  commit('meta', 'delete', ESTIMATE_LEGACY_KEY)
  return map
}
function setEstimate (input, n) {
  const t = resolveTask(input, liveTasks())
  const v = clampEstimate(n)
  const legacy = migrateLegacyEstimateBlob()
  // Setting = setMeta plain integer string; clearing = deleteMeta (tombstone propagates the removal)
  if (v > 0) commit('meta', 'put', [estimateKey(t.taskId), String(v)])
  else commit('meta', 'delete', estimateKey(t.taskId))
  // Timestamp convention mirrors the renderer's tomatoEstimate/initFromDb: when meta is newer it takes over LS at startup (otherwise CLI writes get clobbered by the UI's stale LS)
  commit('meta', 'put', [ESTIMATE_TS_KEY, String(Date.now())])
  audit.record({ action: 'edit', targets: [t], changes: [{ before: { tomatoEstimate: getEstimateOf(t.taskId, legacy && legacy[t.taskId]) }, after: { tomatoEstimate: v || null } }], note: 'tomato estimate set to ' + (v || '(none)') })
  return { taskId: t.taskId, content: t.taskContent, tomatoEstimate: v }
}
function getEstimateOf (taskId, legacyVal) {
  // Readers: per-task key first; legacy doc blob only as a read fallback (per-task miss)
  try {
    const per = open().call('getMeta', estimateKey(taskId))
    if (per != null) return clampEstimate(per)
    if (legacyVal != null) return Number(legacyVal) || 0
    const m = JSON.parse(open().call('getMeta', ESTIMATE_LEGACY_KEY) || '{}')
    return m[taskId] || 0
  } catch { return 0 }
}

/* ---------------- Manual ordering (taskSort midpoint insertion — same semantics as renderer todo/reorderTodos drag)
   F-B2 (dw wave 3): the score math moved to shared/sort-core.mjs moveWithin (single source with the
   renderer's TodoItem._writeSort reorderScale rewrite); the ±100 no-beyond margin is precision
   degradation only — order can no longer drift between the two ends' scales. */
/** Reorder <task> relative to: top|bottom|up|down (within its day) or before|after <otherTask> (must share the day/no-date pool) */
function sortTask (input, pos, refInput) {
  const t = resolveTask(input, liveTasks())
  const pool = liveTasks().filter(x => x.dayStart === t.dayStart).sort((a, b) => (a.taskSort || 0) - (b.taskSort || 0))
  const idx = pool.findIndex(x => x.taskId === t.taskId)
  let ref = null
  if (pos === 'before' || pos === 'after') {
    if (!refInput) throw new CliError('sort before|after needs a reference task', 'USAGE')
    ref = resolveTask(refInput, liveTasks())
    if (ref.dayStart !== t.dayStart) throw new CliError('reference task must be on the same day (or both without a date) — change date first with edit --date', 'CROSS_DAY_SORT')
  }
  const refIdx = ref ? pool.findIndex(x => x.taskId === ref.taskId) : -1
  const mv = moveWithin(pool.map(x => x.taskSort), idx, pos, refIdx)
  if (!mv || mv.edge || mv.sort == null) {
    if (pos === 'up' || pos === 'down') throw new CliError('task is already at the ' + (pos === 'up' ? 'top' : 'bottom') + ' of its list', 'ALREADY_AT_EDGE')
    throw new CliError('position must be top|up|down|bottom, or before|after <task>', 'USAGE')
  }
  const newSort = mv.sort
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
    .map(t => ({ taskId: t.taskId, content: t.taskContent, time: t.todoTime ? dayjs(t.todoTime).format('HH:mm') : null, complete: t.complete, tomatoEstimate: getEstimateOf(t.taskId), dayStart: t.dayStart }))
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

/** Fix an existing focus record (wrong duration/time/task). The CLI writes the ledger row DIRECTLY via
 *  db.tomatoUpdateById — it does NOT route through the (retired) App command channel. Consequence: the
 *  running App does not learn about this write in-process. Convergence on the App side relies on external
 *  DB-write detection: db.js fires the ledger-changed hook for LEDGER_WRITE_OPS in the writer process
 *  (main/index.js setLedgerChangedHook → 'tomato-records-changed' broadcast), and external CLI writes are
 *  picked up by the main-process watcher / renderer store re-read (the same path that hot-applies
 *  `settings set`), or at worst on next launch. */
function recordFix (ref, { minutes, date, at, rest, succeed, task, free }) {
  const rec = resolveRecord(ref)
  const patch = {}
  // FOCUS_MAX_MINUTES is the DB-layer clamp (shared/limits.mjs, db.js _recToRow): accepting 720 used to report success while 600 landed (audit drift)
  if (minutes != null) {
    const n = parseInt(minutes, 10) || 0
    if (n > FOCUS_MAX_MINUTES) throw new CliError('focus duration max is ' + FOCUS_MAX_MINUTES + ' minutes (DB-layer clamp); got ' + n, 'USAGE')
    patch.focusDuration = Math.max(1, n)
  }
  // restDuration clamp = REST_MAX_MINUTES, the same cap the db layer applies (_recToRow); the old CLI-only
  // 120 clamp silently rewrote a legitimate 300-min rest to 120 while a direct db append kept 600.
  if (rest != null) patch.restDuration = Math.max(0, Math.min(REST_MAX_MINUTES, parseInt(rest, 10) || 0))
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
  const ok = commit('tomato', 'updateById', { tomatoId: rec.tomatoId, patch })
  if (!ok) throw new CliError('record vanished from ledger: ' + rec.tomatoId, 'RECORD_NOT_FOUND')
  audit.record({ action: 'tomato.record-fix', targets: [], changes: [{ before: rec, after: Object.assign({}, rec, patch) }], note: 'CLI record fix (ledger row direct)' })
  return { rec: Object.assign({}, rec, patch) }
}

/** Delete an erroneous focus record (ledger row direct — the UI entry card deletes via the same op) */
function recordRemove (ref) {
  const rec = resolveRecord(ref)
  commit('tomato', 'removeByIds', [rec.tomatoId])
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

/* ---------------- Settings (meta db.settingsState mirror; hot-synced to a running App via the main-process watcher) ----------------
   F-B9 manifest single source: SETTINGS_MANIFEST moved verbatim to shared/settings-manifest.mjs
   (dw wave 3) so the renderer's sanitize path can consume the same surface; re-exported below. */
const { SETTINGS_MANIFEST } = require('../shared/settings-manifest.mjs') // require(esm)
const SETTINGS_DENIED = new Set(['securityLockPassword', 'securityLockQuestion', 'schemaV', '_savedAt'])

function settingsDoc () {
  let doc = {}
  try { const d = JSON.parse(open().call('getMeta', 'db.settingsState') || 'null'); if (d && typeof d === 'object') doc = d } catch { /* corrupt blob → rows overlay still readable */ }
  // F3 P2 (2026-09-21): settings_rows is the field-granular sync truth (db-sync-schema.js P2 blob
  // split) while the blob is only the renderer's debounced mirror. A sync-applied row newer than the
  // blob (or a blob the mirror never refreshed) used to be invisible here, and settingsSet then
  // re-merged from that stale whole-blob read and re-stamped it over the newer peer row. Overlay the
  // non-deleted rows over the blob (rows win) so every CLI read starts from the converged doc.
  try {
    for (const r of open().call('settingsRowsAll') || []) {
      if (!r || r.deleted || r.key == null) continue
      doc[r.key] = r.value
    }
  } catch { /* pre-v6 DB without the rows table → blob-only read (previous behavior) */ }
  return doc
}
/** Test-only seam: invoked inside settingsSet between the first settingsDoc() read and the fresh re-read (simulates a concurrent App-side write). */
let settingsRaceHook = null
function setSettingsRaceHookForTests (fn) { settingsRaceHook = typeof fn === 'function' ? fn : null }
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
function settingsSet (key, value, { force = false } = {}) {
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
    // Fix (2026-09-16): the old isNaN check caught NaN but let Infinity through — JSON.stringify then stored
    // null in the settings blob. Negative values are meaningless for every numeric setting (targets,
    // thresholds, intervals, volumes, counts), so both are rejected now.
    if (!Number.isFinite(v)) throw new CliError('"' + key + '" expects a finite number (got "' + value + '")', 'USAGE')
    if (v < 0) throw new CliError('"' + key + '" must be >= 0 (got "' + value + '")', 'USAGE')
    // P3-6 (dw wave): per-key bounds mirroring the UI's input controls (SETTINGS_MANIFEST.ranges) —
    // the CLI used to accept any non-negative number where the App's slider/input clamps
    // (e.g. tomatoTime 5-180), so a CLI-written value silently displayed out of bounds in the App.
    const range = SETTINGS_MANIFEST.ranges[key]
    if (range && (v < range.min || v > range.max)) {
      throw new CliError(`"${key}" must be between ${range.min} and ${range.max} (got "${value}")`, 'USAGE')
    }
  } else if (info.type === 'enum') {
    if (!info.options.includes(String(value))) throw new CliError(`"${key}" expects one of: ${info.options.join(' | ')} (got "${value}")`, 'USAGE')
    v = String(value)
  }
  // Concurrency guard (2026-09-16, reworked 2026-09-19, F3 root fix 2026-09-21): the write goes to the
  // ROW path first (setting.put → settings_rows, the field-granular sync truth with per-field LWW),
  // THEN the blob is refreshed from a fresh settingsDoc() read (which now overlays rows over the blob).
  // The old whole-blob re-merge stamped a fresh _savedAt onto a doc read from the possibly-stale
  // blob, so it passed the mirror gate (db-sync-schema putRow gateTs) and clobbered newer peer rows
  // wholesale. The refreshed blob is built from the converged doc, so its bridge mirror is a
  // value-identical no-op — while the _savedAt bump keeps the two local blob consumers working (the
  // main-process hot-sync watcher diffs _savedAt; renderer initFromDb restores from the blob).
  // F-B1 (dw wave 3): settings_rows carries BOTH blob families (db.settingsState AND db.habitsState
  // — SYNC_BLOB_KEYS share the table), so the whole-doc read above can carry habits-family fields
  // (habits/moments/savedAt). Writing them back inside db.settingsState let the settings blob
  // swallow the habits state (renderer initFromDb then read a blob whose keys mixed families).
  // The write-back strips the habits-exclusive family (shared/settings-families.mjs — the same
  // contract lan-sync-bootstrap's foldSettingsIntoBlob routes by).
  const doc = settingsDoc()
  const before = key in doc ? doc[key] : null
  // F-B1 secondary fix: the blob's _savedAt doubles as the bridge's LWW gateTs (db-sync-schema
  // putRow). Stamping it at WRITE time made the gate a tautology — a stale echo read BEFORE a
  // sync-apply landed was re-stamped to now and re-won the row. Stamp the PRE-WRITE read moment
  // instead (captured right after the first read, BEFORE the race hook can inject a concurrent
  // apply): rows applied between the two reads are newer than the blob snapshot and keep winning.
  const readAt = Date.now()
  // Test seam: inject a concurrent mutation into the race window (first read → row write) so unit
  // tests can deterministically exercise the merge-on-fresh behavior. Null outside tests.
  if (typeof settingsRaceHook === 'function') settingsRaceHook()
  commit('setting', 'put', { key, value: v })
  const fresh = stripHabitsFamily(settingsDoc())
  fresh._savedAt = readAt
  fresh.schemaV = fresh.schemaV || 1
  commit('meta', 'put', ['db.settingsState', JSON.stringify(fresh)])
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
  if (replace && existing.length) commit('plan', 'deleteTaskDay', { taskId: t.taskId, day })
  commit('plan', 'putMany', [{ taskId: t.taskId, day, mm }])
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
  // Same default-day rule as planSet: the task's own scheduled day (plan rm after plan set must not
  // silently target today and fail PLAN_NOT_FOUND for a future-scheduled task); explicit --date overrides
  const day = planDayKey(date != null && date !== true ? date : (t.dayStart ? dayjs(t.dayStart).format('YYYY-MM-DD') : null))
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
  commit('plan', 'removeIds', ids)
  audit.record({ action: 'plan.remove', targets: [t], changes: [{ before: { day, removed: ids.length } }], note: 'timeline chips removed' })
  return { taskId: t.taskId, day, removed: ids.length }
}

const evu = require('./event-utils.cjs')
const { eventFocusMinutes, eventEnd } = evu

/* ---------------- Events import: rebuild a whole day's schedule from a structured event list (backfill/reconstruction scenarios) ----------------
   Event shape: { date, start, end|24:00, title, category, important, urgent, tags, estimate }
   Idempotent: dedupe by (dayStart, title); tasks already existing are skipped and not created again. */

async function importEvents (events, { onProgress = () => {} } = {}) {
  if (!Array.isArray(events) || !events.length) throw new CliError('events file must be a non-empty JSON array', 'EMPTY_EVENTS')
  const existing = liveTasks()
  const seen = new Set(existing.map(t => t.dayStart + '|' + String(t.taskContent || '').trim()))
  // Fix (2026-09-19): re-read records inside the predicate — a pre-import snapshot never saw rows the import itself just created.
  const hasRecord = tid => (tomatoRecords() || []).some(r => r.manual && r.focusTaskId === tid)
  let created = 0, skipped = 0
  const failed = []
  for (const e of events) {
    const label = (e.date || '?') + ' ' + (e.start || '') + ' ' + (e.title || '').slice(0, 24)
    try {
      if (!e.date || !e.start || !e.end || !e.title) throw new CliError('missing date/start/end/title', 'BAD_EVENT')
      const key = evu.eventKey(e, dayStartOf, parseDate)
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
      // Behavior fix (2026-09-16): a FUTURE event used to be imported as completed + with a backfilled focus
      // record — importing next week's schedule fabricated "done + accounted" history for work not yet done.
      // Future events now only create the task; completion and the ledger row are left to the real day.
      const future = String(e.date) > dayjs().format('YYYY-MM-DD')
      if (!future) {
        toggleComplete(t.taskId, true, { completedAt: parseDate(e.date + ' ' + endClamp) })
        const focusMin = eventFocusMinutes(mins)
        backfillRecord({ taskId: t.taskId, content: e.title, date: e.date, at: e.start, minutes: focusMin })
        created++
        onProgress({ label, status: 'created', focusMin })
      } else {
        created++
        onProgress({ label, status: 'created-future', focusMin: null })
      }
    } catch (er) {
      failed.push({ label, error: String(er.message || er) })
      onProgress({ label, status: 'failed', error: String(er.message || er) })
    }
  }
  return { created, skipped, failed, total: events.length, hasRecord }
}

const eventKey = (e) => evu.eventKey(e, dayStartOf, parseDate)

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
const attachApi = require('./lib-attachments.cjs')
const { addAttachment, listAttachments, removeAttachment } = attachApi({ resolveTask, liveTasks, patchTodo, userDataDir, CliError })
module.exports = {
  CliError, commit, open, parseDate, dayStartOf, launchApp, userDataDir, hasIsolationEnv, guessUserId, compareVersions,
  liveTasks, recycleTasks, resolveTask, resolveCategory,
  parsePredecessors, getTask, listReady,
  listTodos, getCategories, stats, overview,
  addTodo, patchTodo, clearTodoDate, toggleComplete, deleteTodo, restoreTodo, purgeRecycleBin, doctor, dateExplicitTime, chipsRestoreSnapshot,
  parseSubs, addSubtask, checkSubtask, removeSubtask,
  audit, readAuditLog: audit.readEntries,
  getProjects, getProjectIds, setProjectFlag, projectStatus, parseMilestoneDate,
  PROJECT_STATUS_VALUES, explicitStatus, setProjectStatus,
  getMilestones, addMilestone, removeMilestone, linkMilestone, msProgress,
  setProjectDeadline, getProjectDeadline,
  writeTomatoCmd, readTomatoState, waitForTomatoAck, tomatoLiveRemainSec, backfillRecord,
  writeSyncCmd, readSyncState, waitForSyncAck,
  buildRepeatRule, repeatOn, repeatOff, repeatRuleInfo,
  addCategory, renameCategory, deleteCategory, moveCategory, categoryRows, categoryHierarchy, listTags, rewriteTag, tomatoRecords,
  resolveTaskExact, batchRun, batchTagOne, migrateChipsOnDayChange,
  viewsList, resolveView, viewAdd, viewRm, applyViewConds, viewFetchOpts, viewCondsSummary,
  lunarOf, lunarAnnotate,
  setEstimate, getEstimateOf, sortTask, listOn, resolveRecord, recordFix, recordRemove, moveSubtask,
  setReminderOffsets, setReminderExtra, addAttachment, listAttachments, removeAttachment,
  settingsList, settingsSet, settingsDoc, setSettingsRaceHookForTests, planSet, planList, planRemove, dateChangeReminderPatch,
  SETTINGS_MANIFEST, settingsKnown, normKey, buildRenewalInstance,
  importEvents, eventFocusMinutes, eventKey
}
