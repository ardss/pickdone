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

/* Bounded relaunch-on-lock-loss (multi mode only, 2026-10-01).
 *
 * On Windows a lock request denied immediately after a hard kill is usually a STALE
 * holder: the killed instance's still-dying child processes can hold the singleton
 * mutex for a short window after the main process is gone. The failed request is also
 * CACHED by Electron — a retry inside the same process always returns false (verified
 * against the real electron binary: request again after the holder died -> still false).
 * Net effect without this fix: crash -> relaunch silently does nothing (clean exit,
 * no logs), which is exactly the user's "killed the app and it won't start again".
 *
 * So in multi mode a lost lock relaunches the app exactly once (count carried via a
 * --pickdone-lock-retry argv flag). One hop is what the crash-restart case needs: by
 * the time the relaunched child reaches the lock request the dying tree is long gone,
 * so it wins. A genuine same-dir duplicate is denied again and terminates cleanly —
 * verified on Windows that a SECOND relaunch hop can hang inside Chromium's
 * second-instance notify before our code ever runs, so the chain is deliberately
 * capped at one. Default (non-multi) mode is untouched: no relaunch, no delay. */

const LOCK_RETRY_FLAG = '--pickdone-lock-retry='
const LOCK_RETRY_MAX = 1
const LOCK_RETRY_DELAY_MS = 500

/* Stale singleton lockfile (Windows root cause, 2026-10-01, reproduced + instrumented):
 * Chromium's ProcessSingleton keeps a '<userData>/lockfile' open WITHOUT FILE_SHARE_DELETE.
 * After a hard kill (taskkill /F), the surviving crashpad_handler holds that handle for
 * ~10-15s more; meanwhile every new launch fails the lock with "Lock file can not be
 * created! Error code: 32" (sharing violation) and — before the relaunch fix — quit
 * silently. Chromium logs the error to stderr but the app shows nothing. So in multi
 * mode we wait out the stale handle (unlink is our probe: EBUSY = still held, ENOENT or
 * success = free) before requesting the lock. A LIVE holder keeps the file undeletable
 * for its whole lifetime, so the wait is bounded and times out into the normal lock
 * request (which then correctly denies a real duplicate).
 *
 * D15 C2 (2026-10-03): that premise is WINDOWS-ONLY. On POSIX unlink() succeeds even while
 * a live holder has the file open — the old unlink-loop DELETED a live holder's lockfile,
 * letting a second instance take the lock on the same data dir (SQLite double-writer
 * corruption). POSIX now proves staleness from the lockfile CONTENT instead: Chromium
 * writes 'hostname-pid'; a parseable pid that is still alive means a live holder (never
 * unlink, report immediately — no wait can free it); a dead/unparseable pid means a
 * genuine leftover and is unlinked. Unlink-success alone never proves anything here.
 *
 * D15 C3: the wait is also bounded lower (20s -> 8s). The stale crashpad handle lives
 * ~10-15s; the remaining gap is covered by the existing one relaunch hop (500ms pre-lock
 * delay + retry), so a hard-kill restart still succeeds — the user-facing worst case for
 * the tail is one extra launch attempt, not a 20s frozen pre-window main thread. The wait
 * now also logs at start so a visible pre-window stall is attributable. On POSIX the pid
 * check resolves immediately — no wait loop at all. */

const STALE_LOCKFILE_MAX_WAIT_MS = 8_000
const STALE_LOCKFILE_POLL_MS = 250

/** Extract the holder pid from Chromium's singleton lockfile content ('hostname-pid'). */
function lockfileHolderPid (content) {
  const m = /-(\d+)\s*$/.exec(String(content || ''))
  return m ? Number(m[1]) : null
}

/** Signal-0 liveness probe (EPERM counts as alive: a pid we may not signal still exists). */
function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}

