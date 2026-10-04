/**
 * Todo CLI core library — reuses the main process's db.js OPS table; write semantics aligned with renderer/js/store/todo.js * (add→status:'add' / update→'update' / delete→'delete'; completedAt written only on complete/undo;
 *   dayStart is derived from todoTime by db.js todoToRow; local writes do not advance meta.todosVersion — managed by the cloud-sync pipeline)
 */
const path = require('path')
const fs = require('fs')
const dayjs = require('dayjs')
require('dayjs/locale/zh-cn')
dayjs.locale('zh-cn')
// Explicit isoWeek extension (hardening, 2026-09-12): applyViewConds' week window uses endOf('isoWeek') but used
// to rely on todo-core's require side effect extending the shared instance. Extend our own instance so the CLI // keeps correct 本周 semantics even if that import chain ever changes (same degrade as cli/nl-date.cjs).
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
// Phase-2 command-bus write door (docs/refactor-command-bus.md): every CLI write goes through the bus // (manifest entity/verb) — op-keyed db writes from the CLI are gone. preserveStamp keeps PAST stamps
// untouched, but an explicit stamp more than STAMP_CLAMP_MS into the future is still clamped to now // (shared forgery guard — see command-bus.stampPayload).
const bus = require('../src/main/command-bus')
// open() first: several call sites used `open().call(op, …)` as their only DB touch — the bus // commit must keep guaranteeing an initialized handle in pure-CLI sessions.
const commit = (entity, verb, payload) => { open(); ensureTomatoMigrated(); return bus.commit(entity, verb, payload, { preserveStamp: true }) }
const core = require('../src/main/core/todo-core.js')
// Round-3 P1: ownership guard for attachment filenames (single source with the App's purge path — // pure, electron-free; D3 2026-09-24 now required directly from its electron-free domain module // src/main/attachment-ownership.js instead of through handlers/shared.js + its electron-log require).
const { ownsAttachmentFile } = require('../src/main/attachment-ownership.js')
const audit = require('./audit.js')
const nlDate = require('./nl-date.cjs')
const { parseMilestoneDateCore } = require('../shared/parse-date.mjs') // milestone-date core shared with the renderer (require(esm), same pattern as limits.mjs)
const { nextSort, moveWithin } = require('../shared/sort-core.mjs') // P3-7 / F-B2: sort-score single source with renderer utils/core.js (require(esm))

const { localDayKey } = require('../src/main/fix-util.js') // P3-8: single source for the local YYYY-MM-DD key (same require the lib-attachments module already uses)

let opened = false
// P3-9 (dw wave): the userData directory has ONE source — src/main/user-dir.js (no third copy; // audit.js defaultDirResolver reads the same module). Env priority: TODO_DB_DIR > TODO_USER_DATA_DIR > platform default.
const { userDataDir, hasIsolationEnv } = require('../src/main/user-dir.js')

/* ================= data-safety isolation gate (P0, single point) =================
 * Structural rule: without an explicitly declared isolation dir, no CLI entry may touch the real
 * user database (%APPDATA%/pickdone). Path resolution is single-sourced in src/main/user-dir.js;
 * the gate was missing at the CONSUMER side — every write-side entry (pickdone.js dispatch,
 * launchApp) calls assertIsolationForWrite here instead of re-implementing the check.
 * Same contract as cli/e2e-walkthrough.js assertIsolationEnv, one exported implementation. */
const ISOLATION_HINT = 'CLI write commands default to the REAL user database (%APPDATA%\\pickdone). ' +
  'Set TODO_DB_DIR=<isolated dir> (or TODO_USER_DATA_DIR) to isolate, or pass --yes-i-know to confirm writing the real database.'
function assertIsolationForWrite ({ allowReal = false } = {}) {
  if (hasIsolationEnv() || allowReal) return
  const e = new CliError(ISOLATION_HINT, 'ISOLATION_REQUIRED')
  throw e
}

/** Open the database (idempotent). The TODO_DB_DIR env var can point to an isolated directory (for tests); defaults to the App's userData.
 *  Runs the one-shot tomato ledger migration sentinel (r5-4 contract: at open(), BEFORE any read or
 *  write — a CLI-only `tomato list` after the ledger upgrade must see the migrated rows, and a CLI
 *  backfill landing rows first must not make tomatoMigrateFromMeta's table-not-empty guard throw the
 *  old meta blob away forever). Idempotent by design: "meta blob absent" is the migrated marker. */
