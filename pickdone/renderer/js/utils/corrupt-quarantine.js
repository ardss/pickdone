/**
 * Corrupt-payload quarantine — the one shared renderer primitive behind the invariant
 * "degradation may stop replay but must never destroy the durability payload's raw bytes"
 * (established in tomato.js TQ-5, honoring the main-process pattern at
 * src/main/db-sync-schema.js: retry-keep-in-place). Every renderer site that destructively
 * degrades an unparseable payload must route through here instead of ad-hoc `catch { reset }`:
 * a parse failure must quarantine the raw bytes BEFORE anything overwrites them, or the only
 * copy of the data is destroyed.
 *
 * Bounded (newest kept, CORRUPT_QUARANTINE_CAP entries per scope): the quarantine is a manual
 * recovery surface, not a growth vector. Writes go through the RAW throwing setItem (TQ-6:
 * durability writes are loud) — callers in degradation contexts wrap it in their own loud catch.
 */
const CORRUPT_QUARANTINE_CAP = 10

const quarantineKey = scope => 'corruptQuarantine.' + scope

/** Append one corrupt payload's raw bytes to the scope's bounded quarantine.
 *  Throws on any storage failure — the caller decides whether degradation may proceed
 *  (proceeding after a failed quarantine would destroy the bytes, so callers that are about
 *  to drop/overwrite the source must treat a throw as "keep the bytes in place"). */
export function preserveCorrupt (scope, key, raw) {
  const qKey = quarantineKey(scope)
  let parked = []
  const existing = localStorage.getItem(qKey)
  if (existing != null) {
    try { parked = JSON.parse(existing) } catch (e) {
      // The quarantine file itself rotted: preserve ITS bytes under a .bad sibling before the
      // append below overwrites them — same invariant, one level down. .bad is a raw setItem
      // (never parsed), so the recursion terminates there.
      try { localStorage.setItem(qKey + '.bad', existing) } catch (e2) { /* .bad slot lost */ }
      parked = []
    }
    if (!Array.isArray(parked)) {
      try { localStorage.setItem(qKey + '.bad', existing) } catch (e2) { /* .bad slot lost */ }
      parked = []
    }
  }
  parked.push({ scope, key, ts: Date.now(), raw })
  localStorage.setItem(qKey, JSON.stringify(parked.slice(-CORRUPT_QUARANTINE_CAP)))
}
