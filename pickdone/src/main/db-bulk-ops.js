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
})
