/** SourceRef verification state (pd20 P0 work-continuity, 2026-11-07).
 *  Single source for the freshness semantics shared by the storage view model
 *  (db-episode-ops querySourcesByTask) and the handoff export (shared/handoff.mjs):
 *    - 'unknown': the ref has never been verified (no lastVerifiedAt stamp) — provenance
 *      is a bare statement (L0) and nobody has checked the target since capture;
 *    - 'stale': the last verification is older than SOURCE_STALE_MS — the target may have
 *      moved/rotated/deleted since; treat as indicative, not authoritative;
 *    - 'fresh': verified within the horizon.
 *  Pure, zero dependencies. ESM .mjs per the shared/ convention (CJS consumers use
 *  require(esm), Node >= 22.12 / Electron 39 — same precedent as shared/machine-local-keys.mjs).
 */
export const SOURCE_STALE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days: a work-continuity ref older than two unverified weeks is stale

export const LEVELS = ['L0', 'L1', 'L2']

export function isKnownLevel (level) { return LEVELS.includes(String(level || '')) }

export function sourceFreshness (row, now) {
  const at = Number(row && row.lastVerifiedAt) || 0
  if (!at) return 'unknown'
  return (Number(now) || Date.now()) - at > SOURCE_STALE_MS ? 'stale' : 'fresh'
}
