/**
 * Database disaster recovery + atomic disaster-backup write — extracted from index.js into a pure fs module testable in isolation.
 * Tiered recovery: todos.db corrupted → rename the corrupt file to preserve it → prefer the local plaintext backup (todos.db.plain-bak),
 * otherwise re-import the task list from the disaster-backup JSON (critical-state-backup.json).
 */
const fs = require('fs')
const path = require('path')

/** Blob format versions recognizable by the recovery path: corresponds to the schemaV written by each renderer store.
 *  A segment without schemaV is treated as v1 (legacy data compatibility); > 1 = data from a future version being restored by the current one — reject importing that segment (prevents downgrade misreads). */
const SUPPORTED_SCHEMA_V = 1
let _log = null
function logWarn (...args) {
  try {
    if (!_log) _log = require('electron-log')
    if (_log && _log.warn) return _log.warn(...args)
  } catch { /* electron-log unavailable (unit tests) */ }
  console.warn(...args)
}

/** Parse a segment of the backup JSON (two shapes: string/object); reject and return null when schemaV exceeds the supported version */
function parseSegment (seg, label) {
  let obj = seg || {}
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return {} }
  }
  if (obj && typeof obj === 'object' && (obj.schemaV || 1) > SUPPORTED_SCHEMA_V) {
    logWarn(`[dbRecovery] ${label}.schemaV=${obj.schemaV} is newer than the currently supported version ${SUPPORTED_SCHEMA_V}, refusing to import this segment (downgrade misread prevention)`)
    return null
  }
  return obj
}

/** Where the disaster-backup JSON lives: by default externalized to pickdone-backups in the userData parent directory (separated from the DB, recoverable even if userData is wiped);
 *  legacy compatibility: when the external location does not exist, fall back to the old userData/critical-state-backup.json (first recovery after an old instance upgrades still works). */
function criticalBackupPath (ud) {
  const external = path.join(path.dirname(ud), 'pickdone-backups', 'critical-state-backup.json')
  if (fs.existsSync(external)) return external
  const legacy = path.join(ud, 'critical-state-backup.json')
  if (fs.existsSync(legacy)) return legacy
  return external // when neither exists, return the new default write location
}

/** Tiered recovery of a corrupted DB: returns {source,label} (source ∈ 'plain-bak'|'json'; null = nothing recoverable).
 *  source is the structured branch flag — display strings must never drive logic (a copy rewrite once silently killed the JSON branch). Corrupt files are always renamed and preserved, never deleted. */
/** 恢复优先级 = JSON 优先于 plain-bak(2026-09-04 深审 P0 倒置修复):critical JSON 是渲染端持续覆盖的最新快照,
 *  .plain-bak 是加密迁移那一刻的一次性快照、之后永不更新——旧的"plain-bak 优先"会在迁移一年后损坏时恢复一年前数据。
 *  .corrupt-* 现场只保留最近 3 套,更早的删除(无限累积曾无治理)。 */
function attemptDbRecovery (ud) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Confirm a recoverable source exists before renaming: transient IO errors (disk full/lock held) also make init fail; renaming unconditionally
  // would mislabel the user's current database as .corrupt and fall back to a stale backup or even an empty DB
  const plainBakExists = fs.existsSync(path.join(ud, 'todos.db.plain-bak'))
  const jsonExists = fs.existsSync(criticalBackupPath(ud))
  if (!plainBakExists && !jsonExists) return null
  for (const suf of ['', '-wal', '-shm']) {
    const src = path.join(ud, 'todos.db' + suf)
    if (fs.existsSync(src)) { try { fs.renameSync(src, src + '.corrupt-' + stamp) } catch {} }
  }
  try { fs.renameSync(path.join(ud, 'db.key'), path.join(ud, 'db.key.corrupt-' + stamp)) } catch {}
  pruneCorruptScenes(ud)
  if (jsonExists) return { source: 'json', label: 'disaster-backup JSON (fresh)' }
  fs.copyFileSync(path.join(ud, 'todos.db.plain-bak'), path.join(ud, 'todos.db'))
  return { source: 'plain-bak', label: 'local plaintext backup (todos.db.plain-bak, possibly stale)' }
}

/** 只保留最近 3 套 .corrupt-<stamp> 现场文件,按 stamp 分组,更早的删除 */
function pruneCorruptScenes (ud, keep = 3) {
  try {
    const byStamp = new Map()
    for (const f of fs.readdirSync(ud)) {
      const i = f.indexOf('.corrupt-')
      if (i < 0) continue
      const stamp = f.slice(i + '.corrupt-'.length)
      if (!byStamp.has(stamp)) byStamp.set(stamp, [])
      byStamp.get(stamp).push(f)
    }
    const stamps = [...byStamp.keys()].sort()
    for (const s of stamps.slice(0, Math.max(0, stamps.length - keep))) {
      for (const f of byStamp.get(s)) { try { fs.rmSync(path.join(ud, f), { force: true }) } catch {} }
    }
  } catch { /* 清理失败不阻断恢复 */ }
}

