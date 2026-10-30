/**
 * Test-isolation hook for electron-log's file transport (log-isolation fix).
 *
 * Problem: unit/integration tests run src/main modules in plain Node with only
 * TODO_DB_DIR set. Those modules require('electron-log') (present in node_modules),
 * and electron-log's file transport resolves the REAL app log path
 * (%APPDATA%/pickdone/logs/main.log) — test-seam lines like "injected migration failure"
 * / "poison row" polluted the real user's log.
 *
 * Fix at the root: install log.transports.file.resolvePathFn UNCONDITIONALLY at module
 * load, and re-evaluate the isolation env (TODO_DB_DIR / TODO_USER_DATA_DIR) at every
 * WRITE via the closure. The old shape installed the redirect only when hasIsolationEnv()
 * happened to be true at require time, so a module loaded BEFORE the test set the env
 * (the d9-drill-side harness, aux-load-guard chains) permanently no-op'd and wrote the
 * real user log (2026-10-30 confirmed). Write-time evaluation is timing-immune: whether
 * the env was set before or after this module loaded, the next write lands in
 * <isolation dir>/logs/main.log when an isolation env is present, and in electron-log's
 * default path (the original resolvePathFn) when it is not — the real app path is
 * byte-identical in behavior.
 *
 * Semantics preserved: the hook still activates only where this module is explicitly
 * required (idempotent — the first apply wins), and electron-log's own file rotation /
 * fileName handling is untouched (we only override where the path resolves).
 *
 * Requires './user-dir' (path-only) — no electron dependency, loadable in plain Node.
 */
const path = require('path')
const { hasIsolationEnv, userDataDir } = require('./user-dir')

let applied = false

function applyLogIsolation () {
  if (applied) return
  let log
  try { log = require('electron-log') } catch { return /* no electron-log in this process */ }
  applied = true
  try {
    // Capture the transport's default resolver ONCE as the non-isolated fallback, so the
    // real-app behavior (platform default dir + file rotation naming) is delegated to
    // electron-log itself instead of being re-implemented here.
    const defaultResolve = log.transports.file.resolvePathFn
    log.transports.file.resolvePathFn = (...args) => {
      // Write-time evaluation: the isolation env may have been set (or cleared) after this
      // module was required — decide per write, never per install.
      if (hasIsolationEnv()) return path.join(userDataDir(), 'logs', 'main.log')
      return typeof defaultResolve === 'function' ? defaultResolve(...args) : undefined
    }
  } catch { /* file transport unavailable in this runtime */ }
}

applyLogIsolation()

module.exports = { applyLogIsolation }
