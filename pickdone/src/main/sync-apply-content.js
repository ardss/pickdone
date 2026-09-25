'use strict'
/**
 * Extracted from src/main/sync-apply.js (structure-size ratchet): the row content-equality
 * helper. Moved verbatim — sync-apply.js re-exports it (tests import it from there).
 */
const mergeCore = require('../../shared/sync-core/merge.mjs')

/** Content equality mirroring merge.mjs's contentDiffers (not exported there): bookkeeping fields
 *  (id/updatedAt/seq/deviceId/deletedAt markers + `deleted`) are excluded; `userId` too — peers
 *  stamp rows with their own local account id, so a userId-only difference must never churn. */
function rowContentDiffers (a, b) {
  const SKIP = new Set(['id', 'updatedAt', 'seq', 'deviceId', 'deletedAt', 'deleted', 'entity', 'ts', 'userId'])
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (SKIP.has(k)) continue
    const va = a[k]
    const vb = b[k]
    if (va === vb) continue
    // Payload objects (row.data) must be compared by CONTENT, not reference — otherwise the
    // "identical content: no-op" merge rule never fires and every round churns (round-3 fix).
    // contentFingerprint additionally omits userId at every depth: each device re-stamps its
    // own account id on write, so a data.userId-only difference is not content (loop fix
    // 2026-09-18 — this compare used to keep the perpetual per-round conflict loop alive).
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      // Key-order-insensitive canonical compare (peers build payloads with different key order)
      if (mergeCore.contentFingerprint(va) !== mergeCore.contentFingerprint(vb)) return true
      continue
    }
    return true
  }
  return false
}

module.exports = { rowContentDiffers }