/** Re-import from the disaster-backup JSON: merge todoList+recycleList, filter rows without id, return the number imported; returns 0 on any error.
 *  upsertCategory (optional) enables category restore (categories written back together, preventing "tasks returned but categories all gone").
 *  appendTomatoRecords (optional) enables ledger restore from backup.tomatoRecords row set (2026-09-04 起三处 dump 均带账本段;
 *  旧行表化前备份只有 tomatoState blob——那里面已无记录,跳过不报错)。appendMany = tomato_records 幂等 UPSERT,行表已有数据也不双账。
 *  Still not restored on this path: habits/moments (habitsState), settings (settingsState) — renderer-owned semantics. */
function restoreTasksFromCriticalBackup (ud, upsertMany, upsertCategory, appendTomatoRecords) {
  try {
    const raw = JSON.parse(fs.readFileSync(criticalBackupPath(ud), 'utf8'))
    // todoState has two real shapes: the renderer's writeCriticalBackup stores a JSON string (nested via JSON.stringify),
    // while some old drill data is an object. Previously only objects were accepted — real disaster backups would silently import 0 rows (confirmed by the round-trip test 2026-09-01).
    let todoState = parseSegment(raw.backup && raw.backup.todoState, 'todoState')
    if (todoState === null) todoState = {} // schemaV too high: skip the task segment, process the rest as usual
    const list = ((todoState.todoList || []).concat(todoState.recycleList || [])).filter(t => t && t.taskId)
    if (list.length) upsertMany(list)
    restoreCategoriesFromCriticalBackup(raw, upsertCategory)
    restoreTomatoRecordsFromCriticalBackup(raw, appendTomatoRecords)
    return list.length
  } catch { return 0 }
}

/** Ledger restore: backup.tomatoRecords is the row-table row set (JSON string or array). Rows missing tomatoId/endTime are skipped;
 *  single-row failure does not drag down the batch. No-op when callback absent or segment missing (old backups). */
function restoreTomatoRecordsFromCriticalBackup (raw, appendTomatoRecords) {
  if (typeof appendTomatoRecords !== 'function') return 0
  try {
    const seg = parseSegment(raw.backup && raw.backup.tomatoRecords, 'tomatoRecords')
    if (seg === null) return 0
    const rows = (Array.isArray(seg) ? seg : []).filter(r => r && r.tomatoId && r.endTime)
    if (!rows.length) return 0
    try { appendTomatoRecords(rows) } catch { return 0 }
    return rows.length
  } catch { return 0 }
}

/** Category restore: categoryState shares todoState's shape (string/object, two real forms). Rows are in renderer app shape
 *  (categoryId/categoryName/...), mapped back to db.js categories table rows then upserted (fresh DB = pure insert, idempotent);
 *  a single-row failure is skipped without dragging down the whole batch. No writes when the JSON has no category data. */
function restoreCategoriesFromCriticalBackup (raw, upsertCategory) {
  if (typeof upsertCategory !== 'function') return 0
  try {
    const catState = parseSegment(raw.backup && raw.backup.categoryState, 'categoryState')
    if (catState === null) return 0 // schemaV too high: skip the category segment (no import, no throw)
    const cats = ((catState && catState.list) || []).filter(c => c && c.categoryId != null)
    let n = 0
    for (const c of cats) {
      try {
        upsertCategory({
          id: c.categoryId,
          userId: c.userId != null ? c.userId : null,
          name: c.categoryName != null ? String(c.categoryName) : '',
          color: c.categoryColor || '',
          createdAt: c.createTime || 0,
          sort: c.listSort || 0,
          isFolder: c.folderIs ? 1 : 0,
          parentId: c.folderId || 0,
          deleted: c.delete ? 1 : 0
        })
        n++
      } catch {}
    }
    return n
  } catch { return 0 }
}

/** Atomic disaster-backup write: temp file + rename within the same directory, preventing an interruption from corrupting the backup file itself.
 *  dest is decided by the caller (the main process currently passes the external default root pickdone-backups); the directory is created first if missing. */
function writeCriticalStateBackupAtomic (ud, jsonText) {
  fs.mkdirSync(ud, { recursive: true })
  const dest = path.join(ud, 'critical-state-backup.json')
  const tmp = dest + '.tmp'
  fs.writeFileSync(tmp, jsonText)
  fs.renameSync(tmp, dest)
  return dest
}

module.exports = { attemptDbRecovery, restoreTasksFromCriticalBackup, writeCriticalStateBackupAtomic, criticalBackupPath, restoreCategoriesFromCriticalBackup, restoreTomatoRecordsFromCriticalBackup }
