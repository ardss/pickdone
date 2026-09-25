/**
 * Backup concern, physically split out of store/todo.js (pure relocation, no semantic change):
 * the single-source backup dump builder plus the critical/event/auto backup write strategies
 * (debounce, quit-flush hook, main-window-only guard, rolling keep policies).
 *
 * The Vuex actions in todo.js delegate here, passing the store instance as `ctx` (the actions'
 * `this`), which owns the debounce timers and the quit-flush hook flags exactly as before.
 */
import { saveRuntime } from './runtimeState.js'
import { isAuxWindow } from '../../utils/auxWindow.js'

/** Persistence blob format version (shared by the todoState/categoryState/habitsState segments in backup dumps);
 *  note this is unrelated to state.version (the sync counter). The restore side refuses to import segments >1 (preventing downgrade misreads). */
export const SCHEMA_V = 1

/* Single source for every backup dump (event/auto/critical). Previously hand-copied 3× and already drifting —
   a recovery dump missing a field means silently losing data on restore, so any new store goes here once.
   F7/F17 (dw wave6 2026-09-24): segments must also have a CONSUMER to stay in the dump — user/lastLoginRecord
   (auth has its own localStorage re-fill channel, cross-machine JSON import never read them) and tomatoState
   (the countdown blob is retired, the ledger lives in tomato_records rows) were dead weight and are gone. */
export function buildBackupDump (rootState, state, { stripVolatileSettings = false, planState = null, metaState = null } = {}) {
  const settings = { ...rootState.settings }
  if (stripVolatileSettings) { settings.autoBackupLastAt = 0; settings.tomatoRecordAddCount = 0; settings.tomatoRecordAddDate = 0 } // strip volatile timestamps so content dedupe stays effective
  return {
    backup: {
      settingsState: JSON.stringify(settings),
      todoState: JSON.stringify({
        schemaV: SCHEMA_V,
        search: state.search, todoList: state.todoList, recycleList: state.recycleList, version: state.version,
        remoteVersion: state.remoteVersion, todayTimestamp: state.todayTimestamp,
        todosVersion: state.todosVersion, isSyncing: false,
        views: {}
      }),
      // 账本行集随份走(blob 已被掏空,不含记录;恢复端按行表幂等回灌)——无它则 JSON 灾备恢复任务回而专注账全丢
      // F17 (dw wave6 2026-09-24): 旧 tomatoState 倒计时 blob 段已停写——账本早已迁 tomato_records 行表
      // (dbMirror.js 注释确认),UI 恢复七段与 dbRecovery 三段都从不读它,全仓无恢复端消费者。
      tomatoRecords: JSON.stringify(rootState.tomato && rootState.tomato.tomatoRecordList || []),
      categoryState: JSON.stringify({ schemaV: SCHEMA_V, list: rootState.category.list }),
      habitsState: JSON.stringify({ schemaV: SCHEMA_V, habits: rootState.habits.habits, moments: rootState.habits.moments, savedAt: rootState.habits.savedAt || 0 }),
      // D6-F14: saved filters were never in dumps — a JSON disaster recovery wiped every smart list
      filterState: JSON.stringify({ schemaV: SCHEMA_V, list: (rootState.filters && rootState.filters.list) || [] }),
      // D6-F14: schedule chips live in SQLite (plan_chips), not in vuex state — callers pass the
      // freshly-read rows via collectPlanState(); undefined segments are dropped by JSON.stringify
      planState: planState || undefined,
      // 2026-09-26 (meta-keys-omitted): repeat rules / per-task tomato estimates / project
      // deadline+status+flag+milestones live ONLY in the DB meta table — callers pass the
      // freshly-read entries via collectMetaState(); undefined (empty/degraded) is dropped
      metaState: metaState || undefined
    }
  }
}

/** D6-F14: read the plan_chips rows at dump time (async storage — callers must await this and pass
 *  the segment into buildBackupDump). Chips were never in dumps before: restoring a backup silently
 *  dropped every schedule chip while tasks came back. */
export async function collectPlanState () {
  try {
    const rows = await window.todoAPI.dbCall('planAll', [])
    return JSON.stringify({ schemaV: SCHEMA_V, chips: Array.isArray(rows) ? rows : [] })
  } catch (e) { return null } // degraded host: omit the segment rather than fail the whole dump
}

