/**
 * Shared CLI command-slot policy (2026-09-28 r2). The slot abandon/seed strategy used to be
 * hand-written TWICE — external-db-watch.js (cliTomatoCmd) and cli-sync-channel.js (cliSyncCmd) —
 * with the TTL constant duplicated and kept in sync only by a comment. Any policy change had to
 * land in both copies or they drifted immediately. This module is the single definition:
 *   - CLI_SLOT_ABANDON_TTL_MS: a slot command older than this was already given up on by the CLI
 *     (waitForTomatoAck 8s / waitForSyncAck 15s, both far below it) — the app must not execute it.
 *   - seedSlotWatermark: the startup seed decision — fresh queued command at the counter keeps
 *     crash-recovery execute-once semantics (seed counter-1); a stale (abandoned) one keeps the
 *     counter watermark and hands the slot to the caller-side compare-and-delete callback.
 *   - isStaleSlotCmd(cmd, now): the runtime/seed TTL-abandon PREDICATE — r6 2026-09-28. The
 *     `at > 0 && now - at > TTL` expression used to be hand-copied at THREE consumers
 *     (seedSlotWatermark below, fix-util.tryForwardTomatoCmd, cli-sync-channel.forward) and any
 *     single-side tightening drifted silently. One predicate, three call sites.
 * Pure/injected (no electron, no I/O): the compare-and-delete stays a caller callback so this
 * stays free of db dependencies, same shape as fix-util.tryForwardTomatoCmd's clearCmd.
 */
const CLI_SLOT_ABANDON_TTL_MS = 60 * 1000

/** True when `cmd` is one the CLI already STAMPED (`at`) and left to go stale past the abandon
 *  TTL — it reported APP_NOT_RUNNING and will never poll this seq again; the app must consume it
 *  WITHOUT executing. A command without an `at` stamp (foreign/legacy writer) keeps execute-once. */
function isStaleSlotCmd (cmd, now) {
  const at = Number(cmd && cmd.at) || 0
  return at > 0 && (Number(now) || 0) - at > CLI_SLOT_ABANDON_TTL_MS
}

/** Decide the startup watermark for a CLI command slot channel.
 *  @param {number|string} counter  persisted seq counter (every consumed command bumped it)
 *  @param {string|null} slotRaw    raw meta value of the command slot (JSON or null)
 *  @param {number} now             current epoch ms (injected for testability)
 *  @param {Function} [onAbandon]  called with the queued cmd when it is abandoned; the CALLER
 *                                 performs the compare-and-delete of the slot (never eat a
 *                                 newer command that landed while seeding).
 *  @returns {number} the watermark. Fresh queued cmd at the counter → counter-1 (execute once);
 *                    stale/abandoned, missing slot, malformed slot, or seq<counter → counter. */
function seedSlotWatermark ({ counter, slotRaw, now, onAbandon }) {
  let lastSeq = Number(counter) || 0
  try {
    const queued = JSON.parse(slotRaw || 'null')
    if (queued && Number.isFinite(queued.seq) && Number(queued.seq) === lastSeq) {
      // Only a slot the CLI STAMPED (`at`) and left to go stale is abandoned; a slot without a
      // stamp (foreign/legacy) keeps the crash-recovery execute-once semantics.
      if (isStaleSlotCmd(queued, now)) {
        if (typeof onAbandon === 'function') { try { onAbandon(queued) } catch { /* best-effort cleanup */ } }
      } else {
        lastSeq -= 1
      }
    }
  } catch { /* malformed slot: counter watermark stands */ }
  return lastSeq
}

module.exports = { CLI_SLOT_ABANDON_TTL_MS, seedSlotWatermark, isStaleSlotCmd }
