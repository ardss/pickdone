/**
 * db-recovery-restore — the critical-backup restore family, split from dbRecovery.cjs
 * (2026-10-24 size-ratchet split queue). Pure-with-callbacks: every importer takes its
 * sinks (upsert/metaPut/append...) as arguments; the shared probes come in through the
 * factory, exactly like the db-recovery-attachments module. No handle, no I/O policy.
 */
const fs = require('fs')
const path = require('path')
const { isBlankishName } = require('./blankish-name.cjs') // pure util: blank-name filter for restore rows

module.exports = ({ parseSegment, criticalBackupPath, logWarn, SUPPORTED_SCHEMA_V, attLoss }) => {
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
  { seg: 'metaState', enable: c => c.metaPut, restore: (raw, cb, cbs) => restoreMetaEntriesFromCriticalBackup(raw, cb, cbs && cbs.settingsPut) }
]

/** Derived (not hand-copied) segment-name list — the CLI's restore-backup validator consumes
 *  THIS export so its schemaV guard can never drift from the registry (a hand-copied 6-segment
 *  literal already missed tomatoRecords once: a future-version tomatoRecords segment passed the
 *  CLI's "Snapshot OK" while the App's restore refused the dump). */
const RESTORE_SEGMENT_NAMES = RESTORE_SEGMENTS.map(e => e.seg)

/** Meta-key whitelist for the metaState segment restore (2026-09-26, meta-keys-omitted fix).
 *  Only the data surfaces the backup collector gathered — repeat rules, per-task tomato estimates,
 *  project deadline/status/flag/milestones/docs + the project-id registry and the placeholder-tag
 *  registry (D15-B3 `userTags`, D15-B4 `projectDocs:<id>` — added in lockstep with
 *  todoBackup.metaStateKeys and the SettingsDataTab whitelist; the drift-guard test pins the trio).
 *  Transient keys (catProjectMetaBak.*, catFiltersBak.*, pending markers, todosVersion) are
 *  deliberately NOT restorable here. */
const META_RESTORE_PREFIXES = [
  'repeatRule:',
  'tomatoEstimateState:',
  'planChipsSnapshot:',
  'projectDeadline:',
  'projectStatus:',
  'projectCategoryFlag:',
  'projectMilestones:',
  'projectDocs:',
  'projectCategoryIds',
  'userTags',
  // F1 (2026-10-17) sync-identity: without these a JSON restore mints a FRESH sync.deviceId
  // (authority = settings_rows, lan-sync-bootstrap.js:40) while every peer pairs the dead one.
  // EXCLUDED (machine-local, not identity): sync.deviceName, sync.enabled/port/*.
  'sync.deviceId',
  'sync.pairingSecret'
]

/** metaState restore: entries are {key,value} pairs read from the meta table at dump time
 *  (todoBackup.collectMetaState). Idempotent whole-key puts; keys outside the whitelist and
 *  entries without a value are skipped; a single bad entry never drags down the batch.
 *  F1 (2026-10-17) identity routing: sync.deviceId/sync.pairingSecret live in settings_rows —
 *  a metaPut is silently inert; they route through optional settingsPut (extraCbs → setting.put). */
function restoreMetaEntriesFromCriticalBackup (raw, metaPut, settingsPut) {
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
      try {
        const identity = e.key === 'sync.deviceId' || e.key === 'sync.pairingSecret'
        // identity keys go to settings_rows via settingsPut; without that callback settingsPut is
        // undefined → the call throws → caught below: an honest skip (a meta-table write would be
        // silently inert)
        ;(identity ? settingsPut : metaPut)([e.key, e.value])
        n++
      } catch { /* one bad entry (or absent settingsPut) must not drag the batch */ }
    }
    return n
  } catch { return 0 }
}

/** todoState re-import: merge todoList+recycleList, filter rows without taskId. Returns the number imported.
 *  Adversarial-round fix: a missing upsertTasks callback with a NON-empty list used to return
 *  list.length while importing nothing — a lie that could open the caller's restoredN>0 gate
 *  (bak-file cleanup) on a restore that touched zero rows. No callback ⇒ honest 0.
 *  Sync-14 (restore re-stamp doctrine — parity with the B2 filter/plan restores and the D11
 *  finding-6 category restore): rows used to be re-imported with their BACKUP-era stamps, so
 *  on a LAN peer holding newer rows the restore lost LWW instantly and the "recovered" data
 *  was immediately overwritten. Doctrine: a restored LIVE row re-stamps updateTime fresh
 *  (restore = the backup's data must win); a restored TOMBSTONE keeps its backup deletedAt
 *  (or the epoch-oldest 1 when absent) with updateTime 1, so a peer that legitimately
 *  re-created the todo after the backup wins the next LWW round (the deletion must not
 *  un-delete the peer's newer work). */
