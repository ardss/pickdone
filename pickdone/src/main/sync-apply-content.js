'use strict'
/**
 * Extracted from src/main/sync-apply.js (structure-size ratchet): the row content-equality
 * helper. Moved verbatim — sync-apply.js re-exports it (tests import it from there).
 */
const mergeCore = require('../../shared/sync-core/merge.mjs')

/** Content equality mirroring merge.mjs's contentDiffers (not exported there): bookkeeping fields
 *  (id/updatedAt/seq/deviceId/deletedAt markers + `deleted`) are excluded; `userId` too — peers
 *  stamp rows with their own local account id, so a userId-only difference must never churn.
 *  `author` (protocol v3 provenance) is bookkeeping for the same reason: identical content from
 *  different writers must stay a no-op, not manufacture a conflict. */
function rowContentDiffers (a, b) {
  const SKIP = new Set(['id', 'updatedAt', 'seq', 'deviceId', 'deletedAt', 'deleted', 'entity', 'ts', 'userId', 'author'])
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

/* ---------- D18 (2026-10-02) move from sync-apply.js (structure-size ratchet; sync-apply.js
 * re-exports both — tests import from there). ---------- */

/** Content key for conflict-copy dedup: the losing payload modulo bookkeeping (taskId/
 *  updateTime/tombstone markers) and the per-device userId stamp. Two copies of the same
 *  base row with equal keys carry the same user-visible lost content. */
function conflictCopyContentKey (data) {
  const rest = { ...data }
  delete rest.taskId
  delete rest.userId
  delete rest.updateTime
  delete rest.deletedAt
  delete rest.delete
  return mergeCore.contentFingerprint(rest)
}

/** Idempotent copy materialization (loop fix 2026-09-18): true when the recycle bin already
 *  holds a `-conflict-` copy of `baseId` with the same content key — minting another would
 *  grow the bin by one copy per round for as long as the (now normalized) row keeps bouncing.
 *  D18: a scan failure (persistent getAll throw) used to return false — the caller then minted
 *  a NEW -conflict- row EVERY round (unbounded recycle growth). Returns null on failure =
 *  INDETERMINATE: the caller skips minting this round (the conflict stays pending and
 *  re-arrives with the next push) instead of duplicating. */
function hasEquivalentConflictCopy (state, baseId, loserData) {
  try {
    const prefix = `${baseId}-conflict-`
    const key = conflictCopyContentKey(loserData)
    for (const t of state.db.call('getAll', { deleted: null }) || []) {
      const id = String(t.taskId || '')
      if (id.startsWith(prefix) && conflictCopyContentKey(t) === key) return true
    }
    // Batch-safety (2026-09-28 3-machine drill): a copy minted earlier in THIS apply batch is
    // still sitting in pendingWrites (commitSyncBatch defers the flush), invisible to the
    // getAll scan above — a second conflict on the same base row in the same round then minted
    // a duplicate recycle-bin copy. Scan the pending buffer with the same fingerprint.
    for (const t of state.pendingWrites.todos || []) {
      const id = String(t.taskId || '')
      if (id.startsWith(prefix) && conflictCopyContentKey(t) === key) return true
    }
    return false
  } catch (e) {
    try { require('electron-log').warn('[LanSync] conflict-copy dedup scan failed (treated as indeterminate):', e.message) } catch { console.warn('[LanSync] conflict-copy dedup scan failed (treated as indeterminate):', e.message) }
    return null
  }
}

module.exports.conflictCopyContentKey = conflictCopyContentKey
module.exports.hasEquivalentConflictCopy = hasEquivalentConflictCopy
