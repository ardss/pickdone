/**
 * App-side audit log — appends renderer-initiated writes to the SAME JSONL trail the CLI writes
 * (userData/cli-audit.jsonl, 5MB rotation to timestamped archives cli-audit.jsonl.<ms> with the newest 4 kept,
 * line schema { ts, time, actor, action, argv, targets, changes, note }).
 *
 * actor is 'app' (vs the CLI's 'cli') so the existing CLI `log` command renders both origins from one file.
 * No double-logging by construction: CLI write commands hit db.js directly inside the CLI process
 * (cli/lib.js → dbm.call) and never pass through the App's todo-db:call IPC handler — this hook cannot see them.
 * Audit failures never affect business writes: every entry point is defensively wrapped, fire-and-forget.
 *
 * Path injection: resolveDir is overridable (setDirResolver) so unit tests run without Electron.
 * The main process entry (src/main/index.js) installs () => app.getPath('userData') so that
 * app.setPath('userData', TODO_USER_DATA_DIR) test isolation is honored. The default mirrors
 * cli/lib.js userDataDir() (TODO_DB_DIR > TODO_USER_DATA_DIR > %APPDATA%/pickdone).
 */
const path = require('path')
const fs = require('fs')
const dayjs = require('dayjs')
const { userDataDir } = require('./user-dir.js') // P3-9 (dw wave): single source — same env priority chain cli/lib.js reads
// F-B6/F-B8 (dw wave 3): rotation + snapshot vocabulary single-sourced with the CLI (shared/audit-rotate.cjs) —
// both ends rotate the SAME cli-audit.jsonl from different processes, so the CLI now runs this same
// non-destructive timestamped rotation, and both share one SNAPSHOT_FIELDS/snapshot definition.
const { rotateArchive, snapshot, capContent } = require('../../shared/audit-rotate.cjs')

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024
let maxBytes = MAX_BYTES_DEFAULT

const defaultDirResolver = userDataDir
let resolveDir = defaultDirResolver

/** Test/injection hook: override the output directory (lazy — called at write time, not at injection time) */
function setDirResolver (fn) { if (typeof fn === 'function') resolveDir = fn }
/** Test hook: shrink the rotation threshold so the boundary is reachable with tiny writes */
function setMaxBytes (n) { if (Number.isFinite(n) && n > 0) maxBytes = n }
/** Test hook: restore default resolver and threshold (flushes the buffer first so assertions see every line) */
function resetForTests () { flushNow(); resolveDir = defaultDirResolver; maxBytes = MAX_BYTES_DEFAULT }

function auditFile () {
  return path.join(resolveDir(), 'cli-audit.jsonl')
}

/* ================= op → semantic action ================= */

// Explicit op → CLI-audit-vocabulary action map for the renderer-facing surface. Source of truth for op
// names: ALLOWED_RENDERER_OPS in src/main/index.js (mirrored in renderer/js/contracts.d.ts DbCallOp).
// Action names reuse the existing CLI audit vocabulary (cli/lib.js record() call sites, cli/pickdone.js
// `log --action`); ops with no CLI precedent get new dotted names in the same style.
const ACTION_BY_OP = {
  upsert: 'edit',                    // refined by actionFor via the pre-write row: add/done/undo/delete/restore/subtask
  upsertMany: 'edit',                // bulk; refined to add/delete only when every row agrees
  hardDelete: 'purge',               // permanent removal (recycle-bin "delete permanently"); CLI 'purge' = irreversible
  hardDeleteMany: 'purge',
  upsertCategory: 'category.upsert', // renderer re-upserts the whole category list on save; add vs rename not distinguishable without an extra read
  filterUpsert: 'view.add',          // saved smart-list filter created/updated (no CLI precedent)
  filterDelete: 'view.rm',
  bumpSnow: 'tomato.bump',           // focus minutes credited to a task on pomodoro completion
  planAddMany: 'plan.set',
  planUpdateChip: 'plan.set',
  planMoveTask: 'plan.move',         // rescheduling a task across timeline days (no CLI precedent)
  planRemoveIds: 'plan.remove',
  planDeleteTask: 'plan.remove',
  planDeleteTaskDay: 'plan.remove',
  planPrune: 'plan.prune',           // expired day-bucket cleanup (no CLI precedent)
  tomatoAppendMany: 'tomato.append', // focus ledger rows (CLI ledger ops are tomato.backfill/record-fix/record-remove)
  tomatoUpdateById: 'tomato.update',
  tomatoRemoveByIds: 'tomato.remove',
  tomatoMigrateFromMeta: 'tomato.migrate',
  setMeta: 'meta.set',               // refined: repeatRule:* → repeat.on/off, projectDeadline:* → project.deadline
  deleteMeta: 'meta.rm'
}

