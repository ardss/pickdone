/**
 * F4 P3 (2026-10-18) runRound reentry guard — size-ratchet extraction from lan-sync-bootstrap.js.
 * The 5-minute interval timer and kickSyncRound could fire while a previous round was still
 * awaiting its sockets, and two concurrent rounds ran syncWithPeer against the SAME peer
 * concurrently (racing writes through both sides' ingest). Modeled on the relay-sync-adapter.js
 * polling guard: an async-reentry flag turns an overlapping call into a no-op that latches a
 * dirty flag; when the in-flight round settles the follow-up runs exactly once, so no
 * kick-triggered delta is ever dropped (re-push is idempotent, sync-matrix §4.1).
 */
module.exports = function makeGuardedRound (roundBody, { log, name = 'round' } = {}) {
  let inFlight = false
  let queuedAgain = false
  const run = async () => {
    if (inFlight) { queuedAgain = true; log.info('[LanSync] ' + name + ' skipped — previous round still in flight (follow-up queued)'); return null }
    inFlight = true
    try { return await roundBody() } finally {
      inFlight = false
      // A kick fired mid-round: run exactly one follow-up round so its delta still ships.
      if (queuedAgain) { queuedAgain = false; const t = setTimeout(() => { run() }, 50); t.unref?.() }
    }
  }
  return run
}
