/* Sync IPC op registry (P3a LAN sync, 2026-09-16).
 * db.js's OPS table carries five thin delegates (syncGetSettings/syncSetEnabled/syncGetStatus/
 * syncGetPairingCode/syncSetName) that dispatch here, so the cli/check-ipc-op-coverage gate sees
 * them in db.js OPS while the heavy implementation lives in lan-sync-bootstrap.js (keeps db.js
 * under its size ratchet and keeps Electron-free requireability for the CLI).
 * Lifecycle: handlers are registered by initLanSync() after db init; before that every dispatch
 * throws — sync is off by default and the renderer only reaches these ops from the settings UI.
 */
const handlers = Object.create(null)

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