// Settings/habits mirror blobs (renderer persists the whole state, debounced, on every change) — pure noise.
// 'habitsState' (bare): pre-rename installs persisted the habits blob under this key; both spellings are noise (2026-09-19)
const MIRROR_KEY_SKIP = new Set(['db.settingsState', 'db.habitsState', 'habitsState'])

/** Best-effort meta key extraction: the renderer passes [key, value], db.js also accepts bare key or {key} */
function metaKeyOf (params) {
  if (Array.isArray(params)) return params[0]
  if (typeof params === 'string') return params
  if (params && typeof params === 'object') return params.key
  return null
}

/** Decision point for the todo-db:call hook (pure, Electron-free). Reads and unknown ops leave no line. */
function shouldAudit (op, params) {
  try {
    if (!ACTION_BY_OP[op]) return false
    if (op === 'setMeta') return !MIRROR_KEY_SKIP.has(metaKeyOf(params))
    return true
  } catch (e) { return false }
}

// Fields whose change makes an upsert a real 'edit' (everything except subtasks) — mirrors the CLI's
// semantic snapshot interest (cli/audit.js SNAPSHOT_FIELDS, now shared/audit-rotate.cjs) minus subtasks itself.
const EDIT_FIELDS = [
  'taskContent', 'taskDescribe', 'complete', 'completedAt', 'todoTime', 'reminderTime',
  'reminderOffsets', 'reminderExtra', 'dayStart', 'deletedAt', 'priority', 'deadlineTs',
  'important', 'urgent', 'categoryId', 'repeatId', 'delete', 'status'
]

// F-B6: SNAPSHOT_FIELDS + snapshot() moved verbatim to shared/audit-rotate.cjs (single source with
// cli/audit.js, with the F-B8 content cap applied inside snapshot()).

function sameValue (a, b) { return JSON.stringify(a) === JSON.stringify(b) }

/** True when only the subtasks JSON changed between the pre-write and post-write row (best-effort: key order differences fall back to 'edit') */
function subtasksOnlyChange (before, after) {
  if (!sameValue(before.subtasks, after.subtasks)) {
    for (const k of EDIT_FIELDS) {
      if (!sameValue(before[k], after[k])) return false
    }
    return true
  }
  return false
}

/** Refine the action for op='upsert' using the pre-write row captured by the IPC handler (null = unavailable) */
function upsertAction (row, before) {
  if (!row || typeof row !== 'object') return 'edit'
  if (before && typeof before === 'object') {
    if (before.delete && !row.delete) return 'restore'
    if (!before.delete && row.delete) return 'delete'
    if (!before.complete && row.complete) return 'done'
    if (before.complete && !row.complete) return 'undo'
    if (subtasksOnlyChange(before, row)) return 'subtask'
    return 'edit'
  }
  // No pre-write snapshot: fall back to the row's own sync status field (add/update/delete)
  if (row.status === 'add') return 'add'
  if (row.status === 'delete') return 'delete'
  return 'edit'
}

function upsertManyAction (rows) {
  if (!Array.isArray(rows) || !rows.length) return 'edit'
  const all = fn => rows.every(fn)
  if (all(r => r && r.status === 'add' && !r.delete)) return 'add'
  if (all(r => r && (r.delete || r.status === 'delete'))) return 'delete'
  return 'edit'
}

/** Pure op+params(+pre-write row) → action name. Never throws. */
function actionFor (op, params, before) {
  try {
    if (op === 'upsert') return upsertAction(params, before)
    if (op === 'upsertMany') return upsertManyAction(params)
    if (op === 'setMeta') {
      const key = String(metaKeyOf(params) || '')
      if (key.startsWith('repeatRule:')) {
        const v = Array.isArray(params) ? params[1] : null
        return (v === '' || v == null) ? 'repeat.off' : 'repeat.on'
      }
      if (key.startsWith('projectDeadline:')) return 'project.deadline'
      return 'meta.set'
    }
    return ACTION_BY_OP[op] || 'edit'
  } catch (e) { return 'edit' }
}

/* ================= targets / changes / note (best-effort, never throw) ================= */

const TARGET_CAP = 50 // batch ops cap the target list; the note carries the full count when relevant

function asId (v) { return v == null ? null : String(v) }

function target (taskId, content) {
  const t = {}
  if (taskId != null) t.taskId = String(taskId)
  // F-B8: target content is capped like snapshot content (audit must not be a plaintext history)
  if (content != null && content !== '') t.content = capContent(content)
  return Object.keys(t).length ? t : null
}

