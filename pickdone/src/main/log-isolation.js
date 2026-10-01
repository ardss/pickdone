/**
 * Test-isolation hook for electron-log's file transport (log-isolation fix).
 *
 * Problem: unit/integration tests run src/main modules in plain Node with only
 * TODO_DB_DIR set. Those modules require('electron-log') (present in node_modules),
 * and electron-log's file transport resolves the REAL app log path
 * (%APPDATA%/pickdone/logs/main.log) — test-seam lines like "injected migration failure"
 * / "poison row" polluted the real user's log.
 *
 * Fix at the root: when TODO_DB_DIR or TODO_USER_DATA_DIR is set (hasIsolationEnv()),
 * redirect the file transport into <isolation dir>/logs/main.log. When neither var is
 * set (the real app), this is a strict no-op. Idempotent; safe to require at the top of
 * every module that acquires electron-log — resolution happens lazily on each write, so
 * the last write before process exit uses the redirected path either way.
 *
 * Requires './user-dir' (path-only) — no electron dependency, loadable in plain Node.
 */
const path = require('path')
const { hasIsolationEnv, userDataDir } = require('./user-dir')

let applied = false

function applyLogIsolation () {
  if (applied) return
  if (!hasIsolationEnv()) return
  applied = true
  let log
  try { log = require('electron-log') } catch { return /* no electron-log in this process */ }
  try {
    const dir = path.join(userDataDir(), 'logs')
    log.transports.file.resolvePathFn = () => path.join(dir, 'main.log')
  } catch { /* file transport unavailable in this runtime */ }
}

applyLogIsolation()

module.exports = { applyLogIsolation }
