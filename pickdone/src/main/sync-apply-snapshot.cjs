/** Snapshot/watermark helpers extracted verbatim from sync-apply.js (size ratchet).
 *  deps are bound by sync-apply.js so this file stays a pure move — behavior identical,
 *  re-exported from sync-apply.js so the bootstrap/test import surface is unchanged. */
'use strict'

/**
 * Local max oplog seq — reported to peers as `ack.appliedToSeq` so their per-peer push watermarks
 * can advance and rounds ship deltas instead of re-pushing the full backlog every time.
 * syncOplogSince is ascending-only with a clamped limit, so page forward; the ring buffer keeps
 * ~10k rows, so this is one query in practice (two at most right after a trim boundary).
 */
function readMaxOplogSeq (state, SYNC_OPLOG_KEEP, oplogKeepLimit) {
  let since = 0
  for (let i = 0; i < SYNC_OPLOG_KEEP; i++) {
    const rows = state.db.call('syncOplogSince', { sinceSeq: since, limit: oplogKeepLimit(SYNC_OPLOG_KEEP) }) || []
    if (rows.length < SYNC_OPLOG_KEEP) return rows.length ? rows[rows.length - 1].seq : since
    since = rows[rows.length - 1].seq
  }
  return since
}

/**
 * D11 finding 4 (egress meta reconciliation): snapshot meta rows used to be enumerated ONLY from
 * retained oplog pointers — a live key whose pointers trimmed out of the ring was unsyncable in
 * BOTH directions. Enumerate from the meta TABLE instead (listMetaKeys), aged by the retained
 * pointer ts with the ring's floor ts as the honest BOUND for a trimmed key (paired with the
 * ingress bound rule in applyRowInner — closes the permanent-starvation class). Excluded:
 * machine-local meta + the settings/habits blobs. D13 finding 5: absent-valued keys with a
 * retained pointer are enumerated as TOMBSTONE rows (aged pointer ts / floor) so a local delete
 * invisible to snapshots cannot be LWW-resurrected by a stale peer copy. Residual: deletions
 * whose pointers trimmed entirely stay unresolvable by snapshot (documented).
 */
function metaSnapshotRows (state, createHydrationCache, isMachineLocalMetaKey, isSyncBlobMetaKey) {
  const cache = createHydrationCache(state)
  const tsMap = cache.metaTs()
  const floor = cache.metaFloorTs()
  const out = []
  for (const key of state.db.call('listMetaKeys') || []) {
    if (isMachineLocalMetaKey(key) || isSyncBlobMetaKey(key)) continue
    const v = cache.meta(key)
    if (v == null) continue // live enumeration only; deletions come from the pointer scan below
    out.push({ entity: 'meta', id: key, updatedAt: tsMap.get(key) || floor, deleted: false, deletedAt: 0, data: { key, value: v } })
  }
  // D13 finding 5: retained pointers for keys that no longer exist = locally deleted meta keys
  // (deleteMeta is the only way a meta key disappears). Emit each as a tombstone row aged by its
  // latest pointer ts (meta has no stamp column) so the deletion survives increment trimming.
  const live = new Set((state.db.call('listMetaKeys') || []).map(String))
  for (const [key, ts] of tsMap) {
    if (live.has(key)) continue
    if (isMachineLocalMetaKey(key) || isSyncBlobMetaKey(key)) continue
    out.push({ entity: 'meta', id: key, updatedAt: ts || floor, deleted: true, deletedAt: ts || floor, data: null })
  }
  return out
}

module.exports = { readMaxOplogSeq, metaSnapshotRows }
