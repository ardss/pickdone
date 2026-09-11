/**
 * Backup concern, physically split out of store/todo.js (pure relocation, no semantic change):
 * the single-source backup dump builder plus the critical/event/auto backup write strategies
 * (debounce, quit-flush hook, main-window-only guard, rolling keep policies).
 *
 * The Vuex actions in todo.js delegate here, passing the store instance as `ctx` (the actions'
 * `this`), which owns the debounce timers and the quit-flush hook flags exactly as before.
 */
import { saveRuntime } from './runtimeState.js'

/** Persistence blob format version (shared by the todoState/categoryState/habitsState segments in backup dumps);
 *  note this is unrelated to state.version (the sync counter). The restore side refuses to import segments >1 (preventing downgrade misreads). */
export const SCHEMA_V = 1

/* Single source for every backup dump (event/auto/critical). Previously hand-copied 3× and already drifting —
   a recovery dump missing a field means silently losing data on restore, so any new store goes here once. */
export function buildBackupDump (rootState, state, { stripVolatileSettings = false } = {}) {
  const settings = { ...rootState.settings }
  if (stripVolatileSettings) { settings.autoBackupLastAt = 0; settings.tomatoRecordAddCount = 0; settings.tomatoRecordAddDate = 0 } // strip volatile timestamps so content dedupe stays effective
  return {
    backup: {
      settingsState: JSON.stringify(settings),
      user: JSON.stringify(rootState.auth.user),
      lastLoginRecord: JSON.stringify(rootState.auth.lastLoginRecord),
      todoState: JSON.stringify({
        schemaV: SCHEMA_V,
        search: state.search, todoList: state.todoList, recycleList: state.recycleList, version: state.version,
        remoteVersion: state.remoteVersion, todayTimestamp: state.todayTimestamp,
        ignoreReminder: state.ignoreReminder, todosVersion: state.todosVersion, isSyncing: false,
        views: {}
      }),
      tomatoState: localStorage.getItem('tomatoState') || '{}',
      // 账本行集随份走(blob 已被掏空,不含记录;恢复端按行表幂等回灌)——无它则 JSON 灾备恢复任务回而专注账全丢
      tomatoRecords: JSON.stringify(rootState.tomato && rootState.tomato.tomatoRecordList || []),
      categoryState: JSON.stringify({ schemaV: SCHEMA_V, list: rootState.category.list }),
      habitsState: JSON.stringify({ schemaV: SCHEMA_V, habits: rootState.habits.habits, moments: rootState.habits.moments, savedAt: rootState.habits.savedAt || 0 })
    }
  }
}

/** Event snapshot before dangerous operations: reason such as purge/import/restore, filename evt-<reason>-*.json */
export async function writeEventBackupCore (ctx, { state, rootState }, reason) {
  try {
    if (!window.todoAPI || !window.todoAPI.runAutoBackup) return false
    const dump = buildBackupDump(rootState, state)
    await window.todoAPI.runAutoBackup(JSON.stringify(dump), { tag: String(reason || 'op').toLowerCase(), eventKeep: 10, backupDir: rootState.settings.backupDir || '' })
  } catch (e) { console.error('[event-backup] failed:', e && e.message) }
}

/** Auto backup: same structure as critical-state, written to userData/backups/auto-*.json with rolling cleanup */
export async function writeAutoBackupCore (ctx, { state, rootState }) {
  try {
    if (!window.todoAPI || !window.todoAPI.runAutoBackup) return
    const dump = buildBackupDump(rootState, state, { stripVolatileSettings: true })
    const r = await window.todoAPI.runAutoBackup(JSON.stringify(dump), { recent: rootState.settings.autoBackupKeep || 24, backupDir: rootState.settings.backupDir || '' })
    if (r && r.ok) saveRuntime({ autoBackupLastAt: Date.now() })
    else saveRuntime({ autoBackupLastAt: 0 }) // retry next time on failure
    return !!r && !!(r.ok)
  } catch (e) { console.error('[auto-backup] failed:', e && e.message) }
}

export function writeCriticalBackupCore (ctx, { state, rootState }) {
  // Main-window-only op: the main process throws 'main-window-only' for aux windows, which used to leave an
  // unhandled rejection on every debounced fire in the float/quick-add window and never wrote the backup there.
  // Aux windows don't back up (the main window's timer covers the shared state); early-return, mirroring dbMirror.js.
  try {
    if (typeof window !== 'undefined' && window.location && window.location.hash && /__tomato-float|__quick-add/.test(window.location.hash)) return
  } catch { /* non-browser env */ }
  const buildDump = () => buildBackupDump(rootState, state)
  const writeNow = () => {
    try {
      const p = window.todoAPI.writeCriticalStateBackup(JSON.stringify(buildDump()))
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
  // 5s debounce: full stringify + IPC disk write is expensive with thousands of tasks; 800ms would fire on nearly every continuous edit
  ctx._cbTimer = setTimeout(writeNow, 800)
}