function restoreTodoRowsFromCriticalBackup (raw, upsertMany) {
  // todoState has two real shapes: the renderer's writeCriticalBackup stores a JSON string (nested via JSON.stringify),
  // while some old drill data is an object. Previously only objects were accepted — real disaster backups would silently import 0 rows (confirmed by the round-trip test 2026-09-01).
  const todoState = parseSegment(raw.backup && raw.backup.todoState, 'todoState')
  if (todoState === null) return 0 // schemaV too high: skip the task segment, process the rest as usual
  let list = ((todoState.todoList || []).concat(todoState.recycleList || [])).filter(t => t && t.taskId)
  // F1 (2026-10-17) dangling-repeatId demotion, parity with the UI restore path
  // (SettingsDataTab.vue:522-552): a row whose repeatRule:<rid> meta is absent from the backup
  // must be demoted pre-import or it references a rule that does not exist (the UI path already
  // fixed this; the startup path split the contract). Rules come from the BACKUP's own metaState
  // so the decision matches post-restore reality; absent/refused metaState skips conservatively.
  const knownRules = backupRepeatRuleIds(raw)
  if (knownRules) {
    let demoted = 0
    list = list.map(t => (t.repeatId && !knownRules.has(t.repeatId) ? (demoted++, { ...t, repeatId: null }) : t))
    if (demoted) logWarn(`[dbRecovery] todoState restore: demoted ${demoted} row(s) with dangling repeatId (no repeatRule in the backup's metaState)`)
  }
  if (typeof upsertMany !== 'function') return 0 // cannot import → never claim the count
  if (list.length) {
    const now = Date.now()
    upsertMany(list.map(t => {
      const deleted = !!(t.delete || t.deleted)
      return deleted
        ? { ...t, delete: 1, deletedAt: t.deletedAt || 1, updateTime: 1 }
        : { ...t, updateTime: now }
    }))
  }
  return list.length
}

/** F1 (2026-10-17): repeat-rule ids in THIS backup's metaState segment; null when absent/refused
 *  ("cannot judge" — skip the demotion). Mirrors UI danglingRepeatIds: a miss is gone. */
