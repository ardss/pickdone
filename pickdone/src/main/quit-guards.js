'use strict'

/**
 * D10 (2026-09-27) quit-chain guards, extracted from index.js so plain-node unit tests can reach
 * them (index.js cannot be require()d without executing the Electron app bootstrap — same reason
 * quit-ack.js / second-instance-gate.js exist).
 */

/**
 * Quit-hang fallback, armed BEFORE the awaited flush steps. Previously the 3s app.exit(0) timer
 * was created only AFTER stopSyncForQuit()/dbm.close() resolved — if any awaited step never
 * settled (stopSync's `await n.stop()` is unbounded), no timer existed and the windowless process
 * hung forever. The factory is injectable (setTimeout/clearTimeout/onExit) for tests; arm() must
 * be called synchronously at flushNow entry, disarm() once the flush completed and the re-issued
 * quit is in flight.
 */
function createHangFallback ({ timeoutMs = 3000, onExit, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  let timer = null
  return {
    /** Idempotent: registers the exit callback synchronously; a second arm while armed is a no-op. */
    arm () {
      if (timer) return
      timer = st(() => { timer = null; try { onExit() } catch { /* dying process */ } }, timeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref() // never hold the event loop open by ourselves
    },
    disarm () {
      if (timer) { ct(timer); timer = null }
    },
    get armed () { return timer != null }
  }
}

/**
 * Re-entrancy guard for quitFromTray: the async confirm dialog left a window where a second
 * tray-quit click entered the function again — two dialogs, two quit chains, and a cancel in one
 * invocation flipped state.quitByUser=false while the other proceeded to quit. enter() is called
 * synchronously at function entry (before the first await); exit() in finally.
 */
function createReentrancyGuard () {
  let busy = false
  return {
    /** false = already inside an active invocation: caller must return immediately. */
    enter () {
      if (busy) return false
      busy = true
      return true
    },
    exit () { busy = false },
    get busy () { return busy }
  }
}

/**
 * Pure decision for the top-level will-quit handler: the duplicate instance's app.quit()
 * (requestSingleInstanceLock loser) used to run the full preventDefault + quitAck + 500ms-floor
 * flushNow chain with a null db handle and no windows — exiting ~0.5s+ late for a no-op. Only an
 * instance that completed full startup (won the singleton lock) has anything to flush.
 */
function shouldRunQuitFlush ({ ranFullInit, flushDone, quitting }) {
  return !!(ranFullInit && !flushDone && !quitting)
}

module.exports = { createHangFallback, createReentrancyGuard, shouldRunQuitFlush }