/** Current retry-attempt count from argv (0 on a normal launch). */
function lockRetryCount (argv) {
  const hit = (argv || []).find(a => String(a).startsWith(LOCK_RETRY_FLAG))
  const n = hit ? parseInt(String(hit).slice(LOCK_RETRY_FLAG.length), 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** argv for app.relaunch(): the original arguments minus argv[0] (electron.exe — relaunch
 *  reuses execPath) and minus any previous retry flag, plus the bumped retry counter.
 *  argv[1] (the app path) is resolved against cwd: a dev launch uses the RELATIVE '.',
 *  and the relaunched child does not inherit a cwd where '.' still resolves — without
 *  this the relaunch silently dies before the app ever loads (observed on Windows). */
function relaunchArgv (argv, nextCount, cwd) {
  const cleaned = (argv || []).filter(a => !String(a).startsWith(LOCK_RETRY_FLAG))
  const rest = cleaned.slice(1)
  if (rest.length && cwd) rest[0] = require('node:path').resolve(cwd, rest[0])
  return [...rest, LOCK_RETRY_FLAG + nextCount]
}

/** Relaunch (bounded) on a lost lock — multi mode only, below the attempt cap. */
function shouldRelaunchOnLockLoss (env, argv) {
  return isMultiEnabled(env) && lockRetryCount(argv) < LOCK_RETRY_MAX
}

/** Pre-lock delay only on retry launches: gives the previous instance's dying process
 *  tree time to release the singleton mutex before the fresh request. */
function preLockDelayMs (argv) {
  return lockRetryCount(argv) > 0 ? LOCK_RETRY_DELAY_MS : 0
}

/** Synchronous sleep for the pre-lock delay (main thread, pre-ready — async is not an
 *  option: requestSingleInstanceLock must run before ready). */
function sleepSync (ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    return
  } catch { /* Atomics.wait unavailable here: busy spin */ }
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

/** Wait out and clear a stale singleton lockfile in userDataDir (multi mode only).
 *  Returns { cleared, waitedMs }: cleared=true means the file is gone (or never existed),
 *  so the singleton lock request can proceed; cleared=false means it was still held (or —
 *  POSIX — held by a PROVEN-LIVE holder, flagged as liveHolder) — the caller proceeds
 *  anyway and lets the real lock request decide (a live holder must still deny us). */
function clearStaleSingletonLockFileSync (userDataDir, { maxWaitMs = STALE_LOCKFILE_MAX_WAIT_MS, pollMs = STALE_LOCKFILE_POLL_MS, platform = process.platform } = {}) {
  const lockPath = require('node:path').join(userDataDir, 'lockfile')
  if (platform !== 'win32') {
    // D15 C2: on POSIX, unlink-success is NOT evidence of a stale lock (unlink works on a
    // live holder's open file). Prove staleness from the content's holder pid before removing.
    const fs = require('node:fs')
    let content = null
    try {
      content = fs.readFileSync(lockPath, 'utf8')
    } catch (e) {
      if (e && e.code === 'ENOENT') return { cleared: true, waitedMs: 0 }
      // unreadable for another reason: not proven stale — let the lock request decide
      return { cleared: false, waitedMs: 0 }
    }
    const pid = lockfileHolderPid(content)
    if (pid !== null && pidAlive(pid)) {
      try { console.warn('[multi-instance] singleton lockfile held by LIVE pid', pid, '— leaving it alone; the lock request will deny a real same-dir duplicate') } catch { /* noop */ }
      return { cleared: false, waitedMs: 0, liveHolder: true }
    }
    // dead pid (or no parseable pid = not a Chromium lock): genuine leftover, safe to remove
    try { fs.unlinkSync(lockPath); return { cleared: true, waitedMs: 0 } } catch (e) {
      if (e && e.code === 'ENOENT') return { cleared: true, waitedMs: 0 }
      return { cleared: false, waitedMs: 0 }
    }
  }
  try { console.warn('[multi-instance] waiting out a possibly-stale singleton lockfile (up to ' + maxWaitMs + 'ms, Windows-only unlink probe): ' + lockPath) } catch { /* noop */ }
  for (let waitedMs = 0; ; waitedMs += pollMs) {
    try {
      require('node:fs').unlinkSync(lockPath)
      return { cleared: true, waitedMs }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { cleared: true, waitedMs }
      if (waitedMs + pollMs >= maxWaitMs) return { cleared: false, waitedMs }
    }
    sleepSync(pollMs)
  }
}

module.exports = {
  isMultiEnabled, dirScopeHash, lockRequestArgs, shouldQuitOnLockLoss, titleSuffix,
  lockRetryCount, relaunchArgv, shouldRelaunchOnLockLoss, preLockDelayMs, sleepSync,
  clearStaleSingletonLockFileSync, lockfileHolderPid, pidAlive,
  LOCK_RETRY_FLAG, LOCK_RETRY_MAX, LOCK_RETRY_DELAY_MS,
  STALE_LOCKFILE_MAX_WAIT_MS, STALE_LOCKFILE_POLL_MS
}
