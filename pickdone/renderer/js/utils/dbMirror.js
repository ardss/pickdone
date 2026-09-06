/**
 * localStorage → SQLite persistence mirror — the three "master data that should live in the DB" states all go through here:
 *   db.settingsState (all settings) / db.habitsState (habit check-ins) / (db.tomatoState 已退役:账本迁 tomato_records 行表,mirror 仅剩 settings/habits)
 * Model: localStorage is the live runtime copy and cross-window sync channel; each debounced mirror write goes to a DB meta row; on startup the DB takes precedence for restore.
 * A one-time migration achieves durability: after the first mirror write the DB is the persistent copy, so data survives even if LS is cleared.
 */
const DEBOUNCE_MS = 2000
const timers = {}
const pendings = {} // Blobs pending within the debounce window (used by quit flush)

function writeNow (metaKey, blob) {
  try {
    if (!window.todoAPI?.dbCall) return
    // setMeta is now a main-window-only op (to prevent a compromised aux window from batch-modifying meta); aux windows (float/quick-add) don't write the DB directly —
    // LS is the cross-window sync channel; after the main window receives state via the storage event, the main window's mirror persists it
    if (window.location.hash && /__tomato-float|__quick-add/.test(window.location.hash)) return
    window.todoAPI.dbCall('setMeta', [metaKey, JSON.stringify(blob)]).catch(() => {})
  } catch { /* empty environment */ }
}

export function mirrorToDb (metaKey, blob, immediate = false) {
  pendings[metaKey] = blob
  if (immediate) {
    // Compensation path (LS write failure etc.): skip the debounce and persist immediately, otherwise failing again within the 2s window = data exists only in memory
    clearTimeout(timers[metaKey]); delete timers[metaKey]
    const b = pendings[metaKey]; delete pendings[metaKey]
    if (b !== undefined) writeNow(metaKey, b)
    return
  }
  clearTimeout(timers[metaKey])
  timers[metaKey] = setTimeout(() => {
    delete timers[metaKey]
    const b = pendings[metaKey]
    delete pendings[metaKey]
    if (b !== undefined) writeNow(metaKey, b)
  }, DEBOUNCE_MS)
}

// Quit flush: main process before-quit broadcast (mirrors pending in the debounce window are flushed to disk immediately, otherwise quit/crash loses the last write)
if (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.onAppQuittingFlush) {
  window.todoAPI.onAppQuittingFlush(() => {
    for (const k of Object.keys(timers)) { clearTimeout(timers[k]); delete timers[k] }
    for (const k of Object.keys(pendings)) {
      const b = pendings[k]
      delete pendings[k]
      if (b !== undefined) writeNow(k, b)
    }
  })
}

export async function restoreFromDb (metaKey) {
  try {
    if (!window.todoAPI?.dbCall) return null
    const raw = await window.todoAPI.dbCall('getMeta', metaKey)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
