/* Main-internal bulk variants for the LAN-sync apply path: a first-sync snapshot can carry
 * hundreds of categories/plans/filters and the per-row ops commit one transaction per row,
 * starving sync rounds the same way per-row todo commits did. Same no-op suppression semantics
 * as their single-row counterparts; the result is the list of ids that actually changed (feeds
 * the oplog's row-granular deltas). NOT renderer-callable (not in ALLOWED_RENDERER_OPS) —
 * reachable only via main-internal db.call. getOps is lazy because OPS references this module's
 * entries before the literal finishes evaluating. */
module.exports = (db, getOps) => ({
  upsertCategoryMany: list => {
    if (!Array.isArray(list)) throw new Error('[TodoDB] upsertCategoryMany: list must be an array, got ' + typeof list)
    const changed = []
    const tr = db.transaction(() => { for (const c of list) if (getOps().upsertCategory(c) !== false) changed.push(c && c.id) })
    tr(); return changed
  },
  filterUpsertMany: list => {
    if (!Array.isArray(list)) throw new Error('[TodoDB] filterUpsertMany: list must be an array, got ' + typeof list)
    const changed = []
    const tr = db.transaction(() => { for (const f of list) { const r = getOps().filterUpsert(f); if (r !== false) changed.push(r) } })
    tr(); return changed
  },
})
