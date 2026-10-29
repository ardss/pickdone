/** T7 win-bind persistence store — the main process's OWN JSON file (contract decision: no new
 *  SQLite table). File: <userData>/task-window-bindings.json, shape { version:1, bindings:
 *  [{ taskId, ref }] }, cap 500 entries. The renderer NEVER reads this file — the only data
 *  channel is the five win-bind:* IPC channels, which keeps the dbCall three-way whitelist
 *  (handlers/todo.js ALLOWED_RENDERER_OPS ↔ cli/check-ipc-op-coverage.cjs ↔ contracts.d.ts)
 *  untouched, mirroring the purgeRecycleBin dedicated-channel precedent (preload:38-39).
 *
 *  Durability/quarantine semantics (config-store's, simplified per contract):
 *   - writes go through durable-fs.writeFileDurable (tmp → fsync → rename; config-store.js:190
 *     and windows.js:26 precedent);
 *   - a corrupt (unparseable) file is renamed to .bad — quarantined, NEVER overwritten — and
 *     the in-memory table falls back to empty;
 *   - fsMod is the official failure-injection seam (durable-fs.js:17-19);
 *   - __setDirForTests relocates the file root (config-store.js:17 __setConfigDir seam) so
 *     plain-Node unit tests need no electron.
 *  A put/remove that fails to persist rolls the in-memory table back — cache never drifts from
 *  disk. Orphan bindings (task deleted on the renderer side) are intentionally NOT GC'd here;
 *  the renderer filters them at hydration (minimal surface, frozen contract). */
'use strict'
const fs = require('fs')
const path = require('path')
const { writeFileDurable } = require('../durable-fs')

const MAX_BINDINGS = 500
const FILE_NAME = 'task-window-bindings.json'

module.exports = function createWinBindStore (deps = {}) {
  const log = deps.log || console
  const fsMod = deps.fsMod || fs
  let dirOverride = null // test-only relocation (__setDirForTests)
  let cache = null // null = not loaded yet; Binding[] after first access

  function file () {
    if (deps.file) return deps.file
    let dir = dirOverride
    if (!dir) {
      try { dir = require('electron').app.getPath('userData') } catch { dir = null }
    }
    if (!dir) return null // no electron, no override: nothing to persist on
    return path.join(dir, FILE_NAME)
  }

  /** Load once; corrupt content → quarantine to .bad + empty table (never overwrite). */
  function load () {
    if (cache !== null) return cache
    cache = []
    const f = file()
    if (!f) return cache
    let text = null
    try { text = fsMod.readFileSync(f, 'utf8') } catch { return cache } // absent = empty
    try {
      const parsed = JSON.parse(text)
      if (parsed && Array.isArray(parsed.bindings)) {
        cache = parsed.bindings.filter(b => b && typeof b.taskId === 'string' && b.ref && typeof b.ref === 'object')
      }
    } catch (err) {
      // Corrupt: quarantine so the next write can never clobber whatever the file held.
      try {
        fsMod.renameSync(f, f + '.bad')
        try { log.warn('[win-bind] bindings file corrupt, quarantined to', f + '.bad', err && err.message) } catch { /* best-effort */ }
      } catch (qErr) {
        try { log.warn('[win-bind] bindings file corrupt AND quarantine rename failed (locked?)', qErr && qErr.message) } catch { /* best-effort */ }
      }
      cache = []
    }
    return cache
  }

  function persist (next) {
    const f = file()
    if (!f) return false
    const payload = JSON.stringify({ version: 1, bindings: next })
    try {
      writeFileDurable(f, payload, fsMod)
      return true
    } catch (err) {
      try { log.warn('[win-bind] bindings persist failed:', err && err.message) } catch { /* best-effort */ }
      return false
    }
  }

  return {
    list () { return load().slice() },
    get (taskId) {
      const hit = load().find(b => b.taskId === taskId)
      return hit ? { taskId: hit.taskId, ref: hit.ref } : null
    },
    put (binding) {
      if (!binding || typeof binding.taskId !== 'string' || !binding.ref || typeof binding.ref !== 'object') return false
      const cur = load()
      const existing = cur.findIndex(b => b.taskId === binding.taskId)
      if (existing === -1 && cur.length >= MAX_BINDINGS) return false // cap only counts NEW ids
      const next = cur.filter(b => b.taskId !== binding.taskId)
      next.push({ taskId: binding.taskId, ref: binding.ref })
      if (!persist(next)) return false // disk is the truth: cache untouched on failure
      cache = next
      return true
    },
    remove (taskId) {
      const cur = load()
      if (!cur.some(b => b.taskId === taskId)) return false // idempotent, no write
      const next = cur.filter(b => b.taskId !== taskId)
      if (!persist(next)) return false
      cache = next
      return true
    },
    __setDirForTests (dir) { dirOverride = dir; cache = null }
  }
}