/** Meta keys whose ONLY persistence is the DB meta table (2026-09-26, meta-keys-omitted fix):
 *  repeat rules `repeatRule:<rid>` (todo.js single source), per-task tomato estimates
 *  `tomatoEstimateState:<taskId>` (tomatoEstimate.js), project deadline/status/flag/milestones
 *  `project*:<id>` + the `projectCategoryIds` registry (category.js). Derived from live state so
 *  deleted ids are not resurrected; values are batch-read via getMetaMany (same door as exportXlsx). */
export function metaStateKeys (rootState, state) {
  const keys = new Set()
  const todos = (state.todoList || []).concat(state.recycleList || [])
  for (const t of todos) {
    if (!t) continue
    if (t.repeatId) keys.add('repeatRule:' + t.repeatId)
    if (t.taskId) keys.add('tomatoEstimateState:' + t.taskId)
  }
  for (const c of (rootState.category && rootState.category.list) || []) {
    const id = c && c.categoryId
    if (id == null) continue
    keys.add('projectDeadline:' + id)
    keys.add('projectStatus:' + id)
    keys.add('projectCategoryFlag:' + id)
    keys.add('projectMilestones:' + id)
  }
  if (((rootState.category && rootState.category.list) || []).some(c => c && c.categoryId != null)) keys.add('projectCategoryIds')
  return [...keys]
}

/** Read the meta entries for the dump-time key set (async storage — callers must await this and
 *  pass the segment into buildBackupDump like collectPlanState). Entries with no stored value are
 *  dropped; empty/degraded → null so the segment is omitted rather than failing the dump. */
export async function collectMetaState (rootState, state) {
  try {
    if (!window.todoAPI || !window.todoAPI.getMetaMany) return null
    const keys = metaStateKeys(rootState, state)
    if (!keys.length) return null
    const rows = await window.todoAPI.getMetaMany(keys)
    const entries = (rows || []).filter(r => r && typeof r.key === 'string' && r.value != null && r.value !== '')
      .map(r => ({ key: r.key, value: r.value }))
    if (!entries.length) return null
    return JSON.stringify({ schemaV: SCHEMA_V, entries })
  } catch (e) { return null } // degraded host: omit the segment rather than fail the whole dump
}

/** Event snapshot before dangerous operations: reason such as purge/import/restore, filename evt-<reason>-*.json
 *  F3 (dw wave6 2026-09-24): the main process signals failure via the return value ({ok:false,error},
 *  handlers/backup.js) — nothing throws, so the old bare catch made a failed pre-destroy snapshot
 *  invisible to the caller (purge/purge-all carried on hard-deleting with no snapshot on disk).
 *  Now: r.ok is checked, a boolean is returned, and failures land in runtimeState
 *  (eventBackupLastFailAt/eventBackupLastError) — same honest-status pattern as writeAutoBackupCore.
 *  Display contract for domain 2 (SettingsDataTab): the existing lastBackupFailPrefix channel can
 *  render these two keys the same way it renders autoBackupLastError/autoBackupLastFailAt. */
export async function writeEventBackupCore (ctx, { state, rootState }, reason) {
  try {
    if (!window.todoAPI || !window.todoAPI.runAutoBackup) return false
    // B14 (daily 2026-09-25): evt snapshots strip volatile settings too — before this, only auto
    // backups passed stripVolatileSettings, so two identical business states produced different
    // evt dump bytes (autoBackupLastAt etc. tick between them) and handlers/backup.js's whole-blob
    // content dedup never hit for event snapshots.
    const dump = buildBackupDump(rootState, state, { stripVolatileSettings: true, planState: await collectPlanState(), metaState: await collectMetaState(rootState, state) })
    const r = await window.todoAPI.runAutoBackup(JSON.stringify(dump), { tag: String(reason || 'op').toLowerCase(), eventKeep: 10, backupDir: rootState.settings.backupDir || '' })
    if (r && r.ok) { saveRuntime({ eventBackupLastFailAt: 0, eventBackupLastError: '' }); return true }
    saveRuntime({ eventBackupLastFailAt: Date.now(), eventBackupLastError: String((r && r.error) || 'backup failed').slice(0, 160) })
    return false
  } catch (e) {
    console.error('[event-backup] failed:', e && e.message)
    saveRuntime({ eventBackupLastFailAt: Date.now(), eventBackupLastError: String((e && e.message) || e).slice(0, 160) })
    return false
  }
}