function backupRepeatRuleIds (raw) {
  if (raw == null || raw.backup == null || raw.backup.metaState == null) return null
  const seg = parseSegment(raw.backup.metaState, 'metaState')
  if (seg === null) return null // schemaV refused → cannot judge which rules will exist
  return new Set((((seg && seg.entries) || []).filter(e => e && typeof e.key === 'string' && e.key.startsWith('repeatRule:')))
    .map(e => e.key.slice('repeatRule:'.length)))
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
      // W8 fix (2026-10-25): the habits persist shape grew top-level DELETION TOMBSTONE arrays
      // (`deleted` / `deletedMoments`, see db-sync-schema.js HABITS_BLOB_OWNED). The restore used
      // to drop them, so every habit/moment the user had deleted resurrected after a disaster
      // recovery. Carry them through verbatim (absent in an old backup → empty arrays).
      habitsPut(['db.habitsState', JSON.stringify({ schemaV: SUPPORTED_SCHEMA_V, habits: seg.habits, moments: Array.isArray(seg.moments) ? seg.moments : [], deleted: Array.isArray(seg.deleted) ? seg.deleted : [], deletedMoments: Array.isArray(seg.deletedMoments) ? seg.deletedMoments : [], savedAt: Number(seg.savedAt) || 0 })])
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
/** Sync-3 (D12 2026-10-01): per-segment restore WITH an honest per-segment success report.
 *  The old restoreTasksFromCriticalBackup swallowed per-segment failures and returned ONLY the
 *  todoState task count, so index.js's jsonRestoreProved gate ("restoredN > 0") could delete
 *  todos.db.plain-bak — the user's only other copy — while chips/filters/meta segments had just
 *  failed to import. That loss is irreversible. Returns:
 *    tasks               task-row count (the same number the legacy return carried)
 *    imported            total rows imported across ALL segments
 *    perSegment          { segName: count }
 *    failedSegments      segments whose importer threw
 *    unconsumedSegments  segments whose payload exists in the backup but imported 0 (conservative:
 *                        a legitimately-empty payload also lands here — keeping todos.db.plain-bak
 *                        on disk is always the safe side of this gate)
 *    proved              true only when something was imported AND no segment failed or was left
 *                        unconsumed — index.js gates the plain-bak cleanup on THIS flag. */
function restoreSegmentsFromCriticalBackup (ud, upsertTasks, upsertCategory, appendTomatoRecords, extraCbs) {
  const cbs = Object.assign(
    { upsertTasks, upsertCategory, appendTomatoRecords },
    extraCbs || {}
  )
  const result = { tasks: 0, imported: 0, perSegment: {}, failedSegments: [], unconsumedSegments: [], proved: false, degradedSegments: [] }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(criticalBackupPath(ud), 'utf8'))
  } catch (e) {
    // P1 (R4 2026-09-21): a failed restore must never read as restore-proof — the caller's
    // proved gate keeps the bak file alive.
    logWarn('[dbRecovery] restoreSegmentsFromCriticalBackup failed (0 rows imported):', e && e.message)
    return result
  }
  // [Sync-13 reader, restore-degraded-segments-marker-never-consumed] the writer put the marker in
  // every degraded dump but nothing read it back. Parse it into the report: non-empty = the dump's
  // collector FAILED for the named segments at write time, so those data surfaces are simply
  // absent from the backup. Honesty surface only — it must NEVER fail the restore or veto `proved`
  // (the missing data cannot be conjured by refusing the restore).
  result.degradedSegments = Array.isArray(raw && raw.backup && raw.backup.degradedSegments)
    ? raw.backup.degradedSegments.filter(s => typeof s === 'string')
    : []
  for (const entry of RESTORE_SEGMENTS) {
    const cb = entry.enable(cbs)
    if (typeof cb !== 'function') continue
    const hadPayload = !!(raw && raw.backup && raw.backup[entry.seg] != null)
    try {
      const n = entry.restore(raw, cb, cbs) || 0 // cbs passed through so metaState can route identity keys to settingsPut
      result.perSegment[entry.seg] = n
      result.imported += n
      if (entry.seg === 'todoState') result.tasks = Math.max(0, n) // legacy contract: the TASK count
      if (hadPayload && n === 0) result.unconsumedSegments.push(entry.seg)
    } catch (e) {
      // one segment failing must not drag the others down — but it must be REPORTED
      result.perSegment[entry.seg] = 0
      result.failedSegments.push(entry.seg)
      if (entry.seg === 'todoState') result.tasks = 0
      logWarn('[dbRecovery] segment', entry.seg, 'restore failed:', e && e.message)
    }
  }
  attLoss.reportMissingAfterRestore(result, raw, ud, cbs && cbs.filesDir); result.proved = result.imported > 0 && result.failedSegments.length === 0 && result.unconsumedSegments.length === 0 // F4 P2: attachment report never blocks the proved gate
  return result
}