/** Best-effort todo id(s) from the call params. Chip/filter row ids are namespaced ('filter:3') mirroring the CLI's 'cat:<id>' convention. */
function targetsFor (op, params, result) {
  try {
    const out = []
    switch (op) {
      case 'upsert':
        if (params && typeof params === 'object') out.push(target(params.taskId, params.taskContent))
        break
      case 'upsertMany':
        if (Array.isArray(params)) for (const r of params.slice(0, TARGET_CAP)) out.push(target(r && r.taskId, r && r.taskContent))
        break
      case 'hardDelete':
        out.push(target(typeof params === 'object' && params ? params.taskId : params))
        break
      case 'hardDeleteMany':
        if (Array.isArray(params)) for (const id of params.slice(0, TARGET_CAP)) out.push(target(id))
        break
      case 'bumpSnow':
        if (params && typeof params === 'object') out.push(target(params.taskId))
        break
      case 'planAddMany':
        if (Array.isArray(params)) for (const c of params.slice(0, TARGET_CAP)) out.push(target(c && c.taskId))
        break
      case 'planMoveTask':
      case 'planDeleteTask':
      case 'planDeleteTaskDay':
        if (params && typeof params === 'object') out.push(target(params.taskId))
        else out.push(target(params))
        break
      case 'upsertCategory':
        if (params && typeof params === 'object') out.push(target('cat:' + params.id, params.name))
        break
      case 'filterUpsert':
        out.push(target('filter:' + asId(result || (params && params.id) || 'new'), params && params.name))
        break
      case 'filterDelete':
        out.push(target('filter:' + asId(typeof params === 'object' && params ? params.id : params)))
        break
      case 'tomatoAppendMany':
        if (Array.isArray(params)) for (const r of params.slice(0, TARGET_CAP)) out.push(target((r && (r.focusTaskId || r.tomatoId))))
        break
      case 'tomatoUpdateById':
        if (params && typeof params === 'object') out.push(target(params.tomatoId))
        break
      case 'tomatoRemoveByIds':
        if (Array.isArray(params)) for (const id of params.slice(0, TARGET_CAP)) out.push(target(id))
        break
      // planUpdateChip/planRemoveIds/planPrune carry chip row ids / counts, not todo ids; setMeta/deleteMeta
      // keys go to the note instead — all leave targets empty (the CLI log rendering tolerates that).
      default:
        break
    }
    return out.filter(Boolean)
  } catch (e) { return [] }
}

/** changes: only the upsert path has a meaningful before/after pair (the handler captures the pre-write row); everything else is []. */
function changesFor (op, params, before) {
  try {
    if (op !== 'upsert' || !before || typeof before !== 'object') return []
    if (!params || typeof params !== 'object') return []
    return [{ taskId: params.taskId || before.taskId, before: snapshot(before), after: snapshot(params) }]
      .filter(c => c.before || c.after)
  } catch (e) { return [] }
}

function noteFor (op, params, result) {
  try {
    if (op === 'setMeta') return 'meta key ' + String(metaKeyOf(params))
    if (op === 'deleteMeta') return 'meta key removed: ' + String(metaKeyOf(params))
    if (op === 'bumpSnow' && params && typeof params === 'object' && params.minutes != null) return '+' + params.minutes + 'min focus credit'
    if (op === 'planMoveTask' && params && typeof params === 'object') return String(params.fromDay) + ' → ' + String(params.toDay)
    if (op === 'planPrune' && result != null) return 'pruned ' + result + ' chip row(s)'
    if (op === 'tomatoMigrateFromMeta' && result != null) return 'migrated ' + result + ' ledger row(s) from meta blob'
    if (op === 'hardDeleteMany' && Array.isArray(params) && params.length > TARGET_CAP) return params.length + ' task(s) permanently removed (first ' + TARGET_CAP + ' listed)'
    return undefined
  } catch (e) { return undefined }
}

/* ================= append (F-B6 rotation single source; F-B7 buffered async flush) ================= */

/** F-B7 (dw wave 3): appendEntry used to run mkdirSync + statSync + appendFileSync on EVERY audited
 *  op (handlers/todo.js fires per write op) — three blocking syscalls on the main-process event
 *  loop per write, with the mkdirSync pure redundancy. Now: directory ensured once per process,
 *  entries buffered in-process and drained as ONE fs.appendFile batch on a short timer (threadpool,
 *  non-blocking), rotation checked once per flush instead of per entry. Durability: quit-flush via
 *  process 'exit' (synchronous — async writes cannot complete during exit) plus an explicit
 *  flushNow() seam for tests/upgrade paths. A failed async batch retries once synchronously; if
 *  that fails too the lines are dropped by the fire-and-forget contract (audit never blocks writes).
 */
