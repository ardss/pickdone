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

/** Where the disaster-backup JSON lives. P0 root fix (2026-09-26, backup-path-fork): the reader
 *  used to hand-copy the OLD pre-migration derivation (parent-of-userData/pickdone-backups +
 *  legacy <userData>/critical-state-backup.json) while the writer moved to
 *  defaultBackupRootCandidates(ud)[0] = <userData>/backups — the recovery chain could never find
 *  the snapshot on any fresh install (and migrateLegacyBackups actively emptied the one directory
 *  this reader still watched). Now the reader consumes the SAME single source (backup-roots.cjs),
 *  keeping the legacy <userData>/critical-state-backup.json as an extra fallback checked last, and
 *  reporting candidates[0] (the write location) when nothing exists. */
function criticalBackupPath (ud) {
  const candidates = require('./backup-roots.cjs').defaultBackupRootCandidates(ud)
    .map(root => path.join(root, 'critical-state-backup.json'))
  const legacy = path.join(ud, 'critical-state-backup.json')
  for (const f of [...candidates, legacy]) {
    if (fs.existsSync(f)) return f
  }
  return candidates[0] // when neither exists, return the default write location
}

/** P2 fix (2026-09-26, json-exists-vs-parseable): whole-file parseability gate for the disaster
 *  backup. Existence alone made a torn/corrupt JSON yield source:'json' → an "empty DB recovery"
 *  that also STEERED away from a usable todos.db.plain-bak. An object shape (raw && object) is the
 *  plausible-backup bar; per-segment tolerance stays in the restore functions (parseSegment). */
function backupJsonParseable (file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return !!(raw && typeof raw === 'object')
  } catch { return false }
}

/** SQLite files start with the 16-byte magic "SQLite format 3\0". A todos.db whose header still
 *  carries the magic is NOT corrupt — an init failure over it was transient (lock held, WAL race,
 *  disk pressure) and renaming it aside would destroy the user's real data in exchange for a stale
 *  backup. Best-effort: unreadable/short file → header treated as bad. */
const SQLITE_MAGIC = 'SQLite format 3\x00'
function sqliteHeaderOk (file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(16)
      const bytesRead = fs.readSync(fd, buf, 0, 16, 0) // fs.readSync returns the byte count directly
      return bytesRead === 16 && buf.toString('binary') === SQLITE_MAGIC
    } finally { fs.closeSync(fd) }
  } catch { return false }
}

/** Pure mapping of the startup recovery dialog's (recovered, choice) → action, extracted from
 *  index.js (2026-09-25) so the button table and its branch chain stay in lockstep and the map
 *  is unit-testable without Electron. Buttons (index.js, same order):
 *    recovered:   [btnRecoverRelaunch, btnOpenDataDir, btnQuit]
 *    !recovered:  [btnOpenDataDirBackup, btnResetRelaunch, btnQuit]
 *  Fix 2026-09-25 (P1): the recovered choice===1 button promised "open data dir" but the old
 *  inline chain only ran app.quit() — shell.openPath was never called on that branch. */
function recoveryDialogAction (recovered, choice) {
  if (recovered) {
    if (choice === 0) return 'relaunch'
    if (choice === 1) return 'open-data-dir' // caller does shell.openPath(ud) then app.quit()
    return 'quit'
  }
  if (choice === 0) return 'open-data-dir' // caller does shell.openPath(ud) then app.quit()
  if (choice === 1) return 'reset-and-relaunch'
  return 'quit'
}

/** Vendor driver, resolved the same way db.js resolves it (repo vendor/ in dev, resourcesPath is
 *  handled by db.js itself — this pure module only ever runs against the repo layout in tests and
 *  the packaged layout always has vendor/ next to app root). Null when unavailable: the probe then
 *  answers 'unknown' and the caller stays CONSERVATIVE (never destroys data on an inconclusive probe). */