function open () {
  if (opened) return dbm
  // Main process reuse: when the App itself has already opened the DB with the same directory (CSV import goes through the main process IPC), init must not be run a second time to rebuild the connection
  if (dbm.isOpen && dbm.isOpen()) { opened = true; return dbm }
  const dir = userDataDir()
  dbm.init(dir)
  opened = true
  ensureTomatoMigrated()
  return dbm
}
// Flag both makes the migration once-per-process and breaks the recursion (the migration itself goes through the same write path).
let tomatoMigrated = false
function ensureTomatoMigrated () {
  if (tomatoMigrated) return
  tomatoMigrated = true
  try { bus.commit('tomato', 'migrateFromMeta', null, { preserveStamp: true }) } catch (e) {
    // Fail-loud (d11 round 2): the old bare catch swallowed a corrupt meta blob into SILENCE — // `tomato list` then printed an empty ledger and exited 0 (read-side side effect + fake success).
    console.error(`warning: tomato ledger migration failed (${e && e.message ? e.message : e}); tomato output may be incomplete — inspect the meta blob in ${userDataDir()}`)
  }
}

/* ================= Errors ================= */
class CliError extends Error {
  constructor (message, code = 'CLI_ERROR') { super(message); this.code = code }
}

/* ---------------- Split sub-modules (2026-09-23, #132 skipped P3-11 continuation; 2026-09-27 size-ratchet continuation) ----------------
   Read commands and the projects/milestones/status block moved verbatim to lib-tasks.cjs /
   lib-projects.cjs; deps are injected so the db/bus/audit seams stay single-sourced here. */
const { parseDate, dayStartOf, lunarOf, lunarAnnotate, dateChangeReminderPatch } = require('./lib-date.cjs')({ CliError, dayjs, nlDate })
// D18-DOM2 size-ratchet: dateChangeReminderPatch moved verbatim into lib-date.cjs (dayjs-only helper).

/* ================= Task resolution ================= */
// F-B5 (dw wave 3): single keyword normalization — was 3 verbatim copies (resolveTask, resolveRepeatEntry, // lib-tasks.cjs resolveCategory; the last now receives it via the existing deps injection). NFKC aligns
// the CLI with the renderer's search normalization (utils/search.js normalize('NFKC')) — full-width // input ('Ａ１') used to match in the App but not in the CLI. BEHAVIOR CHANGE (NFKC alignment), noted.
const normKey = v => String(v).normalize('NFKC').toLowerCase().replace(/[\s\u00A0\u3000\u200B\u2003]/g, '')
// D19-DOM2 (#4): CLI listing is APP DISPLAY order — taskSort DESC within a day (shared/sort-core.mjs
// documents the contract: sortMode.js custom mode renders `b.taskSort - a.taskSort`). The old ASC
// orderBy printed every day's list upside-down; db.js stays generic, the contract lives at this read layer.
function liveTasks () { return open().call('queryTodos', { deleted: 0, orderBy: 'scheduledDay ASC, sort DESC' }) }
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
  tomatoRecords, backfillRecord, resolveRecord, recordFix, recordRemove,
  setEstimate, getEstimateOf, estimateKey, ESTIMATE_KEY_PREFIX, ESTIMATE_MAX, clampEstimate,
} = require('./lib-focus.cjs')({ open, commit, audit, CliError, dayjs, resolveTask, liveTasks, parseDate, FOCUS_MAX_MINUTES, REST_MAX_MINUTES })
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
  // B10-P3 (App parity EditPanel): the App bounds priority/difficulty to 0-3 — an unbounded CLI value
  // used to write a quadrant level the UI can never render. Loud CliError, same as the edit path.
  if ((priority != null && !(Number(priority) >= 0 && Number(priority) <= 3)) || (difficulty != null && !(Number(difficulty) >= 0 && Number(difficulty) <= 3))) throw new CliError('priority/difficulty must be within 0-3 (App parity)', 'USAGE')
  const db = open()
  const now = Date.now()
  const createdTs = createTime ? parseDate(createTime) : now // createTime 可回填(--created-at):重建历史日程时「新增」统计才不失真;缺省=现在
  const todoTime = date ? parseDate(date) : (reminderDateBackfill(null, { reminderTime: reminder ? parseDate(reminder) : 0 }).todoTime || 0) // D19-DOM2 (#3, App parity): a reminder on a dateless add backfills the date (edit-path twin, cli/pickdone.js reminderDateBackfill)
      // Renewal-instance idempotency: skip when an instance with the same rid + same dayStart exists (prevents duplicate CLI runs + concurrent multi-window generation creating two)
  if (repeatId && todoTime) {
    const targetDay = +dayjs(todoTime).startOf('day')
    const existing = db.call('queryTodos', { deleted: 0, repeatId, dayStartFrom: targetDay, dayStartTo: targetDay })
    if (Array.isArray(existing) && existing.length) return existing[0]
  }
  // Insert sort unified on renderer nextSort semantics (F3 2026-09-21, shared nextSort): the side (top/bottom) follows newTodoDefaultSort; the ±32 jitter keeps concurrently identical sorts distinct.
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
    estimate: 0, difficulty: difficulty != null ? Number(difficulty) : 0,
    // App addTodo parity: NO priority⇔important derivation at create time — the quadrant coupling
    // belongs to EDIT only (EditPanel fieldPatch); the App's addTodo defaults both to 0
    priority: priority != null ? Number(priority) : 0,
    important: important != null ? Number(important) : 0,
    urgent: urgent != null ? Number(urgent) : 0,
    repeatId, subtasks: null, image: null, files: null,
    predecessors: (after && after.length) ? JSON.stringify(after) : null,
    // D18-DOM2 (#5, App parity store/todo.js addTodo `categoryId = settings.newTodoCategoryId || 0`):
    // with no explicit --category, the App defaults to the user's settings.newTodoCategoryId; the CLI
    // used to hard-default to 0 and silently ignored the setting. A 0/absent setting stays "unset"
    // (0) — resolveCategory(0) would otherwise throw NO_CATEGORIES on a category-less DB.
    categoryId: resolveCategory(category != null && String(category).trim() !== ''
      ? category
      : ((Number(settingsDoc().newTodoCategoryId) || 0) || null)) || 0,
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
  // D18-DOM2 (#7, App parity): NO schedule chip is minted at add time — the App's addTodo writes no
  // planAdd (the old comment here claiming a timeline chip was "user-finalized 2026-09-03" was wrong;
  // chips are set explicitly via `plan <task> <HH:mm>` / the App's day-plan UI). D17 already removed
  // the mint from `edit`; this removes it from `add` so both CLI verbs match the App.
  return rowAfter
}

