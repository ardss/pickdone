'use strict'
/**
 * S4 — user-visible delete-vs-edit adjudication layer (sync-v2 acceptance matrix, S4 entry).
 *
 * Problem: delete-vs-edit collisions in the v1 LWW pipeline resolve by silent defaults —
 * the plan/filter tombstone-keep guard drops the inbound edit with zero trace, a
 * sameLineage todo deletion destroys the local edit without a conflict copy, and
 * setting/category deletions land without any user-visible direction. The user only
 * finds out when their content is gone.
 *
 * Contract (double opt-in: sync.revisions.v2 + sync.revisions.v2.adjudicate, default OFF):
 *   1. Every delete-vs-edit collision persists an explicit adjudication record under a
 *      machine-local meta key `sync.adjudication.<entity>:<id>` ({direction, winner,
 *      source, evidence}) — 'sync.*' never syncs to peers (isMachineLocalMetaKey).
 *   2. The direction is user-perceivable: the collision joins the per-round conflict
 *      summary (markConflict → consumeAppliedRound → the one-per-round sync toast).
 *   3. Failure is not silent: a failed record write NEVER fails the apply (the v1
 *      outcome is untouched) but is counted into the round summary (adjudicationFailed).
 *   4. Evidence reuses the S2 DVV metadata: the entity's current revision dot (a locally
 *      tombstoned entity's dot IS the deletion's causal position) is attached when present.
 *
 * Flag off → this module returns before any I/O: byte-identical v1 behavior.
 *
 * This module also hosts the conflict-surfacing helpers moved out of sync-apply.js
 * (meta conflict backup trio, S2 causalInboundRelation seam) to honor that file's
 * structure-size ratchet (only-split-never-grow).
 */

const log = require('electron-log')
require('./log-isolation')
// Moved-with dependency: the dated backup key prefix lives in sync-apply-hydrate (single source).
const { META_CONFLICT_BACKUP_PREFIX } = require('./sync-apply-hydrate')

// Machine-local meta key prefix for the durable adjudication ledger. Never synced.
const ADJUDICATION_META_PREFIX = 'sync.adjudication.'

/** Flag gate: base sync.revisions.v2 AND the adjudicate sub-flag (S2-style double opt-in). */
function adjudicationEnabled (state) {
  try {
    const st = (state && state.db && state.db.call) ? state.db.call('revisionsFlagState', {}) : null
    return !!(st && st.on && st.adjudicate)
  } catch { return false }
}

/** S2 metadata reuse: the entity's current revision DVV dot (read-only), or null. */
function dvvEvidenceFor (state, entityId) {
  try {
    const rows = state.db.call('revisionsList', { entityId, limit: 50 }) || []
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && rows[i].dvv && rows[i].dvv.dot) return rows[i].dvv.dot
    }
  } catch { /* evidence is best-effort; the stamp evidence already stands */ }
  return null
}

/**
 * THE S4 entry: classify one resolved delete-vs-edit collision, persist the adjudication
 * record, surface the direction, and count failures — without ever changing the v1
 * outcome. `payload`: { entity, incoming, localRow, winner, source, conflictCopySurfaced }.
 * `write` is the sync write door (sync-apply busWrite) — injected to avoid a require cycle.
 */
