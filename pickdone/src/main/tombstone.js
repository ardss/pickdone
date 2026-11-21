/** Tombstone stamps and ids — ONE copy of the rule "the peer's deletion time wins, else the local one".
 *
 *  Three delete paths (plan chips, the tomato ledger, the episode/pd20 family) had each hand-copied
 *  the same ten-line template. Two of them had already diverged on the edge that actually matters:
 *  a `deletedAt` arriving as the STRING "0" (or negative) is truthy for `o.deletedAt || dAt`, so it
 *  was written straight into the column as the tombstone's LWW age — the row then read as
 *  epoch-old on one table and got re-stamped on the other. A tombstone stamp is a POSITIVE epoch-ms
 *  or it is absent; nothing else is a deletion time.
 *
 *  Also: an item object without an id used to write the literal string "undefined" as the row key
 *  (a silent no-op UPDATE that still joined the changed-id list). It is skipped now.
 */

/** Positive finite epoch-ms or null (0 / "0" / negative / NaN / absent all mean "no stamp"). */
function positiveMs (v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Effective stamps for one delete item: a plain id string, or {id?, deletedAt?, updatedAt?}.
 *  `defaults` must already be resolved numbers (callers pass `opts.deletedAt || now`). */
function tombstoneStamps (item, { deletedAt, updatedAt = null } = {}) {
  const o = item && typeof item === 'object' ? item : null
  const d = positiveMs(o && o.deletedAt) ?? positiveMs(deletedAt)
  return { deletedAt: d, updatedAt: positiveMs(o && o.updatedAt) ?? positiveMs(updatedAt) ?? d }
}

/** Row key for a delete item; null when an object carries no usable id (caller must skip it). */
function tombstoneId (item, primaryKey = 'id') {
  if (item == null) return null
  if (typeof item !== 'object') return String(item)
  const v = item[primaryKey] != null ? item[primaryKey] : item.id
  return v == null || v === '' ? null : String(v)
}

module.exports = { positiveMs, tombstoneStamps, tombstoneId }