/** Whether the raw --date string carries an explicit time (tomorrow 12:00 / 2026-09-04 09:30); a bare date (tomorrow) returns null */
function dateExplicitTime (s) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''))
  return m ? m[1].padStart(2, '0') + ':' + m[2] : null
}

/** NL time marker regex removed (D18-DOM2 #7): it only served the deleted add-time chip minting. */

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
 *  dayStart). B3/B13: reminderOffsets are dropped along with the main reminder (offsets are anchored to it
 *  — keeping them revives stale early-warning chips when a reminder is re-added; the reminder-clear
 *  lifecycle rule in EditPanel.onRemindersClear). Schedule chips cannot survive without a
 *  day to live on: same snapshot→clear cascade as the App's rowChipSync date-removed branch
 *  (snapshotForDelete + clearTaskChips = snapshot to meta, then planDeleteTask) — the snapshot stays in
 *  meta so a later `restore` can still backfill. B13 exact shape (EditPanel.applyDate(0), offsetsCleared):
 *  reminderTime drops to 0 and BOTH reminder arrays empty — offsets AND extras are anchored to the main
 *  reminder and die with it (the old "extras kept as-is" sentence here contradicted the code below).
 *  Already-undated task → no-op ({changed:false}, nothing written, no audit entry). */
function clearTodoDate (input) {
  const t = resolveTask(input, liveTasks())
  if (!t.todoTime && !t.dayStart) return { task: t, changed: false }
  const patch = { todoTime: 0, reminderTime: 0, reminderOffsets: [], reminderExtra: [] } // reminders die with the date (B3/B13)
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
  if (target && t.complete) {
    // Already-complete skip (review P2 2026-09-10, batch parity with lib-tags.cjs batchRun): a single
    // `done` on a complete task used to rewrite completedAt and mint a duplicate audit entry.
    return { completed: t, renewed: null, skipped: true }
  }
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
    // D18-DOM2 (#12): row shape aligned with the renderer's deleteTodo/deleteTodosMany — `delete: true`
    // (not the numeric `delete: 1`), version 0. `deleting` is a renderer UI-dialect flag that the App
    // strips before persisting, so the CLI simply never sets it. Known CLI-side differences (not ported):
    // no critical-backup/writeEventBackup and no view recompute on this channel (the CLI has no
    // renderer views to recompute; backups land via the purge event snapshot, cli/lib-eventbackup.cjs).
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
          commit('todo', 'put', Object.assign({}, renewedNext, { delete: true, deletedAt: now, updateTime: now, version: 0, status: 'delete' }))
          chipsSnapshotForDelete(renewedNext.taskId) // same snapshot→clear cascade as deleteTodo
          audit.record({ action: 'undo', targets: [renewedNext], changes: [{ before: renewedNext, after: null }], note: 'auto-renewed instance removed with the undo' })
        }
      }
    } catch (e) {
      // Best-effort: the undo itself must succeed even if the cleanup hits a snag — but not silently
      // (the old bare catch left an orphan phantom instance with zero signal)
      console.error(`warning: undo could not remove the auto-renewed instance for task ${t.taskId} (${e && e.message ? e.message : e})`)
    }
    return undone
  }
  const patch = core.completePatch(t, { withSubtasks: cascade, completedAt })
  const merged = { ...t, ...patch, updateTime: Date.now(), status: 'update' }
  commit('todo', 'put', merged)

  // Repeat-group renewal (the store's ensureNextRepeatInstance semantics) — D18-DOM2 #1: the block
  // moved verbatim into lib-repeat.cjs renewRepeatAfterComplete so the subtask-driven parent
  // completion (lib-subs.cjs checkSubtask) renews the chain through the SAME code path (App parity:
  // every completion route dispatches ensureNextRepeatInstance, not just the direct toggle).
  const renewed = renewRepeatAfterComplete(db, t, merged)
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
  // version reset to 0 (renderer parity: store/todo.js deleteTodo, P3 2026-09-12): syncTodos excludes
  // delete rows already acked with version > 0, so keeping the old version meant a re-delete after
  // restore never re-entered the sync snapshot and the deletion silently never propagated.
  const after = patchTodo(input, { delete: true, deletedAt: Date.now(), version: 0 }, { action: 'delete' })
  chipsSnapshotForDelete(after.taskId) // snapshot chips → meta before clearing rows: prevents orphan chips while keeping restore backfill capability
  return after
}

