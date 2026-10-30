/**
 * Category ops extracted verbatim from db.js (structure-size ratchet). Pure relocation:
 * db.js keeps thin delegates in OPS (`upsertCategory: (...a) => categoryOps.upsertCategory(db, ...a)`)
 * so every caller (db.call, db-bulk-ops getOps) keeps the same surface and behavior.
 */
const { rowToCategory } = require('./db-rows')
const { isBlankishName } = require('./blankish-name.cjs')
// F4 (2026-10-17): the CLI's three structure guards (CATEGORY_CYCLE / CATEGORY_NOT_FOLDER /
// CATEGORY_NESTED_FOLDER, cli/lib-categories.cjs) sank to this write bottleneck — every category
// write channel (renderer, CLI, sync apply, import, recovery restore) passes through upsertCategory,
// but only the CLI used to validate structure, so the sync channel could land a nested folder, a
// parent pointing at a non-folder or a tombstoned row, or a parent/child cycle. Same require(esm)
// precedent as db-filter-ops (shared/filter-core.mjs); the CLI reuses the same core so the two
// implementations cannot drift.
const { validateCategoryStructure } = require('../../shared/category-structure.mjs')
const rowView = r => r && { id: r.id, isFolder: !!r.isFolder, deleted: !!r.deleted, parentId: r.parentId || 0 }

/** F4 (2026-10-17): R5 parity for REMOTE category tombstones — sync-apply calls this when a peer's
 *  category deletion lands, so a saved filter whose conds.catId references a victim dies with the
 *  category on BOTH ends (a local delete purges via renderer purgeFiltersForVictims; the old
 *  remote-tombstone path left the filter behind pointing at a dead category id — two-device
 *  divergence). Same catFiltersBak backup semantics as the renderer/CLI twins (D14-B9/D15-B6):
 *  one stamped `catFiltersBak.<deletedAt>.<victimId>` key per victim written BEFORE the deletes
 *  (recover restores it), then each doomed filter tombstoned through the caller's writer so the
 *  delete flows through the command bus (audit + oplog) exactly like a renderer/CLI delete.
 *  Best-effort by contract: the caller wraps it in try/catch — filters must never block a
 *  category tombstone from landing (same rule as renderer softDelete). */
exports.purgeFiltersForCategoryVictims = (db, victims, deletedAt, write) => {
  const list = db.call('filterList') || []
  const dead = new Set(victims.map(v => String(v)))
  const doomed = list.filter(f => f && f.conds && dead.has(String(f.conds.catId)))
  if (!doomed.length) return 0
  const w = write || ((op, p) => db.call(op, p))
  const bakKey = deletedAt
    ? 'catFiltersBak.' + deletedAt + '.' + victims[0]
    : 'catFiltersBak.' + victims[0] // legacy unstamped shape: age unknowable, GC keeps it (same rule as renderer backupDoomedFilters)
  w('setMeta', [bakKey, JSON.stringify(doomed.map(f => ({ id: f.id, name: f.name, conds: f.conds, sort: f.sort })))])
  let removed = 0
  for (const f of doomed) {
    try { w('filterDelete', [f.id]); removed++ } catch { /* skip and keep cascading (CLI twin semantics) */ }
  }
  return removed
}

