/* Sync IPC op registry (P3a LAN sync, 2026-09-16).
 * db.js's OPS table carries five thin delegates (syncGetSettings/syncSetEnabled/syncGetStatus/
 * syncGetPairingCode/syncSetName) that dispatch here, so the cli/check-ipc-op-coverage gate sees
 * them in db.js OPS while the heavy implementation lives in lan-sync-bootstrap.js (keeps db.js
 * under its size ratchet and keeps Electron-free requireability for the CLI).
 * Lifecycle: handlers are registered by initLanSync() after db init; before that every dispatch
 * throws — sync is off by default and the renderer only reaches these ops from the settings UI.
 */
const handlers = Object.create(null)

/* CONTRACT (2026-09-20, F-UI consumes): batch meta read `getMetaMany(keys: string[])` →
 * [{key, value|null}] with the output ALIGNED 1:1 to the input key order. Read-only, available
 * from ANY renderer window (whitelisted in handlers/todo.js, not main-window-only). Implemented
 * here (not in db.js) for the size ratchet — same split as the sync op siblings — and registered
 * STATICALLY (not via initLanSync) so it works before/independent of LAN sync init. */
handlers.getMetaMany = (keys) => {
  const list = Array.isArray(keys) ? keys : (keys && Array.isArray(keys.keys) ? keys.keys : null)
  if (!list) throw new Error('[db-sync-ops] getMetaMany: keys must be an array of strings')
  const dbm = require('./db')
  return list.map(k => {
    const key = String(k)
    let value = null
    try { value = dbm.call('getMeta', key) } catch { /* closed/uninitialized DB: aligned null keeps the contract shape */ }
    return { key, value: value == null ? null : String(value) }
  })
}

module.exports = {
  /** Register/override the sync op handlers (called once from lan-sync-bootstrap.initLanSync). */
  register (map) { Object.assign(handlers, map) },

  /** Drop all handlers (tests / db re-init). */
  reset () { for (const k of Object.keys(handlers)) delete handlers[k] },

  /** Called by the db.js OPS delegates. */
  dispatch (op, params) {
    const fn = handlers[op]
    if (!fn) throw new Error('[db-sync-ops] sync op unavailable (LAN sync not initialized): ' + op)
    return fn(params)
  }
}
