/**
 * Category ops extracted verbatim from db.js (structure-size ratchet). Pure relocation:
 * db.js keeps thin delegates in OPS (`upsertCategory: (...a) => categoryOps.upsertCategory(db, ...a)`)
 * so every caller (db.call, db-bulk-ops getOps) keeps the same surface and behavior.
 */
const { rowToCategory } = require('./db-rows')

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
  if (!cur && !deleted && !trimmedName) return false
  const row = {
    id: c && c.id,
    userId: c && c.userId,
    name: (!deleted && !trimmedName && cur) ? cur.name : (c && c.name),
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