function adjudicateDeleteEditOutcome (state, payload, write) {
  try {
    if (!state || !payload || !payload.incoming || !payload.localRow || typeof write !== 'function') return
    if (!adjudicationEnabled(state)) return
    const { entity, incoming, localRow, winner, source } = payload
    const localDeleted = !!localRow.deleted
    const incomingDeleted = !!incoming.deleted
    if (localDeleted === incomingDeleted) return // not a delete-vs-edit collision
    const winnerDeleted = winner ? !!winner.deleted : localDeleted
    const direction = winnerDeleted ? 'delete-dominates' : 'edit-dominates'
    const winnerName = winnerDeleted
      ? (winner === incoming ? 'remote-delete' : 'local-delete')
      : (winner === incoming ? 'remote-edit' : 'local-edit')
    const record = {
      at: Date.now(),
      entity,
      id: String(incoming.id),
      direction,
      winner: winnerName,
      source: source || 'lww',
      evidence: {
        localDeletedAt: localRow.deletedAt || 0,
        localUpdatedAt: localRow.updatedAt || 0,
        incomingUpdatedAt: incoming.updatedAt || 0,
        incomingDeletedAt: incoming.deletedAt || 0,
      },
    }
    const dvvDot = dvvEvidenceFor(state, record.id)
    if (dvvDot) record.evidence.dvvDot = dvvDot
    const res = persistAdjudication(state, record, write)
    // User-perceivable direction (one toast per round via consumeAppliedRound). Skip when
    // the conflict-copy block already surfaced THIS collision — no double toast.
    if (!payload.conflictCopySurfaced) markConflictEntry(state, entity, record.id, winnerName.indexOf('remote') === 0)
    if (!res.ok) {
      if (!state.applied) state.applied = { kinds: new Set(), settingsPatch: {}, conflicts: [] }
      state.applied.adjudicationFailed = (state.applied.adjudicationFailed || 0) + 1
      log.warn('[LanSync] S4 adjudication record FAILED for', entity, record.id, '(apply outcome unchanged, failure surfaced):', res.error)
    }
  } catch (e) {
    // The adjudicator must never break the apply pipeline (mirror the appendOplog contract).
    log.warn('[LanSync] S4 adjudication failed (non-fatal):', e && e.message)
  }
}

