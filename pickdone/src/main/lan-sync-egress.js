/* LAN sync egress/ingest surface, extracted from lan-sync-bootstrap.js (structure-size ratchet).
 * Behavior-preserving split: the adapter implements the shared/sync-core engine.mjs localStore
 * contract, the ingest helpers are the snapshot receivers (unit-testable via the bootstrap's
 * __test), and buildSegmentsWrapped stamps pendingToSeq. Everything closes over the bootstrap's
 * module-level `state` singleton through the injected getState() accessor — the bootstrap assigns
 * state in initLanSync, so the functions must observe reassignment, not a captured value. */

/** Factory: receives the bootstrap's live bindings once, at module init after sync-apply is loaded.
 *  ctx = { getState, log, emitSyncEvent, syncApply, busWrite, flushPendingWrites, finalizeIngest,
 *          oplogKeepLimit, SYNC_OPLOG_KEEP, CURSOR_META_KEY, SYNC_SCHEMA_VERSION } */
function createEgressSurface (ctx) {
  const { log, emitSyncEvent, syncApply, busWrite, flushPendingWrites, finalizeIngest, oplogKeepLimit, SYNC_OPLOG_KEEP, CURSOR_META_KEY, SYNC_SCHEMA_VERSION } = ctx
  const state = () => ctx.getState()
  const createHydrationCache = () => syncApply.createHydrationCache(state())
  const hydrateRow = (ptr, cache) => syncApply.hydrateRow(state(), ptr, cache)
  const applyRowSafe = row => syncApply.applyRowSafe(state(), row)

  function createLocalStoreAdapter () {
    return {
      getRowsSince (seq) {
        const ptrs = state().db.call('syncOplogSince', { sinceSeq: seq, limit: oplogKeepLimit(SYNC_OPLOG_KEEP) }) || [] // D3 2026-09-24: was bare 10000
        const cache = createHydrationCache()
        // r2 2026-09-28: hydrateRow now RETHROWS on DB read failure (only legitimate skips return
        // null). A failure must not be silently filtered out with the cursor advancing past the
        // pointer — that lost changes one-way between full snapshots. Count it here, surface it in
        // the egress report (state.egressHydrationFailures) and log it.
        // S2 (2026-10-03) egress truncation contract: a failed hydration TRUNCATES the delta.
        // The old behavior kept pushing rows PAST the failure while buildSegments stamped the
        // segment's toSeq from the rows actually packed — but the ack contract is
        // 'acked toSeq => every oplog row <= toSeq was delivered', and the receiver acks seg.toSeq
        // at face value (server-role.js) with the sender advancing its watermark to the ack
        // (client-round peerProgress). One hydration failure therefore acked a seq range covering
        // a row that never left the device, and once the oplog ring pruned it the loss was
        // structurally permanent. Now egress stops at the first failed seq and reports it as
        // incompleteAtSeq; engine.buildSegments honors the marker so no segment can ever claim a
        // toSeq covering a row it did not include (whole class, single egress boundary).
        const rows = []
        const failures = []
        let incompleteAtSeq = null
        for (const ptr of ptrs) {
          let row = null
          try { row = hydrateRow(ptr, cache) } catch (e) {
            const f = { ...(e.egressHydration || { entity: ptr.entity, id: ptr.entityId, seq: ptr.seq }), error: e.message }
            failures.push(f)
            if (incompleteAtSeq == null || Number(ptr.seq) < incompleteAtSeq) incompleteAtSeq = Number(ptr.seq)
            continue
          }
          // Rows at/past the truncation point are scanned for failure VISIBILITY but never pushed.
          if (row && incompleteAtSeq == null) rows.push(row)
        }
        state().egressHydrationFailures = failures
        if (failures.length) {
          log.warn('[LanSync] egress hydration failed for ' + failures.length + ' oplog pointer(s) — delta TRUNCATED at seq ' + incompleteAtSeq + ':',
            failures.map(f => f.entity + ':' + f.id).join(', '))
          try { emitSyncEvent('egress-hydration-failed', { count: failures.length, failures, incompleteAtSeq }) } catch { /* event surface is best-effort */ }
        }
        // S2: adapters return { rows, incompleteAtSeq } (engine buildSegments contract); the
        // cursor semantics are unchanged — the sender's watermark can only advance over rows it
        // actually packed and the peer acked, so the truncated tail re-pushes on a later round.
        return incompleteAtSeq != null ? { rows, incompleteAtSeq } : rows
      },
      getCursor () { const v = state().db.call('getMeta', CURSOR_META_KEY); const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0 },
      setCursor (seq) { busWrite('setMeta', [CURSOR_META_KEY, String(seq)]) },
      applyRow: row => applyRowSafe(row),
      /** Current live rows incl. tombstones, for buildSnapshot (seq-less; engine sorts by id). */
      allRows () {
        const out = []
        for (const t of state().db.call('getAll', { deleted: null }) || []) {
          out.push({ entity: 'todo', id: t.taskId, updatedAt: t.updateTime || 0, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t })
        }
        for (const r of state().db.call('settingsRowsAll', {}) || []) {
          // 'sync.' = identity namespace; 'securityLock*' = password/question ciphertext — both must never leave this device (round-3 review: the settingsState bridge mirrors securityLock rows into settings_rows).
          if (syncApply.isMachineLocalSettingKey(r.key)) continue
          out.push({ entity: 'setting', id: r.key, updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt || 0, data: { key: r.key, value: r.value } })
        }
        for (const r of state().db.call('tomatoAll', {}) || []) out.push({ entity: 'tomato', id: r.tomatoId, updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r })
        for (const r of state().db.call('tomatoTombstones', {}) || []) out.push({ entity: 'tomato', id: r.tomatoId, updatedAt: r.updatedAt || 0, deleted: true, deletedAt: r.deletedAt || 0, data: null }) // X1: snapshot tombstones (rationale in sync-apply.js tomato localRow)
        // M1/M3 (2026-09-20): categories snapshot from the RAW row table — peers apply category data
        // through upsertCategory (row columns), and local tombstones must ride along (data:null) so a
        // fresh device learns about deletions. Same tombstone rule for plans/filters (delete-wins for locally deleted rows on the receiving side).
        for (const c of state().db.call('categoriesAllRows', {}) || []) out.push({ entity: 'category', id: String(c.id), updatedAt: c.updatedAt || 0, deleted: !!c.deleted, deletedAt: c.deletedAt || 0, data: c.deleted ? null : c })
        for (const c of state().db.call('planAll', {}) || []) out.push({ entity: 'plan', id: c.id, updatedAt: c.updatedAt || 0, deleted: false, deletedAt: 0, data: c })
        for (const t of state().db.call('planTombstones', {}) || []) out.push({ entity: 'plan', id: t.id, updatedAt: t.updatedAt || 0, deleted: true, deletedAt: t.deletedAt || 0, data: null })
        for (const f of state().db.call('filterList', {}) || []) out.push({ entity: 'filter', id: String(f.id), updatedAt: f.updatedAt || 0, deleted: false, deletedAt: 0, data: f })
        for (const t of state().db.call('filterTombstones', {}) || []) out.push({ entity: 'filter', id: String(t.id), updatedAt: t.updatedAt || 0, deleted: true, deletedAt: t.deletedAt || 0, data: null })
        // Meta entity (GAP-A fix 2026-09-19): meta has no list-read op (db.js is size-ratcheted), so
        // syncable meta keys used to be enumerated from their oplog pointers only — a live key whose
        // pointers fell out of the ring never appeared in a snapshot AND was refused on ingress
        // (B13 age-unknown gate): unsyncable in both directions until a local rewrite. D11 finding 4:
        // enumeration moved to sync-apply.metaSnapshotRows — the meta TABLE (listMetaKeys) with the
        // retained-pointer age, or the ring-floor bound for a trimmed key (paired ingress rule there).
        // Meta tombstones still propagate via increments only (a pointer whose value is already gone
        // reads as deleted in hydrateRow).
        for (const row of syncApply.metaSnapshotRows(state())) out.push(row)
        return out
      },
      /** Fresh-device path. P3a: merge-apply (non-destructive) — see header scope cuts. */
      replaceAll (rows) {
        for (const r of rows || []) applyRowSafe(r)
        // R7-B P2: a dropped bulk write here used to vanish silently (ingest paths stamp
        // flushFailed / throw; this path didn't). Surface the failure to the engine.
        const flush = flushPendingWrites()
        if (flush && flush.ok === false) throw new Error('replaceAll flush failed: ' + ((flush.error && flush.error.message) || 'unknown'))
      }
    }
  }

  function withPeerDeviceId (body) {
    if (body && typeof body === 'object' && body.deviceId && Array.isArray(body.rows)) {
      return { ...body, rows: body.rows.map(r => ({ ...r, deviceId: body.deviceId })) }
    }
    return body
  }

  // d12 (2026-10-02) schemaVersion gate: the snapshot RECEIVE path never read body.schemaVersion,
  // so a NEWER peer's snapshot applied rows silently on both the assembled and streaming paths.
  // Only a newer version is fatal (older versions are forward-compatible by the `|| 1` coercion
  // the senders already apply — server-role.js:149, client-round.js:461/515). The throw propagates
  // into the node's per-round snapshot error budget/backoff; the pull watermark advances only at
  // snapshot-end, so a rejected snapshot never skips missed increments.
  function assertPeerSnapshotSchema (body) {
    const peerVersion = Number(body && body.schemaVersion) || 1
    if (peerVersion > SYNC_SCHEMA_VERSION) {
      throw new Error('peer snapshot schemaVersion ' + (body && body.schemaVersion) + ' newer than supported ' + SYNC_SCHEMA_VERSION)
    }
  }

  // Module-level so unit tests can drive the receivers through __test without a live node
  // (the bodies were previously inline in the createLanSyncNode options inside startSync —
  // behavior-preserving extraction, same guards, same finalizeIngest call order).
  function ingestSnapshotAssembled (body) {
    assertPeerSnapshotSchema(body)
    const rows = Array.isArray(body && body.rows) ? body.rows : []
    state().applyCache = createHydrationCache()
    try {
      for (const r of withPeerDeviceId(body).rows || []) applyRowSafe(r)
      // P0-1: same flush-failure honesty as the streaming path — fail loudly so the watermark
      // never advances over rows that were dropped.
      finalizeIngest(null, { snapshot: true })
    } finally { state().applyCache = null }
    return { rows: rows.length }
  }

  function ingestSnapshotChunked (body) {
    assertPeerSnapshotSchema(body)
    const rows = Array.isArray(body && body.rows) ? body.rows : []
    state().applyCache = createHydrationCache()
    try {
      for (const r of withPeerDeviceId(body).rows || []) applyRowSafe(r)
      // P0-1: a failed flush during a streamed snapshot must fail the ROUND (throw) — the pull
      // watermark advances only at snapshot-end, so a failed chunk keeps the watermark put and
      // the next round re-requests the (idempotent) snapshot instead of acking dropped rows.
      finalizeIngest(null, { snapshot: true, chunk: true })
    } finally { state().applyCache = null }
    return { rows: rows.length }
  }

  function buildSegmentsWrapped (sinceSeq) {
    const r = state().engine.buildSegments(sinceSeq)
    state().pendingToSeq = r.toSeq
    return r.segments
  }

  return { createLocalStoreAdapter, withPeerDeviceId, assertPeerSnapshotSchema, ingestSnapshotAssembled, ingestSnapshotChunked, buildSegmentsWrapped }
}

module.exports = { createEgressSurface }