/** Snapshot all of a task's chips into meta (planChipsSnapshot:<taskId>) before clearing its rows.
 *  D18-DOM2 (#11): a cascade failure used to be a SILENT bare catch — orphan chips with zero
 *  signal. It now warns to stderr with the task id and the deletion still proceeds (App parity:
 *  warn + continue). */
function chipsSnapshotForDelete (taskId) {
  try {
    const rows = open().call('planAll', []).filter(r => r.taskId === taskId)
    if (rows.length) commit('meta', 'put', ['planChipsSnapshot:' + taskId, JSON.stringify(rows)])
    commit('plan', 'deleteTask', taskId)
  } catch (e) {
    // snapshot failure must not block deletion — but it must be loud (orphan-chip signal)
    console.error(`warning: chip snapshot/cascade failed for task ${taskId} (${e && e.message ? e.message : e}) — schedule chips may be orphaned`)
  }
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
  // B5 guard (renderer parity: store/todo.js restoreFromRecycle): startup meta GC may have purged
  // `repeatRule:<rid>` while the row sat in the bin — restoring the dangling repeatId used to let
  // completion fall into ensureNextRepeatInstance's silent !rule return (chain just dies). Demote to
  // non-repeating with the same console warning semantics as the App.
  if (t.repeatId) {
    let rule = null
    try { rule = JSON.parse(db.call('getMeta', 'repeatRule:' + t.repeatId) || 'null') } catch { /* treated as gone */ }
    if (!rule) { merged.repeatId = null; console.error(`warning: restored task ${t.taskId} had a dangling repeatId (rule meta GCed) — restored as a non-repeating task`) }
  }
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
  // D18-DOM2 (#9, App parity store/todo.js purgeIds → writeEventBackup('purge')): write a
  // best-effort pre-purge event snapshot (evt-purge-*.json) BEFORE anything is deleted — the App
  // refuses to purge silently without one, so does the CLI now (loud failure, purge still proceeds:
  // blocking a user's explicit destructive command on a backup IO failure trades one bug for worse).
  // The snapshot is the CLI-side port (renderer ESM/IPC is unreachable from pure Node) — see
  // cli/lib-eventbackup.cjs for the shape/directory contract.
  {
    const db = open()
    const liveRows = db.call('queryTodos', { deleted: 0 })
    const metaEntries = []
    for (const r of rows) {
      for (const k of ['planChipsSnapshot:' + r.taskId, ESTIMATE_KEY_PREFIX + r.taskId]) {
        try { const v = db.call('getMeta', k); if (v != null && v !== '') metaEntries.push({ key: k, value: v }) } catch { /* absent is fine */ }
      }
    }
    const backupDir = String(settingsDoc().backupDir || '') || path.join(userDataDir(), 'backups')
    const snap = writePurgeEventSnapshot({ dir: backupDir, rows, liveRows, metaEntries, reason: 'purge' })
    if (!snap.ok) console.error(`warning: purge proceeded WITHOUT its pre-purge event snapshot (${snap.error}) — no evt-purge-*.json was written to ${backupDir}`)
  }
  // cli-4 (root-cause ordering invariant): IRREVERSIBLE side effects must come AFTER the
  // transactional state change, never before. The old files-first order deleted attachment
  // files and THEN committed the purge — if the commit failed (bus rejection, mid-way error),
  // live recycle-bin rows were left pointing at files that no longer exist: unrecoverable data
  // loss. Rows now die first; a best-effort file pass that fails midway only leaves ORPHANED
  // files (recoverable garbage), never a live row without its files.
  // D18-DOM2 (#10, documented divergence): the MAIN process deliberately does the OPPOSITE order —
  // files BEFORE rows (src/main/handlers/todo.js 'db:purge-recycle-bin', main-ipc-8 invariant:
  // a failed file delete after the commit orphans a private attachment nothing can ever reach,
  // while rows surviving a failed commit merely show "not yet synced"). Each channel's order is
  // load-bearing for its own failure model (CLI = bus commit; main = IPC with a renderer
  // missing-file guard); DO NOT "align" either side without re-deriving both failure models.
  commit('todo', 'purgeBin')
  // Attachment files die after the rows (files/<taskId>_<ts>_<name>, same prefix rule as the
  // App's purgeAttachmentFiles in src/main/index.js).
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
  audit.record({
    action: 'purge',
    changes: rows.map(r => ({ before: r })),
    note: `purged ${rows.length} item(s) (irreversible), ${filesRemoved} attachment file(s) removed` + (msScrubbed ? `, milestone scrub: ${msScrubbed} blob(s)` : '')
  })
  return true
}

