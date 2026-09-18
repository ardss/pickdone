/**
 * PickDone sync-core: deterministic merge rules (design doc §4.2, roadmap §9 P2).
 *
 * TRANSPORT-ADAPTER BOUNDARY — read this before wiring a new transport:
 *   shared/sync-core/merge.mjs and shared/sync-core/segment.mjs are the ONLY
 *   sync semantics. Per docs/sync §8, both the P3a LAN adapter and the P3b
 *   cloud adapter must consume exactly these modules and nothing else from the
 *   app: they pack local oplog rows with segment.pack(), ship bytes over their
 *   own channel, and feed peer bytes through segment.unpack() + the merge*
 *   functions here. No adapter may re-implement conflict resolution or reach
 *   into db/renderer code — that is how the "merge is on-device, server is
 *   content-blind" principle (§3) stays enforceable on every platform
 *   (Electron / mobile / future TS extraction of @pickdone/sync-core).
 *
 * Rules implemented (§4.2 table):
 *   - todos / plan_chips: row-level LWW on updatedAt (seq as tiebreak);
 *     delete-wins: a tombstone beats a live row when deletedAt > updatedAt;
 *     the losing row's full content is returned as a conflict copy (never
 *     silently dropped — surfaces in the recycle bin).
 *   - tomato ledger: append-only, same tomatoId keeps the row with the larger
 *     focusDuration (billing: prefer recording MORE focus); tie -> later
 *     updatedAt.
 *
 * Determinism: every comparison uses only seq/updatedAt/deletedAt (and a
 * deviceId tiebreak for fully-identical keys). No Date.now(), no Math.random.
 * Pure ESM, zero Node/Electron imports.
 */

export const SYNC_SCHEMA_VERSION = 1

/**
 * Total-order recency key. Tombstones carry deletedAt as their effective
 * timestamp, which makes "delete wins iff deletedAt > live.updatedAt" a plain
 * LWW over a total order (hence transitive and chaos-convergent).
 */
function effectiveTs(row) {
  return row.deleted ? (row.deletedAt ?? row.updatedAt) : row.updatedAt
}

/**
 * Deterministic winner selection: later updatedAt wins; tie -> later seq;
 * full tie -> lexicographically greater deviceId (stable across peers).
 * Returns >0 if a is newer, <0 if b is newer, 0 if fully identical keys.
 */
function compareRecency(a, b) {
  const ta = effectiveTs(a)
  const tb = effectiveTs(b)
  if (ta !== tb) return ta > tb ? 1 : -1
  const sa = a.seq ?? 0
  const sb = b.seq ?? 0
  if (sa !== sb) return sa > sb ? 1 : -1
  const da = a.deviceId ?? ''
  const db = b.deviceId ?? ''
  if (da !== db) return da > db ? 1 : -1
  return 0
}

/** Content identity: every field except bookkeeping (updatedAt/seq/deletedAt markers/deviceId/id)
 *  and `userId` (an account identifier, not user content — peers stamp rows with their own local
 *  account id, so a userId-only difference must never count as a content conflict). */
const BOOKKEEPING = new Set(['id', 'updatedAt', 'seq', 'deviceId', 'deletedAt', 'userId'])
/** Key-order-insensitive JSON: peers build the payload object with different key insertion
 *  orders, so a content compare must sort keys recursively (round-3 fix). */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

function contentDiffers(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (BOOKKEEPING.has(k)) continue
    // `deleted` is part of state but not user content; skipping it here means
    // a stale tombstone losing to a live edit still yields no conflict copy.
    if (k === 'deleted') continue
    const va = a[k]
    const vb = b[k]
    if (va === vb) continue
    // Payload objects (row.data) compare by CONTENT, not reference or key order —
    // transport adapters rebuild the payload object per ingest, so reference
    // equality would report a conflict for byte-identical content (round-3 fix).
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      if (stableStringify(va) !== stableStringify(vb)) return true
      continue
    }
    return true
  }
  return false
}

function loserCopy(loser) {
  return { ...loser, conflictOf: loser.id, conflictAt: loser.updatedAt }
}

/**
 * Merge two versions of the same todo row (same id).
 * @returns {{ row: object, conflictCopy: object|null }}
 *   row = surviving version; conflictCopy = preserved full content of the
 *   loser when its user-visible content differs from the winner (null when
 *   the outcome is a pure tombstone/identical-content result).
 */
export function mergeTodoRows(local, remote) {
  if (!local) return { row: remote, conflictCopy: null }
  if (!remote) return { row: local, conflictCopy: null }
  const c = compareRecency(local, remote)
  if (c === 0) return { row: local, conflictCopy: null }
  const winner = c > 0 ? local : remote
  const loser = c > 0 ? remote : local
  const conflictCopy = contentDiffers(winner, loser) && !loser.deleted ? loserCopy(loser) : null
  return { row: winner, conflictCopy }
}

/**
 * plan_chips: row-level LWW + tombstone, identical rules to todos (doc §4.2:
 * `day` is a plain calendar string and takes no part in comparison).
 */
export function mergeChipRows(local, remote) {
  return mergeTodoRows(local, remote)
}

/**
 * Tomato ledger: append-only merge for the same tomatoId. Never deletes; the
 * row with the LARGER focusDuration wins (billing: over-record focus rather
 * than under-record); equal duration -> later updatedAt; then seq/deviceId.
 * @returns {{ row: object }} no conflict copy — ledger rows are additive.
 */
export function mergeTomatoRows(local, remote) {
  if (!local) return { row: remote }
  if (!remote) return { row: local }
  if (local.focusDuration !== remote.focusDuration) {
    return local.focusDuration > remote.focusDuration ? { row: local } : { row: remote }
  }
  const c = compareRecency(local, remote)
  return { row: c >= 0 ? local : remote }
}

/** Apply one incoming row into an in-memory Map store via the rules above. */
export function applyRow(store, incoming, { kind = 'todo' } = {}) {
  const merge = kind === 'tomato' ? mergeTomatoRows : mergeTodoRows
  const existing = store.get(incoming.id) ?? null
  const { row, conflictCopy } = merge(existing, incoming)
  store.set(incoming.id, row)
  return { row, conflictCopy }
}
