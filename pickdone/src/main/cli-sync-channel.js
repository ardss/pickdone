/* CLI sync command channel (2026-09-21, feat/cli-sync-pair).
 *
 * Mirrors the cliTomatoCmd pattern one-for-one: the CLI process writes a JSON command into the
 * machine-local meta slot `cliSyncCmd` (seq-deduped via the atomic `nextCliSyncSeq` counter), the
 * App's external-write DB watcher polls it, and this handler dispatches into the SAME db-sync-ops
 * registry the renderer's Device Center uses (syncGetStatus / syncPairRequest / syncPairRespond /
 * syncPairWithCode / syncUnpairPeer / syncGetPairingCode) — no parallel pairing logic, the CLI can
 * never drift from the UI's capability surface. The receipt is written back to the machine-local
 * meta slot `cliSyncState` ({seq, ok, ...}) and the CLI polls for `state.seq === cmd.seq`.
 *
 * Contract notes:
 *  - seq is consumed BEFORE handling (same trade-off as cliTomato: a crash mid-pair loses that one
 *    command; a retry with a fresh seq always works). Long-running commands (pair waits up to the
 *    transport's 60s confirm window) do NOT block later commands: each seq is answered
 *    independently, so `sync status` stays responsive while a pair is in flight.
 *  - `pair-respond` mirrors the renderer contract exactly: with a pending inbound request it calls
 *    syncPairRespond({accept}); with no pending request an explicit 6-digit --code falls back to
 *    the manual code flow (syncPairWithCode) so either side of the pair can be scripted headless.
 *  - Receipt writes go through the plain setMeta statement (no separate oplog surface), matching
 *    cliTomatoState; both meta keys are machine-local (sync-apply.js isMachineLocalMetaKey).
 */
function createSyncCmdHandler ({ dispatch, setMeta, log, getMeta, deleteMeta }) {
  // Round-1 P0 (2026-09-21): lastSeq used to start at 0 per process, so a cliSyncCmd slot that
  // survived the previous app run (e.g. an old `unpair`) was REPLAYED on every restart — the
  // secret rotated and the peer silently dropped. Seed the watermark from the persisted
  // `cliSyncSeq` counter (every command consumed a seq, so anything still in the slot is
  // <= counter = already handled), and delete the slot after handling so a crashed/closed app
  // cannot re-execute it either.
  let lastSeq = 0
  try { lastSeq = Number(typeof getMeta === 'function' ? getMeta('cliSyncSeq') : 0) || 0 } catch { lastSeq = 0 }
  // Round-2 P1 (2026-09-21): seeding from the counter alone could DROP a queued command — the CLI
  // consumes a seq BEFORE the app writes the slot, so a crash between slot-write and handle left
  // cmd.seq === counter, which the counter watermark then skipped forever. When the slot holds a
  // command at exactly the counter, seed the watermark from THE SLOT (counter - 1) so the command
  // is handled once; clearHandledSlot then deletes it, so a second restart (slot gone) seeds from
  // the counter again and nothing re-executes.
  try {
    if (typeof getMeta === 'function') {
      const queued = JSON.parse(getMeta('cliSyncCmd') || 'null')
      if (queued && Number.isFinite(queued.seq) && Number(queued.seq) === lastSeq) lastSeq -= 1
    }
  } catch { /* malformed slot: counter watermark stands */ }
  const clearHandledSlot = async (cmd) => {
    try {
      if (typeof deleteMeta !== 'function' || typeof getMeta !== 'function') return
      const cur = JSON.parse(getMeta('cliSyncCmd') || 'null')
      // Compare-and-delete: only clear the slot when it STILL holds the command we just
      // handled — a newer command must never be eaten by an older handler's cleanup.
      if (cur && Number(cur.seq) === Number(cmd.seq)) deleteMeta('cliSyncCmd')
    } catch (e) { log.warn('[CLI] sync slot cleanup failed:', e.message) }
  }
  const respond = (seq, payload) => {
    try { setMeta('cliSyncState', JSON.stringify({ seq, at: Date.now(), ...payload })) } catch (e) { log.warn('[CLI] sync receipt write failed:', e.message) }
  }
  async function handle (cmd) {
    const { action, seq } = cmd
    try {
      if (action === 'status') return respond(seq, { ok: true, action, status: dispatch('syncGetStatus') })
      if (action === 'pairing-code') return respond(seq, { ok: true, action, code: dispatch('syncGetPairingCode') })
      if (action === 'pair') {
        const status = await dispatch('syncPairRequest', { host: cmd.host, port: cmd.port })
        return respond(seq, { ok: true, action, status })
      }
      if (action === 'pair-respond') {
        const pending = dispatch('syncGetStatus').pendingPair
        if (pending) {
          const result = dispatch('syncPairRespond', { accept: cmd.accept !== false })
          if (!result || result.ok === false) return respond(seq, { ok: false, action, error: (result && result.error) || 'pair-respond failed' })
          return respond(seq, { ok: true, action, result })
        }
        if (cmd.code && /^\d{6}$/.test(String(cmd.code))) {
          const result = await dispatch('syncPairWithCode', { code: String(cmd.code) })
          return respond(seq, { ok: true, action, result })
        }
        return respond(seq, { ok: false, action, error: 'no pending pair request and no 6-digit --code given' })
      }
      if (action === 'unpair') {
        const result = dispatch('syncUnpairPeer', { deviceId: cmd.deviceId })
        return respond(seq, { ok: true, action, result })
      }
      return respond(seq, { ok: false, action, error: 'unknown cliSyncCmd action: ' + action })
    } catch (e) {
      respond(seq, { ok: false, action, error: String((e && e.message) || e) })
    }
  }
  /** Called on every external-write poll tick with the raw cliSyncCmd meta value (may be null). */
  function forward (raw) {
    let cmd = null
    let parseFailed = false
    try { cmd = raw ? JSON.parse(raw) : null } catch { parseFailed = true }
    // D6 P2 (2026-09-21): a non-empty but unparseable (or seq-less) slot value used to be
    // silently swallowed — the CLI had already consumed its seq, so no receipt ever arrived
    // and `cli sync` waited forever. A poisoned slot must be compare-and-deleted (only when
    // the meta value is STILL the payload we just failed on — a newer valid command must
    // never be eaten) so the next poll starts clean and the CLI gets an error receipt.
    if (parseFailed || (cmd && !Number.isFinite(cmd.seq))) {
      if (raw != null && String(raw).length) {
        log.warn('[CLI] cliSyncCmd slot held an unparseable payload, clearing it:', String(raw).slice(0, 120))
        // No error receipt is possible: the payload carries no usable seq to receipt against
        // (a seq-0 receipt would desync the CLI's state polling). Clearing the slot unblocks
        // the next poll; the CLI's own timeout reports the failure.
        try {
          if (typeof deleteMeta === 'function' && typeof getMeta === 'function' && getMeta('cliSyncCmd') === raw) deleteMeta('cliSyncCmd')
        } catch (e) { log.warn('[CLI] poisoned slot cleanup failed:', e.message) }
      }
      return
    }
    if (!cmd || cmd.seq <= lastSeq) return
    lastSeq = cmd.seq
    // Slot cleanup after handling (see clearHandledSlot): no restart replay of a handled command.
    Promise.resolve(handle(cmd)).finally(() => { clearHandledSlot(cmd) })
  }
  return { forward }
}

module.exports = { createSyncCmdHandler }