/* Subtasks + environment (doctor/launchApp): extracted verbatim to lib-subs.cjs / lib-env.cjs (2026-09-27 size-ratchet split)
   D18-DOM2 #1: the sub module also receives open + the shared renewal helper so checking the last
   unchecked subtask of a repeating parent renews the repeat chain (App parity: every completion route).
   NOTE: kept AFTER the lib-repeat require below — it consumes renewRepeatAfterComplete. */
const { doctor, launchApp } = require('./lib-env.cjs')({ open, CliError, userDataDir, assertIsolationForWrite })

/* ---------------- Tomato/sync command channels: extracted verbatim to lib-channels.cjs (2026-09-27 size-ratchet split) ---------------- */
const {
  writeTomatoCmd, readTomatoState, waitForTomatoAck, tomatoLiveRemainSec,
  writeSyncCmd, readSyncState, waitForSyncAck,
} = require('./lib-channels.cjs')({ open, commit, audit })

/* Categories write: extracted verbatim to lib-categories.cjs (2026-09-27 size-ratchet split) */
const {
  addCategory, renameCategory, deleteCategory, moveCategory, categoryRows, categoryHierarchy,
} = require('./lib-categories.cjs')({ open, commit, audit, CliError, resolveCategory, projectFlagKey, projectStatusKey, MS_KEY, PROJECT_IDS_KEY })

/* Tags + batch operations: extracted verbatim to lib-tags.cjs (2026-09-27 size-ratchet split) */
const {
  listTags, rewriteTag, resolveTaskExact, batchTagOne, batchRun,
} = require('./lib-tags.cjs')({ liveTasks, CliError, patchTodo, toggleComplete, dateChangeReminderPatch, migrateChipsOnDayChange, parseDate, resolveCategory })

