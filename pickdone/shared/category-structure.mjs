/**
 * Category structure guards — SINGLE SOURCE (F4 fix 2026-10-17).
 *
 * Three guards the CLI has enforced at command level since v02 (cli/lib-categories.cjs):
 *   CATEGORY_CYCLE         — a category may not be its own ancestor (direct or via descendants)
 *   CATEGORY_NOT_FOLDER    — the parent row must be a live folder (the App only nests inside folders)
 *   CATEGORY_NESTED_FOLDER — folders are roots only (a nested folder is silently dropped from the
 *                            sidebar: renderer `hierarchical` renders folders as roots and nests
 *                            only non-folder children)
 * plus CATEGORY_NOT_FOUND for a parent row that exists but is tombstoned.
 *
 * The guards used to exist ONLY in the CLI; the sync channel and the renderer's
 * addCategory/updateCategory wrote isFolder/parentId straight into the SQLite categories table
 * (via upsertCategory), so both could land a nested folder, a parent pointing at a non-folder or
 * a deleted row, or a parent/child cycle the CLI could never produce. The guards now sink to the
 * DB write bottleneck (src/main/db-category-ops.js upsertCategory) and the CLI/renderer reuse
 * this same core so the three implementations cannot drift.
 *
 * Consumers:
 *   - src/main/db-category-ops.js + cli/lib-categories.cjs: CJS require(esm) (Node >= 22.12,
 *     same precedent as shared/machine-local-keys.mjs / shared/filter-core.mjs)
 *   - renderer/js/store/category.js: plain ESM import
 *
 * Contract: validateCategoryStructure(row, findRow) returns null when the structure is legal, or
 * a structured { code, message } error object. `findRow(id)` returns a normalized row view
 * ({ id, isFolder: bool, deleted: bool, parentId }) or null when the id has no row. Ids are
 * compared string-wise so number/string id shapes (row vs app shape) never false-positive.
 *
 * Deliberate leniency (pinned by tests): a parent id with NO row at all is allowed through —
 * sync first-sync snapshots are not order-guaranteed (a child row may be buffered before its
 * folder), and a live row whose parent id points at nothing renders invisibly (neither roots nor
 * children) — the known orphan design item, unchanged by these guards. A DELETED parent row,
 * however, is refused: upserting a child under a tombstone is the exact dangling-reference bug
 * this module exists to stop.
 */

const err = (code, message) => ({ code, message })

export function validateCategoryStructure (row, findRow) {
  const id = row && row.id != null ? String(row.id) : null
  const rawPid = row && row.parentId
  const pid = rawPid != null && rawPid !== '' && Number(rawPid) !== 0 ? String(rawPid) : null
  if (!pid || !id) return null
  // self-parent is the simplest cycle
  if (pid === id) return err('CATEGORY_CYCLE', 'cannot place a category under itself')
  const parent = findRow ? findRow(pid) : null
  if (parent && parent.deleted) {
    return err('CATEGORY_NOT_FOUND', 'parent category not found (deleted)')
  }
  // cycle walk FIRST (CLI move order: the cycle is the more specific error, and a cycle through
  // the ancestor chain must be detected even while the direct parent is also a non-folder)
  const seen = new Set([pid])
  let node = parent
  while (node && node.parentId != null && Number(node.parentId) !== 0) {
    const nextId = String(node.parentId)
    if (nextId === id) return err('CATEGORY_CYCLE', 'cannot place a category into its own descendant (cycle)')
    if (seen.has(nextId)) break
    seen.add(nextId)
    node = findRow ? findRow(nextId) : null
    if (node && node.deleted) break
  }
  if (parent && !parent.isFolder) {
    return err('CATEGORY_NOT_FOLDER', 'parent is not a folder — categories only nest inside folders')
  }
  if (row.isFolder) {
    return err('CATEGORY_NESTED_FOLDER', 'folders are roots only — the App renders nested folders nowhere, so folder→folder nesting is rejected')
  }
  return null
}