exports.upsertCategory = (db, c) => {
  const now = Date.now()
  // H2 2026-09-16 root fix (startup dirty-write storm): the renderer re-upserts every category on
  // each boot; the old path rewrote all N rows with updatedAt=now and re-stamped tombstone
  // deletedAt, producing N fake oplog deltas per launch. Now: existing row is compared field by
  // field and an identical upsert is a no-op returning false (oplog produces no delta for it).
  const cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(c && c.id)
  // Stamp deletedAt at tombstone time: callers never pass it, and a tombstone without a timestamp
  // can never be time-ordered or reconciled by a sync engine (review V1-F5). An already-tombstoned
  // row keeps its original deletedAt (re-upserting the same deleted category must not re-stamp it).
  // P2 2026-09-20: the stamp used to fire only for the renderer's `delete` field — a ROW-shape
  // input (`deleted:1`, no `delete`, e.g. the CLI and the sync apply path's buffered categories)
  // fell through to deletedAt=0, producing timestamp-less tombstones that LWW/sync ordering
  // treats as oldest-possible. Normalize the deleted flag FIRST, then stamp: any tombstone
  // without an explicit deletedAt (and without a prior stamp on the existing row) gets now(),
  // and an already-stamped row keeps its original value.
  const deleted = (c && (c.deleted != null ? c.deleted : c.delete)) ? 1 : 0
  const deletedAt = (c && c.deletedAt) || (deleted ? ((cur && cur.deletedAt) || now) : 0)
  // P1 2026-10-08 (empty-category choke point; wild forensics: 150 junk rows with name='' and
  // createTime=0, cemented by a recovery restore): the full-field ON CONFLICT DO UPDATE below let
  // a degraded writer blank an existing row's name/color/createdAt while keeping its id. Guarded
  // here — the single choke point every category write (renderer, CLI, sync apply, import,
  // recovery restore) passes through:
  //   (a) an INSERT (no existing row) whose trimmed name is empty is refused: no-op returning
  //       false, no row written (house no-op convention, same contract as the identical-upsert
  //       no-op above; bulk/sync loops stay intact).
  //   (b) an UPDATE never writes an empty/whitespace name over a non-empty one — the existing
  //       name is kept for that field.
  //   (c) a patch carrying color=''/createdAt=0 falls back to the existing row's values instead
  //       of blanking them.
  // Tombstones are exempt from (a)/(b): an inbound sync tombstone may legitimately arrive with
  // stripped fields and must still land (gate on !deleted).
  const trimmedName = (c && c.name != null) ? String(c.name).trim() : ''
  // D25 W1: zero-width spellings ('\u200B') count as blank too — trim() alone let them through.
  const blankName = !trimmedName || isBlankishName(c && c.name)
  if (!cur && !deleted && blankName) return false
  // F4 (2026-10-17) structure guards at the write bottleneck: tombstones are exempt (an inbound
  // tombstone may legitimately carry stale structure and must still land — same exemption as the
  // empty-name gates above). A violation REFUSES the write as a house no-op (returns false, no
  // row written, no oplog delta — bulk/sync loops stay intact) and records the structured error
  // on exports.lastCategoryGuardError for callers that surface it; leaving it null on success.
  exports.lastCategoryGuardError = null
  if (!deleted) {
    const guard = validateCategoryStructure(
      { id: c && c.id, isFolder: (c && c.isFolder) ? 1 : 0, parentId: c && c.parentId },
      pid => rowView(db.prepare('SELECT id, isFolder, deleted, parentId FROM categories WHERE id = ?').get(pid)))
    if (guard) {
      exports.lastCategoryGuardError = guard
      return false
    }
  }
  const row = {
    id: c && c.id,
    userId: c && c.userId,
    name: (!deleted && blankName && cur) ? cur.name : (c && c.name),
    color: !(c && c.color) && cur ? cur.color : (c && c.color),
    createdAt: !(c && c.createdAt) && cur ? cur.createdAt : (c && c.createdAt),
    sort: c && c.sort,
    isFolder: (c && c.isFolder) ? 1 : 0,
    parentId: c && c.parentId,
    // callers may flag deletion via `delete` (renderer shape) or `deleted` (row shape); normalized above
    deleted,
    deletedAt,
    updatedAt: (c && c.updatedAt) || now
  }
  if (cur) {
    const eq = (a, b) => (a == null ? null : a) === (b == null ? null : b)
    const same = ['id', 'userId', 'name', 'color', 'createdAt', 'sort', 'isFolder', 'parentId', 'deleted', 'deletedAt']
      .every(k => eq(row[k], cur[k])) &&
      // updatedAt only counts as a diff when the caller explicitly supplied one (otherwise it is
      // just our own now-stamp and would make every no-op upsert look like a change)
      (c.updatedAt == null || eq(row.updatedAt, cur.updatedAt))
    if (same) return false
  }
  db.prepare(`INSERT INTO categories (id,userId,name,color,createdAt,sort,isFolder,parentId,deleted,deletedAt,updatedAt)
    VALUES (@id,@userId,@name,@color,@createdAt,@sort,@isFolder,@parentId,@deleted,@deletedAt,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, createdAt=excluded.createdAt,
      sort=excluded.sort, isFolder=excluded.isFolder, parentId=excluded.parentId, deleted=excluded.deleted,
      deletedAt=excluded.deletedAt, updatedAt=excluded.updatedAt
    `).run(row) // 全字段 DO UPDATE:漏 isFolder/parentId 曾致拖入/拖出文件夹静默打回(2026-09-04 深审 P0);userId 不更新(行属不变)
  return true
}

exports.getAllCategories = db => db.prepare('SELECT * FROM categories WHERE deleted = 0 ORDER BY sort').all().map(rowToCategory)