/* Saved views (smart lists): extracted verbatim to lib-views.cjs (2026-09-27 size-ratchet split) */
const {
  viewsList, resolveView, viewAdd, viewRm, applyViewConds, viewFetchOpts, viewCondsSummary,
} = require('./lib-views.cjs')({ open, commit, audit, CliError, dayjs, resolveCategory })

/* ---------------- Focus ledger + per-task tomato estimates: extracted verbatim to lib-focus.cjs (2026-09-27 size-ratchet split) ---------------- */

/* ---------------- Manual ordering (taskSort midpoint insertion — same semantics as renderer todo/reorderTodos drag)
   F-B2 (dw wave 3): the score math moved to shared/sort-core.mjs moveWithin (single source with the
   renderer's TodoItem._writeSort reorderScale rewrite); the ±100 no-beyond margin is precision
   degradation only — order can no longer drift between the two ends' scales.
   B2 (2026-09-24): pool + dayOrder are in APP DISPLAY order (taskSort DESCENDING — sortMode.js
   custom mode). moveWithin's `sorts` contract is display order now, so `sort top` lands max+100
   (visually first) instead of the old min-100 (visually last, P1 cross-end inversion). */
/** Reorder <task> relative to: top|bottom|up|down (within its day) or before|after <otherTask> (must share the day/no-date pool) */
function sortTask (input, pos, refInput) {
  const t = resolveTask(input, liveTasks())
  const pool = liveTasks().filter(x => x.dayStart === t.dayStart).sort((a, b) => (b.taskSort || 0) - (a.taskSort || 0))
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
  // Re-read the real persisted order (cannot reuse the pool above — it is a pre-move snapshot; the ★ marker would show at the old position).
  // Reported in App display order (taskSort descending) — B2: the old ascending readout was the
  // App's list printed upside-down.
  const after = liveTasks()
    .filter(x => x.dayStart === t.dayStart)
    .sort((a, b) => (b.taskSort || 0) - (a.taskSort || 0))
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

/** Resolve/fix/remove focus records: extracted verbatim to lib-focus.cjs (2026-09-27 size-ratchet split) */

/* Multiple reminders: extracted verbatim to lib-reminders.cjs (2026-09-27 size-ratchet split) */
const {
  setReminderOffsets, setReminderExtra, reminderDateBackfill,
} = require('./lib-reminders.cjs')({ resolveTask, liveTasks, patchTodo, CliError, dayjs, parseDate })

const settingsApi = require('./lib-settings.cjs')
const { settingsDoc, setSettingsRaceHookForTests, settingsKnown, settingsList, settingsSet, SETTINGS_MANIFEST } = settingsApi({ open, commit, audit, CliError })

/* D18-DOM2 #9: pre-purge event snapshot port (best-effort, loud on failure) — see lib-eventbackup.cjs */
const { writePurgeEventSnapshot } = require('./lib-eventbackup.cjs')

const {
  buildRenewalInstance, buildRepeatRule, repeatOn, renewRepeatAfterComplete, repeatOff, repeatRuleInfo,
} = require('./lib-repeat.cjs')({ open, commit, audit, CliError, dayjs, core, resolveTask, liveTasks, normKey, settingsDoc, chipsSnapshotForDelete, dayStartOf, clampEstimate, getEstimateOf, estimateKey })

/* Day-plan (schedule chips): extracted verbatim to lib-plan.cjs (2026-09-27 size-ratchet split) */
const {
  planSet, planList, planRemove,
} = require('./lib-plan.cjs')({ open, commit, audit, CliError, dayjs, resolveTask, liveTasks, parseDate, dayStartOf })

const evu = require('./event-utils.cjs')
const { eventFocusMinutes, eventEnd } = evu

/* Subtasks (lib-subs.cjs) — required here (AFTER lib-repeat) because checkSubtask consumes the
   shared renewRepeatAfterComplete helper (D18-DOM2 #1); see the note at lib-env above. */
const {
  parseSubs, addSubtask, checkSubtask, removeSubtask, moveSubtask,
} = require('./lib-subs.cjs')({ resolveTask, liveTasks, patchTodo, CliError, open, renewRepeatAfterComplete })

/* ---------------- Events import: rebuild a whole day's schedule from a structured event list (backfill/reconstruction scenarios) ----------------
   Event shape: { date, start, end|24:00, title, category, important, urgent, tags, estimate }
   Idempotent: dedupe by (dayStart, title); tasks already existing are skipped and not created again. */

async function importEvents (events, { onProgress = () => {} } = {}) {
  if (!Array.isArray(events) || !events.length) throw new CliError('events file must be a non-empty JSON array', 'EMPTY_EVENTS')
  const existing = liveTasks()
  const seen = new Set(existing.map(t => t.dayStart + '|' + String(t.taskContent || '').trim()))
  // cli-6: the hasRecord closure was replaced by the materialized boolean at return time (see below).
  let created = 0, skipped = 0, clamped = 0
  const createdIds = []
  const failed = []
  for (const e of events) {
    const label = (e.date || '?') + ' ' + (e.start || '') + ' ' + (e.title || '').slice(0, 24)
    try {
      if (!e.date || !e.start || !e.end || !e.title) throw new CliError('missing date/start/end/title', 'BAD_EVENT')
      // cli-5: strict HH:mm validation BEFORE anything is written — a malformed time ('9:xx',
      // '25:99') used to slip past the truthiness check and create a task with NaN-derived times.
      // Bad events now land in `failed` like every other rejected event.
      const startT = evu.parseHHmm(e.start)
      if (!startT) throw new CliError('bad start time "' + e.start + '" (expect HH:mm 00:00-23:59)', 'BAD_EVENT')
      const endT = evu.parseHHmm(e.end, { allow24: true })
      if (!endT) throw new CliError('bad end time "' + e.end + '" (expect HH:mm 00:00-23:59 or 24:00)', 'BAD_EVENT')
      const key = evu.eventKey(e, dayStartOf, parseDate)
      if (seen.has(key)) { skipped++; onProgress({ label, status: 'skipped-task' }); continue }
      const { h: h1, m: m1 } = startT
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
      createdIds.push(t.taskId)
      // B14 (2026-09-24): estimate>20 is no longer clamped SILENTLY (Math.min(20, …) reported
      // success while a different estimate landed — the same failure mode backfillRecord's
      // over-cap throw fixes). The row-level clamp (setEstimate → clampEstimate) still applies;
      // the event is imported, but the clamp is surfaced via onProgress and a `clamped` count
      // in the return value (event-level `failed` would overstate — the task itself succeeded).
      if (e.estimate) {
        const want = Number(e.estimate) || 0
        try { setEstimate(t.taskId, want) } catch (er) { /* non-fatal */ }
        if (want > ESTIMATE_MAX) { clamped++; onProgress({ label, status: 'estimate-clamped', wanted: want, stored: ESTIMATE_MAX }) }
      }
      // Behavior fix (2026-09-16): a FUTURE event used to be imported as completed + with a backfilled focus
      // record — importing next week's schedule fabricated "done + accounted" history for work not yet done.
      // Future events now only create the task; completion and the ledger row are left to the real day.
      // D11 fix (2026-09-28): compare parsed TIMESTAMPS, not raw strings — a loose date like '2026-9-28'
      // sorts before '2026-09-28' lexicographically, so an actually-future event was misjudged as past
      // and got backfilled completion + a fabricated focus ledger row. Unparseable dates (NaN) are
      // treated as future: without a real day there is no basis to fabricate "done" history.
      const evDay = dayStartOf(parseDate(e.date))
      const future = !(evDay > 0 && evDay <= dayStartOf(Date.now()))
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
  // cli-6: hasRecord used to be returned as a LIVE CLOSURE — a function on the result object.
  // Nothing JSON-serializes a function, so every consumer that emitted/serialized the result
  // silently dropped the field, and `res.hasRecord` reads as `function` not data. Materialize it:
  // a plain boolean re-read from the ledger at return time (the d4 re-read property is preserved — it now sees rows the import itself just created).
  const hasRecord = createdIds.some(tid => (tomatoRecords() || []).some(r => r.manual && r.focusTaskId === tid))
  return { created, skipped, clamped, failed, total: events.length, hasRecord }
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
  CliError, commit, open, parseDate, dayStartOf, launchApp, userDataDir, hasIsolationEnv, assertIsolationForWrite, guessUserId, compareVersions,
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
  setReminderOffsets, setReminderExtra, reminderDateBackfill, addAttachment, listAttachments, removeAttachment,
  settingsList, settingsSet, settingsDoc, setSettingsRaceHookForTests, planSet, planList, planRemove, dateChangeReminderPatch,
  SETTINGS_MANIFEST, settingsKnown, normKey, buildRenewalInstance,
  importEvents, eventFocusMinutes, eventKey
}