function loadVendorDriver () {
  // Packaged layout (mirror of db.js loadDriver): the driver lives in extraResources at
  // resources/vendor — the repo-relative path below does not exist inside app.asar, so without
  // this branch the probe could never answer 'yes'/'no' in a packaged build and a genuinely
  // corrupt encrypted db stayed 'unknown' (recovery path unreachable in the wild).
  const candidates = []
  try { if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor', 'better-sqlite3-multiple-ciphers')) } catch { /* non-Electron runtime without the field */ }
  candidates.push(path.join(__dirname, '..', '..', 'vendor', 'better-sqlite3-multiple-ciphers'))
  for (const root of candidates) {
    try { return require(root) } catch { /* try next candidate */ }
  }
  return null
}

/** P2 (dw wave5 2026-09-24): the plaintext-magic header guard is ALWAYS false for this repo's
 *  steady state — a multiple-ciphers encrypted todos.db starts with CIPHERTEXT, not the magic.
 *  This probe decides "is the db actually readable with its key": readonly open + PRAGMA key +
 *  a real read of sqlite_master (decryption happens on first page read, journal_mode alone does
 *  not throw — same probe shape as db.js's open path). Answers:
 *    'yes'     decryptable → the db is healthy; init failure was transient → NEVER rename/rollback
 *    'no'      key present but the file cannot be decrypted → genuinely corrupt → recovery may proceed
 *    'unknown' driver unavailable / key unreadable → inconclusive → caller must stay conservative
 *  Key validity rule mirrors db.js: a non-64-hex db.key is treated as no-key (plaintext-continuation). */
function encryptedProbe (file, keyFile) {
  const Database = loadVendorDriver()
  if (!Database) return 'unknown'
  let key
  // F20 (dw wave6 2026-09-24): a key-read IO failure (AV/lock瞬时占用 — existsSync at the caller
  // already passed) used to map to 'no' = "genuinely corrupt", which re-opened the wave5 hole:
  // a HEALTHY db got renamed + rolled back to a stale backup through this side door. Unreadable
  // key is exactly the 'unknown' case this comment block always promised ("key unreadable → stay
  // conservative"); only a READABLE key that is not 64-hex counts as keyless ('no').
  try { key = fs.readFileSync(keyFile, 'utf8').trim() } catch { return 'unknown' }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return 'no' // corrupt key = db.js treats it as keyless; header rules apply
  let db
  try {
    db = new Database(file, { readonly: true })
    try {
      db.pragma(`key='${key}'`)
      db.prepare('SELECT count(*) FROM sqlite_master').get()
      return 'yes'
    } finally { try { db.close() } catch { /* already closed on probe failure */ } }
  } catch { return 'no' }
}

/** M-1 (2026-09-20): make sure a stale db.key is OUT of the way before the restored (plaintext)
 *  DB is reopened. Consistent with the plaintext-continuation contract ("a missing db.key leaves
 *  the fresh DB plaintext-readable, same as a fresh install"): prefer renaming aside (preserves
 *  forensic evidence), fall back to rename-with-.bad suffix, then to deletion. Returns true when
 *  the key is gone or never existed; false when every strategy failed — the caller must then NOT
 *  claim recovery success. Exported for unit tests (failure injection). */
function quarantineKey (ud, stamp) {
  const key = path.join(ud, 'db.key')
  if (!fs.existsSync(key)) return true // already plaintext-continuation shaped
  for (const suffix of ['.corrupt-' + stamp, '.bad-' + stamp]) {
    try { fs.renameSync(key, key + suffix); return true } catch { /* locked/AV-held: try next strategy */ }
  }
  try { fs.rmSync(key, { force: true }); return !fs.existsSync(key) } catch { return false }
}

/** Tiered recovery of a corrupted DB: returns {source,label} (source ∈ 'plain-bak'|'json'|'transient'; null = nothing recoverable).
 *  source is the structured branch flag — display strings must never drive logic (a copy rewrite once silently killed the JSON branch). Corrupt files are always renamed and preserved, never deleted.
 *  P2 2026-09-19: an existence-only recoverable-source check used to rename a HEALTHY todos.db on a
 *  transient init failure (lock held / WAL race). Now: when the main file's SQLite header is intact
 *  the DB is NEVER treated as corrupt — retry init once (optional `retryInit` callback); 'retry-ok'
 *  = retry succeeded, 'transient' = retry failed but the file is still healthy. Only a wrong header
 *  AND a recoverable source proceed to the rename path. */
/** 恢复优先级 = JSON 优先于 plain-bak(2026-09-04 深审 P0 倒置修复):critical JSON 是渲染端持续覆盖的最新快照,
 *  .plain-bak 是加密迁移那一刻的一次性快照、之后永不更新——旧的"plain-bak 优先"会在迁移一年后损坏时恢复一年前数据。
 *  .corrupt-* 现场只保留最近 3 套,更早的删除(无限累积曾无治理)。 */
function attemptDbRecovery (ud, retryInit) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const mainDb = path.join(ud, 'todos.db')
  // P2 2026-09-19: healthy header → the DB itself is fine; the init failure was transient. Retry
  // init once when a hook is provided; regardless of the retry outcome a header-intact DB is never
  // renamed — "corrupt" requires a WRONG header, not merely a failed init.
  if (fs.existsSync(mainDb) && sqliteHeaderOk(mainDb)) {
    if (typeof retryInit === 'function') {
      try {
        const retried = retryInit()
        if (retried && typeof retried.then === 'function') {
          // async retry not supported by the sync recovery contract
          return { source: 'transient', label: 'transient init failure; SQLite header intact (no rename performed)' }
        }
        return { source: 'retry-ok', label: 'transient init failure; SQLite header intact, retry succeeded (no rename performed)' }
      } catch {
        return { source: 'transient', label: 'transient init failure persists; SQLite header intact, recovery NOT performed (healthy DB preserved)' }
      }
    }
    // No retry hook available: still never rename a header-healthy DB on an existence-only guess.
    return { source: 'transient', label: 'transient init failure; SQLite header intact (no rename performed)' }
  }
  // P2 (dw wave5 2026-09-24): an ENCRYPTED db (db.key present) starts with ciphertext, so the
  // plaintext-magic guard above is always false for it — the old code treated every encrypted db
  // as corrupt and renamed a HEALTHY one aside on the first transient init failure, rolling back
  // to a stale backup. When a key exists, decide by the decrypt probe instead: decryptable =
  // healthy, same protection as a header-intact plaintext db (retry once, never rename);
  // undecryptable = genuinely corrupt, fall through to the recovery path. An inconclusive probe
  // (driver unavailable) stays conservative: no rename, no rollback.
  const keyFile = path.join(ud, 'db.key')
  if (fs.existsSync(mainDb) && fs.existsSync(keyFile)) {
    const probe = encryptedProbe(mainDb, keyFile)
    if (probe !== 'no') {
      // 2026-09-25: the transient/declined outcomes used to return silently — the caller's error
      // dialog then either claimed a recovery that never happened or showed no reason at all.
      // Log the probe verdict with every no-rename return so the trail explains WHY nothing was touched.
      if (probe === 'yes' && typeof retryInit === 'function') {
        try {
          const retried = retryInit()
          if (retried && typeof retried.then === 'function') {
            logWarn('[dbRecovery] transient init failure; encrypted db decrypts with its key (probe=yes); async retry unsupported, no rename performed')
            return { source: 'transient', label: 'transient init failure; encrypted db decrypts with its key (no rename performed)' }
          }
          return { source: 'retry-ok', label: 'transient init failure; encrypted db decrypts with its key, retry succeeded (no rename performed)' }
        } catch {
          logWarn('[dbRecovery] transient init failure persists; encrypted db decrypts with its key (probe=yes), recovery NOT performed (healthy DB preserved)')
          return { source: 'transient', label: 'transient init failure persists; encrypted db decrypts with its key, recovery NOT performed (healthy DB preserved)' }
        }
      }
      const declinedLabel = probe === 'yes'
        ? 'transient init failure; encrypted db decrypts with its key (no rename performed)'
        : 'decrypt probe inconclusive (sqlite driver unavailable or db.key unreadable) — recovery declined to avoid destroying a possibly-healthy encrypted DB (no rename performed)'
      logWarn('[dbRecovery] recovery declined: probe=' + probe + ' — ' + declinedLabel)
      return { source: 'transient', label: declinedLabel }
    }
  }
  // Confirm a recoverable source exists before renaming: transient IO errors (disk full/lock held) also make init fail; renaming unconditionally
  // would mislabel the user's current database as .corrupt and fall back to a stale backup or even an empty DB
  const plainBakExists = fs.existsSync(path.join(ud, 'todos.db.plain-bak'))
  // P2 fix (2026-09-26, json-exists-vs-parseable): an existing-but-unparseable JSON no longer
  // counts as a recoverable source — the old existence-only check produced a source:'json'
  // "recovery" that re-inited an EMPTY DB and outranked a usable plain-bak.
  const jsonPath = criticalBackupPath(ud)
  const jsonFileExists = fs.existsSync(jsonPath)
  const jsonExists = jsonFileExists && backupJsonParseable(jsonPath)
  if (!plainBakExists && !jsonExists) return null
  // P1 2026-09-20: quarantine used to swallow rename failures (`catch {}`) and then fall through
  // to copying the backup OVER a possibly-locked/possibly-open target — a silent recovery loop
  // (corrupt file never moved, backup copy fails or hybrids the DB, dialog claims recovery every
  // launch). Now: a rename failure is LOGGED and aborts this branch with a structured
  // source:'error' result, so the caller's relaunch dialog explains the failure instead of
  // pretending recovery happened. Never copy onto a target we could not first move aside.
  for (const suf of ['', '-wal', '-shm']) {
    const src = path.join(ud, 'todos.db' + suf)
    if (!fs.existsSync(src)) continue
    try {
      fs.renameSync(src, src + '.corrupt-' + stamp)
    } catch (e) {
      logWarn('[dbRecovery] failed to quarantine', src, '-', e && e.message, '— recovery branch ABORTED (no backup copied over a possibly-locked target)')
      return { source: 'error', label: 'corrupt DB could not be quarantined: ' + String(e && e.message || e) }
    }
  }
  if (!quarantineKey(ud, stamp)) {
    // M-1 (2026-09-20): the old code treated a failed key rename as best-effort and continued —
    // but the restored DB is PLAINTEXT while the stale db.key is still on disk, so the follow-up
    // init at index.js reopened the restored DB with the OLD WRONG key, the decrypt probe failed,
    // and the user got a "recovery succeeded" dialog while every launch kept failing. A stale key
    // that cannot be moved or deleted is the same abort condition as a DB rename failure: report
    // source:'error' so the caller shows a failure dialog instead of a false success.
    return { source: 'error', label: 'stale db.key could not be quarantined (rename and delete both failed) — reopening the restored plaintext DB with the old key would fail every launch' }
  }
  pruneCorruptScenes(ud)
  if (jsonExists) return { source: 'json', label: 'disaster-backup JSON (fresh)' }
  fs.copyFileSync(path.join(ud, 'todos.db.plain-bak'), path.join(ud, 'todos.db'))
  // Truthful label: when the JSON existed but failed the parseability gate, the caller's dialog
  // must say the restore came from the (possibly stale) plain-bak, not from the JSON.
  if (jsonFileExists) return { source: 'plain-bak', label: 'disaster-backup JSON unparseable, restored from plain-bak (todos.db.plain-bak, possibly stale)' }
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

/** F11 + registry refactor (dw wave6 2026-09-24): the single RESTORE-SEGMENT REGISTRY — segment
 *  name → importer(raw, cb) → which callback enables it. The doc comment and the actual consumed
 *  segments are driven by THIS one table, so comment and code can no longer drift (the same drift
 *  was found in two separate review waves).
 *  Consumed on the startup path: todoState, categoryState, tomatoRecords, filterState, planState,
 *  habitsState, metaState — same segment set the UI restore (SettingsDataTab.applyRestoreDump) accepts.
 *  Deliberately NOT restored here: settingsState (renderer-owned semantics — applying settings
 *  re-runs migration/sanitize logic that belongs to the UI restore path only).
 *  Every importer is idempotent by id (upsert / skip-rows-without-id), matching the UI rules:
 *  a schemaV>1 segment is refused (parseSegment → null), rows without their id key are skipped,
 *  and a single bad row never drags down the batch. */
const RESTORE_SEGMENTS = [
  { seg: 'todoState', enable: c => c.upsertTasks, restore: (raw, cb) => restoreTodoRowsFromCriticalBackup(raw, cb) },
  { seg: 'categoryState', enable: c => c.upsertCategory, restore: (raw, cb) => restoreCategoriesFromCriticalBackup(raw, cb) },
  { seg: 'tomatoRecords', enable: c => c.appendTomatoRecords, restore: (raw, cb) => restoreTomatoRecordsFromCriticalBackup(raw, cb) },
  { seg: 'filterState', enable: c => c.filterPutMany, restore: (raw, cb) => restoreFilterRowsFromCriticalBackup(raw, cb) },
  { seg: 'planState', enable: c => c.planPutMany, restore: (raw, cb) => restorePlanChipsFromCriticalBackup(raw, cb) },
  { seg: 'habitsState', enable: c => c.habitsPut, restore: (raw, cb) => restoreHabitsBlobFromCriticalBackup(raw, cb) },
  { seg: 'metaState', enable: c => c.metaPut, restore: (raw, cb) => restoreMetaEntriesFromCriticalBackup(raw, cb) }
]

/** Meta-key whitelist for the metaState segment restore (2026-09-26, meta-keys-omitted fix).
 *  Only the data surfaces the backup collector gathered — repeat rules, per-task tomato estimates,
 *  project deadline/status/flag/milestones + the project-id registry. Transient keys
 *  (catProjectMetaBak.*, pending markers, todosVersion) are deliberately NOT restorable here. */
const META_RESTORE_PREFIXES = [
  'repeatRule:',
  'tomatoEstimateState:',
  'projectDeadline:',
  'projectStatus:',
  'projectCategoryFlag:',
  'projectMilestones:',
  'projectCategoryIds'
]

/** metaState restore: entries are {key,value} pairs read from the meta table at dump time
 *  (todoBackup.collectMetaState). Idempotent whole-key puts; keys outside the whitelist and
 *  entries without a value are skipped; a single bad entry never drags down the batch. */
function restoreMetaEntriesFromCriticalBackup (raw, metaPut) {
  if (typeof metaPut !== 'function') return 0
  try {
    const seg = parseSegment(raw.backup && raw.backup.metaState, 'metaState')
    if (seg === null) return 0
    const entries = ((seg && seg.entries) || []).filter(e =>
      e && typeof e.key === 'string' && e.value != null && e.value !== '' &&
      META_RESTORE_PREFIXES.some(p => e.key.startsWith(p)))
    if (!entries.length) return 0
    let n = 0
    for (const e of entries) {
      try { metaPut([e.key, e.value]); n++ } catch { /* one bad entry must not drag the batch */ }
    }
    return n
  } catch { return 0 }
}

/** todoState re-import: merge todoList+recycleList, filter rows without taskId. Returns the number imported.
 *  Adversarial-round fix: a missing upsertTasks callback with a NON-empty list used to return
 *  list.length while importing nothing — a lie that could open the caller's restoredN>0 gate
 *  (bak-file cleanup) on a restore that touched zero rows. No callback ⇒ honest 0. */
function restoreTodoRowsFromCriticalBackup (raw, upsertMany) {
  // todoState has two real shapes: the renderer's writeCriticalBackup stores a JSON string (nested via JSON.stringify),
  // while some old drill data is an object. Previously only objects were accepted — real disaster backups would silently import 0 rows (confirmed by the round-trip test 2026-09-01).
  const todoState = parseSegment(raw.backup && raw.backup.todoState, 'todoState')
  if (todoState === null) return 0 // schemaV too high: skip the task segment, process the rest as usual
  const list = ((todoState.todoList || []).concat(todoState.recycleList || [])).filter(t => t && t.taskId)
  if (typeof upsertMany !== 'function') return 0 // cannot import → never claim the count
  if (list.length) upsertMany(list)
  return list.length
}

/** Saved-filters restore: filterState rows are the renderer app shape ({id,name,conds,sort,updatedAt}) that
 *  filterList writes into the dump; filterUpsertMany upserts by id (idempotent, INSERT-fallback on absent id).
 *  Rows without an id are skipped (a fresh random id here would duplicate the smart list on every restore). */
function restoreFilterRowsFromCriticalBackup (raw, filterPutMany) {
  if (typeof filterPutMany !== 'function') return 0
  try {
    const seg = parseSegment(raw.backup && raw.backup.filterState, 'filterState')
    if (seg === null) return 0
    const rows = ((seg && seg.list) || []).filter(f => f && f.id != null)
    if (!rows.length) return 0
    // B2 (2026-09-26): backup rows carry backup-time updatedAt and filterUpsert preserves explicit
    // stamps — on a LAN-sync peer with newer rows the restore lost LWW instantly. Re-stamp fresh:
    // restore = the backup's data must win (same rule as the UI restore's todo stamping).
    const now = Date.now()
    try { filterPutMany(rows.map(f => ({ ...f, updatedAt: now }))); return rows.length } catch { return 0 }
  } catch { return 0 }
}

/** Plan-chips restore: planState rows are plan_chips row shape ({id,taskId,day,mm,sort,updatedAt} —
 *  planAll writes them); planAddMany validates day/mm and upserts by id (idempotent, db.js:835 precedent).
 *  Rows without an id are skipped for the same no-duplicate reason as filters. */
function restorePlanChipsFromCriticalBackup (raw, planPutMany) {
  if (typeof planPutMany !== 'function') return 0
  try {
    const seg = parseSegment(raw.backup && raw.backup.planState, 'planState')
    if (seg === null) return 0
    const rows = ((seg && seg.chips) || []).filter(c => c && c.id != null)
    if (!rows.length) return 0
    // B2 (2026-09-26): planAddMany preserves explicit updatedAt — re-stamp fresh so LAN LWW
    // cannot instantly revert the restore against a peer holding newer chips.
    const now = Date.now()
    try { planPutMany(rows.map(c => ({ ...c, updatedAt: now }))); return rows.length } catch { return 0 }
  } catch { return 0 }
}

/** Habits restore: habitsState is ONE blob ({schemaV,habits,moments,savedAt}), not a row set —
 *  re-published through the same meta door the renderer's habits store persists through
 *  (meta 'db.habitsState'). Idempotent by construction (whole-blob put). schemaV>1 refuses. */
function restoreHabitsBlobFromCriticalBackup (raw, habitsPut) {
  if (typeof habitsPut !== 'function') return 0
  try {
    const seg = parseSegment(raw.backup && raw.backup.habitsState, 'habitsState')
    if (seg === null || !Array.isArray(seg.habits)) return 0
    try {
      habitsPut(['db.habitsState', JSON.stringify({ schemaV: SUPPORTED_SCHEMA_V, habits: seg.habits, moments: Array.isArray(seg.moments) ? seg.moments : [], savedAt: Number(seg.savedAt) || 0 })])
      return 1
    } catch { return 0 }
  } catch { return 0 }
}

/** Re-import from the disaster-backup JSON; returns the number of TASK rows imported (the caller's
 *  restoredN>0 gate reads this). Per-segment callbacks are optional; a missing callback (or a
 *  missing segment in an old backup) skips that segment silently — F11 (dw wave6) added
 *  filterPutMany / planPutMany / habitsPut so startup recovery now re-imports the SAME segment set
 *  the UI restore accepts (saved filters / schedule chips / habits used to be silently dropped).
 *  Still not restored on this path: settingsState — renderer-owned semantics (see RESTORE_SEGMENTS). */
function restoreTasksFromCriticalBackup (ud, upsertTasks, upsertCategory, appendTomatoRecords, extraCbs) {
  const cbs = Object.assign(
    { upsertTasks, upsertCategory, appendTomatoRecords },
    extraCbs || {}
  )
  try {
    const raw = JSON.parse(fs.readFileSync(criticalBackupPath(ud), 'utf8'))
    let tasks = 0 // the return value stays the TASK count (index.js's restoredN gate + dialog copy read it)
    for (const entry of RESTORE_SEGMENTS) {
      try {
        const cb = entry.enable(cbs)
        if (typeof cb !== 'function') continue
        const n = entry.restore(raw, cb) || 0
        if (entry.seg === 'todoState') tasks = Math.max(0, n)
      } catch (e) {
        // one segment failing must not drag the others down
        logWarn('[dbRecovery] segment', entry.seg, 'restore failed:', e && e.message)
      }
    }
    return tasks
  } catch (e) {
    // P1 (R4 2026-09-21): the swallowed error used to make a failed restore indistinguishable
    // from an empty backup — the caller then deleted todos.db.plain-bak on a "successful"
    // recovery that imported nothing, permanently destroying the last usable backup. Log it
    // (still return 0; the caller's restoredN > 0 gate keeps the bak file alive).
    logWarn('[dbRecovery] restoreTasksFromCriticalBackup failed (0 rows imported):', e && e.message)
    return 0
  }
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
 *  dest is decided by the caller (the main process currently passes the external default root pickdone-backups); the directory is created first if missing.
 *  main-ipc-2 fsync fix (2026-09-22): writeFileDurable fsyncs the data before the rename — this
 *  JSON is the disaster-recovery SOURCE; a power cut between OS cache and rename left it torn. */
function writeCriticalStateBackupAtomic (ud, jsonText) {
  fs.mkdirSync(ud, { recursive: true })
  const dest = path.join(ud, 'critical-state-backup.json')
  require('./durable-fs').writeFileDurable(dest, jsonText)
  return dest
}

/** P2 (dw wave5 2026-09-24, sunk from index.js whenReady — this module is the pure-fs home for
 *  startup recovery orchestration): plain-bak residue precheck. Three conditions together are the
 *  crash-between-two-renames scene of migratePlainToEncrypted: no todos.db + plain-bak + no db.key
 *  → clear orphan WAL and put the plaintext copy back. No todos.db + plain-bak + a db.key still
 *  present (user hand-deleted the db etc.) → move the key aside and restore the bak; init then
 *  re-encrypts with a fresh key, data preserved. Pure fs over the userData path → unit-testable. */
function preflightMigrateResidue (ud, log) {
  const warn = (...a) => { try { (log || console).warn('[Init] ' + a.join(' ')) } catch { /* best-effort */ } }
  try {
    const mainDb = path.join(ud, 'todos.db')
    const bak = path.join(ud, 'todos.db.plain-bak')
    if (fs.existsSync(mainDb) || !fs.existsSync(bak)) return false
    const key = path.join(ud, 'db.key')
    if (!fs.existsSync(key)) {
      for (const suf of ['-wal', '-shm']) { try { fs.rmSync(mainDb + suf, { force: true }) } catch {} }
      fs.copyFileSync(bak, mainDb)
      warn('迁移中断残留:已从 todos.db.plain-bak 恢复数据库文件')
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try { fs.renameSync(key, key + '.superseded-' + stamp) } catch {}
      for (const suf of ['-wal', '-shm']) { try { fs.rmSync(mainDb + suf, { force: true }) } catch {} }
      fs.copyFileSync(bak, mainDb)
      warn('todos.db 缺失但存在明文备份:已从 plain-bak 恢复,旧 db.key 移为 db.key.superseded-*')
    }
    return true
  } catch (e) {
    warn('plain-bak 预检失败', (e && e.message) || e)
    return false
  }
}

/** P2 (dw wave5 2026-09-24, sunk from index.js whenReady): sweep files renamed aside by a previous
 *  "reset data" while their handles were still open (pending-delete-<ts>-*). At next startup the
 *  handles are gone; delete them best-effort. Returns the number of entries swept. */
function sweepPendingDeletes (ud, log) {
  let swept = 0
  try {
    for (const f of fs.readdirSync(ud)) {
      if (!f.startsWith('pending-delete-')) continue
      try { fs.rmSync(path.join(ud, f), { force: true, recursive: true }); swept++ } catch {}
    }
  } catch (e) { try { (log || console).warn('[Init] pending-delete 清扫失败', e) } catch { /* best-effort */ } }
  return swept
}

module.exports = { attemptDbRecovery, restoreTasksFromCriticalBackup, writeCriticalStateBackupAtomic, criticalBackupPath, backupJsonParseable, restoreCategoriesFromCriticalBackup, restoreTomatoRecordsFromCriticalBackup, restoreMetaEntriesFromCriticalBackup, quarantineKey, sqliteHeaderOk, encryptedProbe, preflightMigrateResidue, sweepPendingDeletes, recoveryDialogAction, loadVendorDriver }
