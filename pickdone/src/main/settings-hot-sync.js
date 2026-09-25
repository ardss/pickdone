/** Settings hot-sync patch computation (extracted from index.js for testability, 2026-09-25).
 *  Diff two settings docs into the patch pushed to renderer windows. Machine-local bookkeeping
 *  keys (_savedAt/schemaV ordering stamps) and secret fields never travel. `_lsAt` MUST be in the
 *  exclusion set: the renderer re-stamps it on every apply (store/settings.js), so a patch
 *  containing it makes the broadcast re-persist the blob and re-arm the external-write watcher —
 *  a self-sustaining echo loop primed by any restart (2026-09-25 pool-only smoke crash). */
const mergeCore = require('../../shared/sync-core/merge.mjs')
// C3 (maint): SECRET_KEYS moved to the shared manifest so producer and consumer gates share one
// copy (require(.mjs) pattern proven by sync-apply.js requiring sync-core/merge.mjs).
const { SECRET_KEYS } = require('../../shared/settings-manifest.mjs')
const MACHINE_LOCAL_KEYS = ['_savedAt', 'schemaV', '_lsAt']

/** @returns {Record<string, unknown>} changed top-level keys plus explicit `null` deletion
 *  markers (B3: a key present in `prev` but gone from `doc` used to vanish silently — the patch
 *  was set-only, so every other window kept the stale key in its live store until restart and
 *  could even re-persist it, undoing the peer's tombstone). `null` survives structured-clone IPC
 *  and is unambiguous; the consumer (sanitizeSettingsPatch) resets a null-marked declared key to
 *  its DEFAULT value. An empty object still suppresses the broadcast (the loop breaker). */
function computeSettingsPatch (doc, prev) {
  const patch = {}
  const before = (prev && typeof prev === 'object') ? prev : {}
  for (const k of Object.keys(doc)) {
    if (MACHINE_LOCAL_KEYS.includes(k)) continue
    // B12: key-order-insensitive canonical compare — JSON.stringify preserves key insertion
    // order, so two equal-content nested objects (shortcutKeySettings rebuilt with a different
    // key order after a LAN-sync apply) compared as different and broadcast a spurious patch.
    // Same contentFingerprint pattern sync-apply.js already uses for row payloads.
    if (mergeCore.contentFingerprint(doc[k]) !== mergeCore.contentFingerprint(before[k])) patch[k] = doc[k]
  }
  for (const k of Object.keys(before)) {
    if (MACHINE_LOCAL_KEYS.includes(k) || SECRET_KEYS.includes(k)) continue
    if (!(k in doc) && !(k in patch)) patch[k] = null
  }
  for (const k of SECRET_KEYS) delete patch[k]
  return patch
}

module.exports = { computeSettingsPatch, MACHINE_LOCAL_KEYS, SECRET_KEYS }