/** Legacy shim: same task-count return the historical callers/tests assert on. */
function restoreTasksFromCriticalBackup (ud, upsertTasks, upsertCategory, appendTomatoRecords, extraCbs) {
  return restoreSegmentsFromCriticalBackup(ud, upsertTasks, upsertCategory, appendTomatoRecords, extraCbs).tasks
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
 *  a single-row failure is skipped without dragging down the whole batch. No writes when the JSON has no category data.
 *  D11 finding 6: a restored TOMBSTONE used to lose its stamps — deletedAt fell through to the db
 *  layer's now-stamp (on a fresh recovery DB there is no prior row to keep) and updatedAt was
 *  unstamped, so a backup-era deletion read newest-here and won LWW against a peer that had since
 *  recovered/renamed the category. Mirrors the renderer restore rule (category.js toRow Round-6 P2):
 *  restored tombstones carry their backup deletedAt, or the epoch-oldest stamp (1) when absent, and
 *  updatedAt 1 so any real peer row wins the next LWW round; live rows keep the now-stamp. */
function restoreCategoriesFromCriticalBackup (raw, upsertCategory) {
  if (typeof upsertCategory !== 'function') return 0
  try {
    const catState = parseSegment(raw.backup && raw.backup.categoryState, 'categoryState')
    if (catState === null) return 0 // schemaV too high: skip the category segment (no import, no throw)
    const cats = ((catState && catState.list) || []).filter(c => c && c.categoryId != null)
    let n = 0
    let dropped = 0
    for (const c of cats) {
      // P2 2026-10-08 (pollution root cause): a null/empty/whitespace categoryName used to be
      // mapped to String('') and written as a real row — this restore path cemented the wild
      // `name=''` pollution behind the empty-category choke-point fix. Skip such rows (drop,
      // count, log) instead of writing them. Tombstones are NOT exempt here: a backup segment
      // row without a usable name carries no recoverable content to preserve.
      if (isBlankishName(c.categoryName)) { dropped++; continue } // D25 W1: zero-width spellings count as blank too
      try {
        const deleted = (c.deleted != null ? !!c.deleted : !!c.delete)
        upsertCategory({
          id: c.categoryId,
          userId: c.userId != null ? c.userId : null,
          name: c.categoryName != null ? String(c.categoryName) : '',
          color: c.categoryColor || '',
          createdAt: c.createTime || 0,
          sort: c.listSort || 0,
          isFolder: c.folderIs ? 1 : 0,
          parentId: c.folderId || 0,
          deleted: deleted ? 1 : 0,
          ...(deleted ? { deletedAt: c.deletedAt || 1, updatedAt: 1 } : {})
        })
        n++
      } catch {}
    }
    if (dropped) logWarn(`[dbRecovery] categoryState restore: skipped ${dropped} row(s) with empty/whitespace name (junk-row pollution guard)`)
    return n
  } catch { return 0 }
}

/** Task-count of a critical-backup JSON ({backup:{todoState:{todoList,recycleList}}}); 0 when
 *  anything is missing. Used by the destroy-guard below — plausibility ("parses to an object")
 *  stops garbage bytes but NOT an empty snapshot.
 *  F1 (2026-10-17) shape fix: the REAL dump stores todoState as a NESTED JSON STRING
 *  (todoBackup.buildBackupDump) — the counter always answered 0 on real dumps, making BOTH
 *  empty-snapshot guards silently inert. String segments are parsed before counting. */
function criticalBackupRowCount (jsonText) {
  try {
    let t = (JSON.parse(jsonText).backup || {}).todoState || {}
    if (typeof t === 'string') t = JSON.parse(t)
    return ((t && t.todoList) || []).length + ((t && t.recycleList) || []).length
  } catch { return 0 }
}

/** Atomic disaster-backup write: temp file + rename within the same directory, preventing an interruption from corrupting the backup file itself.
 *  dest is decided by the caller (the main process currently passes the external default root pickdone-backups); the directory is created first if missing.
 *  main-ipc-2 fsync fix (2026-09-22): writeFileDurable fsyncs the data before the rename — this
 *  JSON is the disaster-recovery SOURCE; a power cut between OS cache and rename left it torn.
 *  Destroy-guard (2026-10-10 backup audit): a syntactically valid but EMPTY snapshot (renderer
 *  boots with a blank in-memory store and dutifully persists it) must not atomically destroy the
 *  last good recovery source — that file is the only recovery left. When the existing backup
 *  holds rows and the incoming one holds none, the empty one is quarantined to a side file and
 *  the fresh snapshot is NOT overwritten. */
function writeCriticalStateBackupAtomic (ud, jsonText) {
  fs.mkdirSync(ud, { recursive: true })
  const dest = path.join(ud, 'critical-state-backup.json')
  if (criticalBackupRowCount(jsonText) === 0 && fs.existsSync(dest) && criticalBackupRowCount(fs.readFileSync(dest, 'utf8')) > 0) {
    const side = path.join(ud, 'critical-state-backup.empty-' + Date.now() + '.json')
    require('./durable-fs').writeFileDurable(side, jsonText)
    return side
  }
  require('./durable-fs').writeFileDurable(dest, jsonText)
  return dest
}
  return {
    RESTORE_SEGMENTS,
    RESTORE_SEGMENT_NAMES,
    META_RESTORE_PREFIXES,
    restoreMetaEntriesFromCriticalBackup,
    restoreTodoRowsFromCriticalBackup,
    backupRepeatRuleIds,
    restoreFilterRowsFromCriticalBackup,
    restorePlanChipsFromCriticalBackup,
    restoreHabitsBlobFromCriticalBackup,
    restoreSegmentsFromCriticalBackup,
    restoreTasksFromCriticalBackup,
    restoreTomatoRecordsFromCriticalBackup,
    restoreCategoriesFromCriticalBackup,
    criticalBackupRowCount,
    writeCriticalStateBackupAtomic,
  }
}
