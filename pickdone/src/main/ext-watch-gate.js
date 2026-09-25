'use strict'
/* C11 (2026-09-26): quit gate for the external-DB-write poll (index.js watchDbForExternalWrites).
 *
 * Root cause this answers: the fs.watchFile poll ticked every 500ms and its forward closures
 * (forwardTomatoCmd/forwardSyncCmd) ran on EVERY tick — including ticks landing inside the
 * quit flush window (stopDbWatch only runs at flushNow, up to 2s after will-quit entry). A tick
 * in that window could read via dbm.call, forward a pending CLI command to an already-flushed
 * renderer, and delete the consumed slot — a command whose resulting write then lands after
 * dbm.close() and is silently dropped (permanent command loss, the F2 class).
 *
 * The gate is armed at will-quit entry (before the flush window opens) and every onChange tick
 * consults it first: no db reads, no wc.send, no slot-delete commits once quitting has started.
 * Extracted into its own module so the decision is unit-testable without loading the electron
 * entry (index.js). */
let armed = false

module.exports = {
  /** Called from index.js will-quit, alongside `quitting = true`. */
  arm () { armed = true },
  /** Single decision point for every poll tick. */
  canPoll () { return !armed },
  isArmed () { return armed },
  __reset () { armed = false }, // test-only
}