/** Durable machine-local record. Best-effort: returns {ok:false,error} instead of throwing. */
function persistAdjudication (state, record, write) {
  try {
    const key = ADJUDICATION_META_PREFIX + record.entity + ':' + record.id
    write(state, 'setMeta', [key, JSON.stringify(record)])
    return { ok: true, key }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

/** Local replica of sync-apply markConflict (kept in sync to the byte: one entry per event). */
function markConflictEntry (state, entity, name, applied) {
  if (!state.applied) state.applied = { kinds: new Set(), settingsPatch: {}, conflicts: [] }
  state.applied.conflicts.push({ entity, name: String(name || ''), applied: !!applied })
}

/* ---------- conflict-surfacing helpers moved from sync-apply.js (size ratchet) ---------- */

const META_CONFLICT_BACKUP_CAP = 20
// MS-collision fix (2026-09-26): process-lifetime monotonic counter mixed into backup-key /
// conflict-copy-id suffixes so two mints within the same millisecond can never collide
// (Date.now() alone did). Monotonic per process: preserves sort order for the count-based prune.
let backupSeq = 0

/**
 * P1-5: persist one losing meta value under a dated backup key and prune older backups for
 * the same base key beyond META_CONFLICT_BACKUP_CAP. Best-effort: a backup failure must never
 * fail the apply (the LWW winner still lands).
 */
/** D17: age order for meta-conflict-backup keys of one base key — by PARSED (ts36, seq36), not
 *  raw string order. Within a single millisecond the base-36 counter crosses a digit boundary
 *  (...'y','z','10','11'...) and lexicographic sort ranks '10' BELOW 'z', so the NEWEST backup
 *  sorted as if oldest and the prune deleted the freshest loser. Unparsable/legacy keys sort
 *  oldest (string order among themselves) so they are pruned first, never the parsed newest. */
function compareMetaBackupKeys (a, b) {
  const pa = parseMetaBackupKeySuffix(a)
  const pb = parseMetaBackupKeySuffix(b)
  if (pa && pb) return (pa.ts - pb.ts) || (pa.seq - pb.seq)
  if (pa !== pb) return pa ? 1 : -1 // parsed keys are always newer than unparsable ones
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}
/** `<prefix><key>.<ts36>-<seq36>` → { ts, seq } (numeric), or null when the suffix does not parse. */
function parseMetaBackupKeySuffix (k) {
  const m = /\.([0-9a-z]+)-([0-9a-z]+)$/.exec(String(k))
  if (!m) return null
  const ts = parseInt(m[1], 36)
  const seq = parseInt(m[2], 36)
  return (Number.isFinite(ts) && Number.isFinite(seq)) ? { ts, seq } : null
}

function writeMetaConflictBackup (state, key, value, write) {
  if (typeof write !== 'function') throw new Error('writeMetaConflictBackup: write door required')
  try {
    // MS-collision fix (2026-09-26): the key used to be `.<ts36>` alone — two conflict backups
    // of the SAME base key minted within one millisecond (bulk apply loop) produced identical
    // keys and the second setMeta silently OVERWROTE the first (the earlier losing value was
    // lost). A module-level monotonic counter appended after the ts keeps the mint order
    // (ts36 dominates across milliseconds; the counter orders within one) while making every
    // key unique. Prune order itself is the PARSED numeric compare above (D17) — the raw string
    // sort broke at the base-36 counter digit rollover.
    const ts36 = `${Date.now().toString(36)}-${(backupSeq++).toString(36)}`
    const backupKey = `${META_CONFLICT_BACKUP_PREFIX}${key}.${ts36}`
    const prefix = `${META_CONFLICT_BACKUP_PREFIX}${key}.`
    // Prune: keep only the latest META_CONFLICT_BACKUP_CAP backups per base key.
    const keys = (state.db.call('listMetaKeys') || []).filter(k => String(k).startsWith(prefix)).sort(compareMetaBackupKeys)
    for (const old of keys.slice(0, Math.max(0, keys.length - (META_CONFLICT_BACKUP_CAP - 1)))) {
      try { write(state, 'deleteMeta', old) } catch { /* prune is best-effort */ }
    }
    write(state, 'setMeta', [backupKey, JSON.stringify({ key, value, lostAt: Date.now() })])
    log.warn('[LanSync] meta LWW conflict on', key, '— loser backed up as', backupKey)
  } catch (e) { log.warn('[LanSync] meta conflict backup failed for', key, e.message) }
}

/**
 * S2 — unified causal RECEIVE seam (classification only, default OFF, zero v1 impact),
 * moved verbatim from sync-apply.js (size ratchet; re-exported there for compatibility).
 *
 * How the causal entries are wired (write AND receive):
 *   WRITE (already unified): every local business write AND every applied inbound row
 *   funnels through db.call → db-revisions record() — with the `sync.revisions.v2.dvv`
 *   sub-flag on, each minted revision carries a persisted dotted version vector. Nothing
 *   in the apply pipeline needed to change for the write side.
 *   RECEIVE (this seam): the future v2 transport receiver classifies an inbound envelope
 *   against the persisted local DAG via causalInboundRelation(state, envelope) BEFORE
 *   applying, then routes through applyRowSafe — where S4 surfaces any delete-vs-edit
 *   adjudication:
 *     'descendant' → applyRowSafe (fast-forward, v1 pipeline lands it)
 *     'ancestor'   → skip (stale; watermark may advance)
 *     'equal'      → skip (duplicate content)
 *     'unknown'    → fall back to the existing LWW merge (legacy peer / pre-DVV data)
 *     'concurrent' → applyRowSafe (LWW + conflict copy, the losing branch is preserved)
 *   Default OFF (sub-flag off): returns { enabled: false, relation: 'unknown' } and the
 *   v1 LWW pipeline behaves exactly as before. READ-ONLY — never writes, never mutates
 *   state, never touches the transport or the v1 switches.
 */
function causalInboundRelation (state, envelope) {
  try {
    const st = (state && state.db && state.db.call) ? state.db.call('revisionsFlagState', {}) : null
    if (!st || !st.on || !st.dvv) return { enabled: false, relation: 'unknown' }
    const store = state.db.call('revisionsStoreSnapshot', {})
    if (!store || !store.currentByEntity || !store.revisions) return { enabled: true, relation: 'unknown' }
    const currentId = envelope && envelope.entityId != null ? store.currentByEntity.get(String(envelope.entityId)) : null
    const current = currentId ? store.revisions.get(currentId) : null
    return { enabled: true, relation: dvvRelationFor(envelope, current) }
  } catch (e) {
    // Read-only seam: any failure degrades to 'unknown' (the v1 fallback), never throws.
    log.warn('[LanSync] causalInboundRelation failed (falling back to LWW):', e && e.message)
    return { enabled: false, relation: 'unknown' }
  }
}

/** Pure dvvRelation loaded lazily so this module stays loadable in bare test harnesses. */
function dvvRelationFor (candidate, current) {
  return require('../../shared/sync-core/causality/dvv.mjs').dvvRelation(candidate, current)
}

module.exports = {
  ADJUDICATION_META_PREFIX,
  META_CONFLICT_BACKUP_CAP,
  adjudicationEnabled,
  adjudicateDeleteEditOutcome,
  persistAdjudication,
  dvvEvidenceFor,
  compareMetaBackupKeys,
  parseMetaBackupKeySuffix,
  writeMetaConflictBackup,
  causalInboundRelation,
}
