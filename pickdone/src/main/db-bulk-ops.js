/* Main-internal bulk variants + sync-side raw reads for the LAN-sync apply path: a first-sync
 * snapshot can carry hundreds of categories/plans/filters and the per-row ops commit one
 * transaction per row, starving sync rounds the same way per-row todo commits did. Same no-op
 * suppression semantics as their single-row counterparts; the result is the list of ids that
 * actually changed (feeds the oplog's row-granular deltas). NOT renderer-callable (not in
 * ALLOWED_RENDERER_OPS) — reachable only via main-internal db.call. getOps is lazy because OPS
 * references this module's entries before the literal finishes evaluating.
 *
 * Sync-side raw reads (2026-09-20 M1/M3 round): the user-facing list ops (getAllCategories /
 * planAll / filterList) return the hydrated APP shape and hide tombstones, which starved the
 * sync layer of both the raw row columns (categories) and the tombstone rows (all three) it
 * needs for row-shape apply and delete-wins LWW. These reads expose the raw rows; keep them
 * here (not db.js) — db.js is size-ratcheted and these are sync-internal. */
module.exports = (getDb, getOps) => ({
  // Sync-5 result-awareness (moved from db.js, structure-size ratchet): both ops return the
  // ids PHYSICALLY deleted ([] for an absent id) — the oplog keys its tombstone pointers off
  // this, so a hardDelete of an id that was never here emits no phantom delta (it used to
  // return true unconditionally and told peers to delete a row they may still hold live).
  // Cascaded cleanups stay unconditional (orphans from a partial earlier delete must still
  // die); only the todo row's own DELETE decides the result. Same transaction packaging as
  // before (a crash between the statements must not leave orphan plan_chips).
  hardDelete: id => {
    let ids = []
    const gc = require('./db-meta-gc.cjs')(getDb)
    const tr = getDb().transaction(() => {
      getDb().prepare('DELETE FROM plan_chips WHERE taskId=?').run(String(id))
      gc.deleteSnowDedupKeysFor([id]); gc.deleteChipsSnapshotKeysFor([id]); gc.deleteEstimateKeysFor([id])
      pruneFiredReminderKeysFor(getDb, [id])
      if (getDb().prepare('DELETE FROM todos WHERE id = ?').run(id).changes > 0) ids = [String(id)]
    })
    tr(); return ids
  },
  hardDeleteMany: ids => {
    const deleted = []
    const gc = require('./db-meta-gc.cjs')(getDb)
    const tr = getDb().transaction(() => ids.forEach(i => {
      getDb().prepare('DELETE FROM plan_chips WHERE taskId=?').run(String(i))
      gc.deleteSnowDedupKeysFor([i]); gc.deleteChipsSnapshotKeysFor([i]); gc.deleteEstimateKeysFor([i])
      pruneFiredReminderKeysFor(getDb, [i])
      if (getDb().prepare('DELETE FROM todos WHERE id = ?').run(i).changes > 0) deleted.push(String(i))
    }))
    tr(); return deleted
  },
  upsertCategoryMany: list => {
    if (!Array.isArray(list)) throw new Error('[TodoDB] upsertCategoryMany: list must be an array, got ' + typeof list)
    const changed = []
    const tr = getDb().transaction(() => { for (const c of list) if (getOps().upsertCategory(c) !== false) changed.push(c && c.id) })
    tr(); return changed
  },
  filterUpsertMany: list => {
    if (!Array.isArray(list)) throw new Error('[TodoDB] filterUpsertMany: list must be an array, got ' + typeof list)
    const changed = []
    const tr = getDb().transaction(() => { for (const f of list) { const r = getOps().filterUpsert(f); if (r !== false) changed.push(r) } })
    tr(); return changed
  },
  // RAW category rows (row shape: id/name/color/createdAt/sort/isFolder/parentId/deleted/deletedAt/
  // updatedAt), tombstones included — the sync hydration/apply path must never see the hydrated
  // app shape (categoryName/...), which upsertCategory cannot bind (M1).
  categoriesAllRows: () => getDb().prepare('SELECT * FROM categories').all(),
  // Tombstone-only reads (M3): a LOCALLY deleted chip/filter must take part in inbound LWW like a
  // settings/tomato tombstone, otherwise ANY older peer live row resurrects it.
  planTombstones: () => getDb().prepare('SELECT id, updatedAt, deletedAt FROM plan_chips WHERE deleted = 1').all(),
  filterTombstones: () => getDb().prepare('SELECT id, updatedAt, deletedAt FROM filters WHERE deleted = 1').all(),
  // D22 (P3, 2026-10-02): drop fired-reminder watermark entries for physically deleted taskIds —
  // hardDelete/hardDeleteMany/purgeRecycleBin cascade snowDedup/chips/estimate families but never
  // touched the scheduler's `firedReminders:` meta blob, whose entries outlived their tasks
  // forever. Chosen option: prune the blob HERE at delete time (the in-process LRU in scheduler.js
  // keeps its stale entry harmlessly — it only dedupes; reloadAll re-loads from meta). Blob format
  // owned by scheduler.js: JSON array of [key, ts], keys `taskId:offset`. Legacy non-JSON blobs
  // are left untouched rather than mis-parsed. Runs inside the caller's transaction; a prune
  // failure must never fail the delete (the watermark is advisory).
  pruneFiredReminderKeysFor: ids => pruneFiredReminderKeysFor(getDb, ids),
})

// D22 (P3, 2026-10-02): drop fired-reminder watermark entries for physically deleted taskIds —
// hardDelete/hardDeleteMany cascade snowDedup/chips/estimate families but never touched the
// scheduler's `firedReminders:` meta blob, whose entries then outlived their tasks forever.
// Minimal duplicate of db.js pruneFiredReminderKeysFor (db-meta-gc.cjs is outside this module's
// ratchet boundary): JSON-array blob only (legacy packed blobs are left untouched), runs inside
// the caller's transaction, and a prune failure must never fail the delete.
function pruneFiredReminderKeysFor (getDb, ids) {
  try {
    const list = (Array.isArray(ids) ? ids : [ids]).map(String)
    if (!list.length) return
    const row = getDb().prepare("SELECT value FROM meta WHERE key = 'firedReminders:'").get()
    const raw = row && row.value
    if (typeof raw !== 'string' || !raw.startsWith('[')) return
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    const kept = arr.filter(entry => {
      const k = String((Array.isArray(entry) && entry[0]) || '')
      return !list.some(id => k.startsWith(id + ':'))
    })
    if (kept.length !== arr.length) getDb().prepare("UPDATE meta SET value = ? WHERE key = 'firedReminders:'").run(JSON.stringify(kept))
  } catch { /* the watermark is advisory */ }
}
