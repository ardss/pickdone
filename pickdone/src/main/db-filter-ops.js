/**
 * Saved-filter ops extracted verbatim from db.js (structure-size ratchet). Pure relocation:
 * db.js keeps thin delegates in OPS so every db.call surface and return shape is unchanged.
 */
// D4 2026-09-24: conds whitelist/parse moved to shared/filter-core.mjs (single source with
// cli/lib.js applyViewConds and renderer FilterView.vue — the three copies could drift silently)
const { normConds, parseConds } = require('../../shared/filter-core.mjs') // require(esm) — Node >= 22.12

// ===== Saved filters (smart lists): conds stores the condition JSON (catId/priority/dateMode) =====
// Deletes are tombstones (P1 sync groundwork): a soft-deleted filter row must survive to propagate
// to other devices; the recycle semantics stay invisible because filterList filters deleted=0.
// F3b (2026-09-20): updatedAt exposed — the sync LWW gate needs the row's age, otherwise a
// filter edit from a peer was refused for any filter this device already had (ageUnknown).
exports.filterList = db => db.prepare('SELECT * FROM filters WHERE deleted = 0 ORDER BY sort, id').all().map(r => ({ id: r.id, name: r.name, conds: parseConds(r.conds), sort: r.sort, updatedAt: r.updatedAt || 0 }))

exports.filterUpsert = (db, f) => {
  const name = String(f && f.name || '').slice(0, 50)
  const conds = JSON.stringify(normConds(f && f.conds))
  if (f.id) {
    // P2 2026-09-17 no-op suppression (same rule as upsertCategory): re-saving identical content
    // used to overwrite updatedAt=now (faking LWW freshness) and emit a fake oplog delta per save.
    // Un-deletes on conflict are intentional, so a resurrected tombstone still writes.
    const cur = db.prepare('SELECT name, conds, sort, deleted, updatedAt FROM filters WHERE id = ?').get(f.id)
    if (cur && cur.deleted === 0 && cur.name === name && cur.conds === conds && cur.sort === (f.sort || 0)) return false
    // M2 (2026-09-20): preserve an explicit updatedAt (sync apply carries the peer row's LWW age)
    // instead of re-stamping now() — same rationale as planAddMany above. Renderer callers omit it and get now().
    const stamp = Number(f.updatedAt) > 0 ? Number(f.updatedAt) : Math.max(Date.now(), ((cur && cur.updatedAt) || 0) + 1) // D20: strictly monotonic vs the row's own stamp — two same-ms edits must still advance LWW (F3b red on fast CI disks)
    const info = db.prepare('UPDATE filters SET name=?, conds=?, sort=?, deleted=0, deletedAt=0, updatedAt=? WHERE id=?').run(name, conds, f.sort || 0, stamp, f.id)
    // Round-1 P0 (2026-09-21): sync apply passes an explicit id — when the row does not exist
    // locally the UPDATE matched 0 rows, yet the oplog still logged a phantom pointer and the
    // next egress fabricated a fresh tombstone for it (delete-wins LWW then deleted the
    // SOURCE's live filter). INSERT fallback mirrors planAddMany/upsertCategory upsert
    // semantics: an explicit id that is absent locally is created, never tombstoned.
    if (info.changes === 0) {
      db.prepare('INSERT INTO filters (id, name, conds, sort, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(f.id, name, conds, f.sort || 0, stamp, stamp)
    }
    return f.id
  }
  const stamp = Number(f && f.updatedAt) > 0 ? Number(f.updatedAt) : Date.now()
  const r = db.prepare('INSERT INTO filters (name, conds, sort, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(name, conds, f.sort || 0, Date.now(), stamp)
  return Number(r.lastInsertRowid)
}

// R7 P1-2: opts {deletedAt, updatedAt} (sync apply path) preserve the winner's tombstone stamps —
// a local re-stamp replaced the true deletion time and re-won LWW on the origin (echo bounce).
// Idempotent: an already-deleted row is left untouched (no re-stamp, no phantom oplog delta).
exports.filterDelete = (db, id, opts = {}) => {
  // db.call passes params verbatim: the sync path sends [id, {deletedAt, updatedAt}] as one arg
  if (Array.isArray(id)) { opts = id[1] || {}; id = id[0] }
  const now = Date.now()
  const dAt = (opts && opts.deletedAt) || now
  const r = db.prepare('UPDATE filters SET deleted=1, deletedAt=?, updatedAt=? WHERE id = ? AND deleted=0').run(dAt, (opts && opts.updatedAt) || dAt, id)
  return r.changes > 0
}