/** Auto backup: same structure as critical-state, written to userData/backups/auto-*.json with rolling cleanup */
export async function writeAutoBackupCore (ctx, { state, rootState }) {
  try {
    // P2 fix (2026-09-25): bare `return` gave undefined — SettingsDataTab's ok === false check
    // missed it and read the degraded host as a successful backup.
    if (!window.todoAPI || !window.todoAPI.runAutoBackup) return false
    const dump = buildBackupDump(rootState, state, { stripVolatileSettings: true, planState: await collectPlanState(), metaState: await collectMetaState(rootState, state) })
    const r = await window.todoAPI.runAutoBackup(JSON.stringify(dump), { recent: rootState.settings.autoBackupKeep || 24, backupDir: rootState.settings.backupDir || '' })
    if (r && r.ok) saveRuntime({ autoBackupLastAt: Date.now(), autoBackupLastFailAt: 0, autoBackupLastError: '' })
    // Failure must stay visible (autoBackupLastAt:0 alone made a persistently failing backup read as
    // "never ran" in Settings→Data): keep the fail timestamp + reason for the honest status line.
    else saveRuntime({ autoBackupLastAt: 0, autoBackupLastFailAt: Date.now(), autoBackupLastError: String((r && r.error) || 'backup failed').slice(0, 160) }) // retry next time on failure
    return !!r && !!(r.ok)
  } catch (e) {
    console.error('[auto-backup] failed:', e && e.message)
    saveRuntime({ autoBackupLastAt: 0, autoBackupLastFailAt: Date.now(), autoBackupLastError: String((e && e.message) || e).slice(0, 160) })
    return false // callers (SettingsDataTab) branch on ok === false: undefined used to fire the success toast on a thrown IPC
  }
}

export function writeCriticalBackupCore (ctx, { state, rootState }) {
  // Main-window-only op: the main process throws 'main-window-only' for aux windows, which used to leave an
  // unhandled rejection on every debounced fire in the float/quick-add window and never wrote the backup there.
  // Aux windows don't back up (the main window's timer covers the shared state); early-return, mirroring dbMirror.js.
  try {
    if (isAuxWindow()) return // centralized detection (review P3 2026-09-22)
  } catch { /* non-browser env */ }
  // B14 (daily 2026-09-25): strip volatile settings here too — same rationale as writeEventBackupCore
  // above: identical business states must produce byte-identical critical dumps so the main process's
  // whole-string content dedup (handlers/backup.js) can hit.
  const buildDump = async () => buildBackupDump(rootState, state, { stripVolatileSettings: true, planState: await collectPlanState(), metaState: await collectMetaState(rootState, state) })
  const writeNow = () => {
    try {
      // D6-F14: chips read is async — the write becomes a promise chain (fire-and-forget as before)
      const p = Promise.resolve(buildDump()).then(d => window.todoAPI.writeCriticalStateBackup(JSON.stringify(d)))
      if (p && typeof p.catch === 'function') p.catch(e => console.error('[todo] critical backup write failed:', e))
    } catch {}
  }
  // Quit flush: main process before-quit broadcast; pending debounced snapshots flush to disk immediately (state/rootState are live references, so flush reads the latest values)
  if (!ctx._flushHooked && window.todoAPI && window.todoAPI.onAppQuittingFlush) {
    ctx._flushHooked = true
    window.todoAPI.onAppQuittingFlush(() => { if (ctx._cbTimer) { clearTimeout(ctx._cbTimer); ctx._cbTimer = null; writeNow() } })
  }
  // Debounced backup: structure matches the reference critical-state-backup.json
  clearTimeout(ctx._cbTimer)
  // F-C5 (maint/dw wave3): aligned to the design value this comment always stated (5s) — the timer
  // had drifted to 800ms since 0.1.0, so every edit pause >800ms fired a full buildBackupDump
  // (2-5MB stringify) + IPC + main-process fsync. The quit flush still guarantees the final
  // snapshot is written on exit, so 5s costs nothing in durability.
  ctx._cbTimer = setTimeout(writeNow, 5000)
}
