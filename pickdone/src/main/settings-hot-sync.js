/** Settings hot-sync patch computation (extracted from index.js for testability, 2026-09-25).
 *  Diff two settings docs into the patch pushed to renderer windows. Machine-local bookkeeping
 *  keys (_savedAt/schemaV ordering stamps) and secret fields never travel. `_lsAt` MUST be in the
 *  exclusion set: the renderer re-stamps it on every apply (store/settings.js), so a patch
 *  containing it makes the broadcast re-persist the blob and re-arm the external-write watcher —
 *  a self-sustaining echo loop primed by any restart (2026-09-25 pool-only smoke crash). */
const MACHINE_LOCAL_KEYS = ['_savedAt', 'schemaV', '_lsAt']
const SECRET_KEYS = ['securityLockPassword', 'securityLockQuestion']

/** @returns {Record<string, unknown>} changed top-level keys, or an empty object when only
 *  bookkeeping keys moved (the loop breaker: an empty patch suppresses the broadcast). */
function computeSettingsPatch (doc, prev) {
  const patch = {}
  for (const k of Object.keys(doc)) {
    if (MACHINE_LOCAL_KEYS.includes(k)) continue
    if (JSON.stringify(doc[k]) !== JSON.stringify(prev[k])) patch[k] = doc[k]
  }
  for (const k of SECRET_KEYS) delete patch[k]
  return patch
}

module.exports = { computeSettingsPatch, MACHINE_LOCAL_KEYS, SECRET_KEYS }