const FLUSH_DELAY_MS = 100
const FLUSH_BATCH_MAX = 64
let buffer = []
let flushTimer = null
let dirReady = false

function ensureDir () {
  if (dirReady) return
  try { fs.mkdirSync(path.dirname(auditFile()), { recursive: true }) } catch { /* best-effort */ }
  dirReady = true
}

function rotateIfNeeded () {
  try {
    const st = fs.statSync(auditFile())
    if (st.size > maxBytes) rotateArchive(auditFile())
  } catch (e) { /* no file on first write */ }
}

/** Split buffered lines into ≤maxBytes chunks, rotating between chunks — preserves the old
 *  per-line "rotate when the file exceeds the threshold" semantics while still writing each
 *  chunk as ONE append call. */
function chunkByThreshold (lines) {
  const chunks = []
  let cur = []
  let bytes = 0
  for (const line of lines) {
    if (cur.length && bytes + line.length > maxBytes) { chunks.push(cur); cur = []; bytes = 0 }
    cur.push(line)
    bytes += line.length + 1
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** Drain the buffer synchronously (quit path / tests). */
function flushNow () {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  if (!buffer.length) return
  const lines = buffer.splice(0).map(e => JSON.stringify(e) + '\n')
  ensureDir()
  for (const chunk of chunkByThreshold(lines)) {
    try { rotateIfNeeded() } catch (e) { /* rotation failure must not lose the batch */ }
    const text = chunk.join('')
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.appendFileSync(auditFile(), text); break } catch (e) { if (attempt > 0) return /* give up by contract */ }
    }
  }
}

/** Drain the buffer as one async appendFile batch per threshold chunk. */
function flushAsync () {
  flushTimer = null
  if (!buffer.length) return
  const lines = buffer.splice(0).map(e => JSON.stringify(e) + '\n')
  ensureDir()
  for (const chunk of chunkByThreshold(lines)) {
    try { rotateIfNeeded() } catch (e) { /* rotation failure must not lose the batch */ }
    const text = chunk.join('')
    fs.appendFile(auditFile(), text, err => {
      if (err) { try { fs.appendFileSync(auditFile(), text) } catch { /* dropped by contract */ } }
    })
  }
}

// Quit flush: synchronous drain so buffered entries survive process exit (Electron main included)
process.on('exit', () => { try { flushNow() } catch { /* never throw on exit */ } })

function appendEntry (entry) {
  // review P2 (2026-09-10): the CLI rotates the same file concurrently — an append landing inside the
  // other process's rename window used to throw and the line was lost (fire-and-forget). The batch
  // retry logic in flushAsync/flushNow keeps that single-retry-with-fresh-stat behavior.
  try {
    buffer.push(entry)
    if (buffer.length >= FLUSH_BATCH_MAX) flushAsync()
    else if (!flushTimer) flushTimer = setTimeout(flushAsync, FLUSH_DELAY_MS)
  } catch (e) { /* audit failure never affects business writes */ }
}

/**
 * Record one renderer-initiated operation. Called from the todo-db:call handler AFTER dbm.call succeeded
 * (so failed ops never leave a line). opts.before: pre-write todo row for op='upsert' (captured by the
 * handler before the write lands); opts.result: the db op's return value (used for ids/counts).
 * Fire-and-forget: never throws, audit failures never block the IPC path.
 */
function recordAppOp (op, params, opts) {
  try {
    if (!shouldAudit(op, params)) return
    const before = opts && opts.before
    const result = opts && opts.result
    appendEntry({
      ts: Date.now(),
      time: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      actor: 'app',
      action: actionFor(op, params, before),
      argv: [op],
      targets: targetsFor(op, params, result),
      changes: changesFor(op, params, before),
      note: noteFor(op, params, result)
    })
  } catch (e) { /* audit failure never affects business writes */ }
}

/** Record a main-process write that does NOT flow through todo-db:call (e.g. import:run's bulk insert) —
 *  same line schema, explicit action. Fire-and-forget by the caller's contract. */
function recordCustom (action, argv, targets, changes, note) {
  try {
    appendEntry({
      ts: Date.now(),
      time: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      actor: 'app',
      action,
      argv,
      targets: targets || [],
      changes: changes || [],
      note
    })
  } catch (e) { /* audit failure never affects business writes */ }
}

module.exports = {
  recordAppOp,
  recordCustom,
  shouldAudit,
  actionFor,
  auditFile,
  setDirResolver,
  setMaxBytes,
  resetForTests,
  flushNow,
  MAX_BYTES_DEFAULT
}
