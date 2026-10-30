/**
 * userData directory — THE single source (P3-9, dw wave). Both consumers read this module:
 *   - cli/lib.js userDataDir() (previously copy #1, with the audit.js copy being the third
 *     assembly the lib.js comment explicitly forbade)
 *   - src/main/audit.js defaultDirResolver (previously copy #2 with its own env priority chain)
 * No src/main → cli reverse dependency: this module lives under src/main and the CLI requires it.
 *
 * Env var relationship (backward compatible):
 *   TODO_DB_DIR        — legacy CLI-only override; points DIRECTLY at the data directory that
 *                        contains todos.db (behavior unchanged)
 *   TODO_USER_DATA_DIR — the main-process isolation var (src/main/index.js); treated as the
 *                        userData root, which also contains todos.db at its top level
 * Priority: TODO_DB_DIR > TODO_USER_DATA_DIR > boot redirect (data-location.cjs) > platform
 * default. Neither var set means the real user database — scripts that spawn the App MUST fail
 * fast instead (see e2e-walkthrough.js / ui-smoke.js).
 *
 * B#1 split-brain fix: after a data-location migration the App boots into the boot-redirect dir,
 * but this default branch used to compute the platform default directly — the CLI then opened a
 * DIFFERENT database than the running App. The boot file is consulted before the platform
 * fallback (both are pure node; the require is safe and cheap). Read errors fall through.
 */
const path = require('path')

function userDataDir () {
  if (process.env.TODO_DB_DIR) return process.env.TODO_DB_DIR
  if (process.env.TODO_USER_DATA_DIR) return process.env.TODO_USER_DATA_DIR
  try {
    const boot = require('./data-location.cjs').readBootRedirect()
    if (boot) return boot
  } catch (e) { /* boot file unreadable / module issue → platform default */ }
  // Platform default must mirror Electron's app.getPath('userData') (~/.config/pickdone on Linux,
  // ~/Library/Application Support/pickdone on macOS) — APPDATA-only resolved to CWD-relative
  // './pickdone' on Linux, so CLI and App each opened a different database (2026-09-11 audit P1)
  if (process.platform === 'darwin') return path.join(process.env.HOME || '', 'Library', 'Application Support', 'pickdone')
  if (process.platform === 'linux') {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'pickdone')
  }
  return path.join(process.env.APPDATA || '', 'pickdone')
}

/** True when an explicit isolation dir (TODO_DB_DIR or TODO_USER_DATA_DIR) is set */
function hasIsolationEnv () {
  return !!(process.env.TODO_DB_DIR || process.env.TODO_USER_DATA_DIR)
}

module.exports = { userDataDir, hasIsolationEnv }
