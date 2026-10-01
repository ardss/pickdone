'use strict'

/**
 * Multi-instance opt-in (single-machine sync debugging, 2026-10-01).
 *
 * Extracted from index.js as a plain module (same doctrine as quit-guards.js / quit-ack.js:
 * index.js cannot be require()d under plain node without executing the Electron bootstrap, so
 * every decision here must be unit-testable as a pure function).
 *
 * Contract:
 *   - Default (no PICKDONE_MULTI env): behavior is byte-identical to today — the global
 *     requestSingleInstanceLock() call with no arguments, one app instance per machine/user.
 *   - PICKDONE_MULTI=1: the lock is SCOPED PER DATA DIR. Electron's singleton lock file lives in
 *     the userData dir, so once index.js ran app.setPath('userData', TODO_USER_DATA_DIR) BEFORE the
 *     lock request (src/main/index.js), two instances with different data dirs already hold
 *     independent locks. The scope hash here (a) tags the lock via requestSingleInstanceLock's
 *     additionalData so a same-dir duplicate is unambiguously identifiable in the second-instance
 *     handler, and (b) feeds the window-title suffix ([TEST #hash]) so a human can tell the two
 *     running instances apart.
 *   - A lock LOSS still quits in multi mode: it means another instance of the SAME data dir is
 *     already running, which must stay a hard stop (SQLite single-writer safety).
 */

const crypto = require('node:crypto')

/** True only for the exact literal '1' (same opt-in style as other env gates in this repo). */
function isMultiEnabled (env) {
  return !!(env && env.PICKDONE_MULTI === '1')
}

/** Short deterministic scope id for a resolved userData dir (first 8 hex of sha256). */
function dirScopeHash (userDataDir) {
  return crypto.createHash('sha256').update(String(userDataDir || '')).digest('hex').slice(0, 8)
}

/**
 * Arguments for app.requestSingleInstanceLock().
 *   - multi mode  -> [{ pickdoneMultiScope: <hash> }] — additionalData tags the lock holder.
 *   - default     -> [] — the historical no-argument call, unchanged.
 */
function lockRequestArgs (env, userDataDir) {
  if (!isMultiEnabled(env)) return []
  return [{ pickdoneMultiScope: dirScopeHash(userDataDir) }]
}

/**
 * Pure decision for the top-level lock outcome. A lost lock always quits (both modes): in multi
 * mode the loss means a same-dir duplicate, never a different-dir sibling.
 */
function shouldQuitOnLockLoss ({ granted }) {
  return !granted
}

/**
 * Window-title suffix extending the existing [TEST] badge path (src/main/windows.js).
 * Multi instances get ' [#<hash>]' appended after [TEST]; everything else gets ''.
 */
function titleSuffix (env, userDataDir) {
  if (!isMultiEnabled(env)) return ''
  return ' [#' + dirScopeHash(userDataDir) + ']'
}

module.exports = { isMultiEnabled, dirScopeHash, lockRequestArgs, shouldQuitOnLockLoss, titleSuffix }
