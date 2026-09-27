/**
 * Plan-chips (timeline planning layer) ops extracted verbatim from db.js (structure-size ratchet).
 * Pure relocation: db.js keeps thin delegates in OPS so db.call surfaces and return shapes are
 * unchanged.
 */
// ===== Plan chips (timeline planning layer) formal row storage (2026-09-03 root fix) =====
// Previously meta.dayPlanState JSON whole-package + LS dual-write with three-way concurrency — the architectural root of four data-loss incidents;
// with row storage there is a single write channel (SQLite serialized) + write-op broadcast + cascading cleanup on task deletion, so the race is structurally eliminated.
// plan_chips deletes are tombstones (P1 sync groundwork): user-facing chip removals must propagate to other devices.
// planPrune is time-based GC (old days fall off) and stays physical — devices
// reconcile pruned history via periodic full snapshots, so tombstoning it would only grow the table.
// H2 2026-09-16: sort was missing from the snapshot SELECT — the snapshot/restore round-trip lost
// chip ordering and restore's ON CONFLICT upsert then overwrote sort with 0.
// F3a (2026-09-20): updatedAt must be in the SELECT too — without it the sync layer could not
// know a chip's LWW age and refused every inbound edit for a chip the peer already had
// (sync-apply ageUnknown gate); chips are re-timed on every write, so the column is the age.
exports.planAll = db => db.prepare('SELECT id, taskId, day, mm, sort, updatedAt FROM plan_chips WHERE deleted = 0 ORDER BY day, mm, sort').all()

exports.planAddMany = (db, chips) => {
  // Skip-and-collect (round-3 review): one malformed chip used to throw for the WHOLE batch —
  // a poison pill in the sync flush wedged plan ingestion forever. Invalid rows are skipped
  // (never applied); the valid rows commit and their ids are returned.
  const list = (Array.isArray(chips) ? chips : [chips]).filter(c => c && c.taskId &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(c.day)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.mm)))
    .map(c => ({
      id: (c && c.id) || 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      taskId: String(c.taskId || ''), day: String(c.day || ''), mm: String(c.mm || ''), sort: Number(c.sort) || 0,
      // M2 (2026-09-20): an explicit updatedAt (the sync apply path carries the peer row's age)
      // must survive — re-stamping now() here made the applied chip differ from the peer's row
      // (fresh LWW age + a new oplog delta per applied chip = apply/push ping-pong). Mirrors
      // upsertCategory's `(c && c.updatedAt) || now`; renderer callers omit it and get now().
      updatedAt: Number(c && c.updatedAt) > 0 ? Number(c.updatedAt) : 0
    }))
  const ins = db.prepare('INSERT INTO plan_chips (id, taskId, day, mm, sort, deleted, deletedAt, updatedAt) VALUES (@id,@taskId,@day,@mm,@sort,0,0,@updatedAt) ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, day=excluded.day, mm=excluded.mm, sort=excluded.sort, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt')
  const now = Date.now()
  const tr = db.transaction(() => list.forEach(c => ins.run({ ...c, updatedAt: c.updatedAt || now }))); tr()
  return list.map(c => c.id)
}

exports.planUpdateChip = (db, { id, day, mm }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('planUpdateChip: day 必须 YYYY-MM-DD')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(mm))) throw new Error('planUpdateChip: mm 必须 HH:mm')
  const r = db.prepare('UPDATE plan_chips SET day=?, mm=?, updatedAt=? WHERE id=? AND deleted=0').run(String(day), String(mm), Date.now(), String(id))
  return r.changes > 0
}

exports.planRemoveIds = (db, ids, opts = {}) => {
  const list = Array.isArray(ids) ? ids : [ids]
  const now = Date.now()
  const dAt = (opts && opts.deletedAt) || now
  const stamp = (opts && opts.updatedAt) || dAt
  // Items may be plain ids (renderer/CLI) or {id, deletedAt, updatedAt} tombstone stamps (sync apply)
  const del = db.prepare('UPDATE plan_chips SET deleted=1, deletedAt=?, updatedAt=? WHERE id = ? AND deleted=0')
  const tr = db.transaction(() => list.forEach(i => {
    const o = (i && typeof i === 'object') ? i : null
    del.run((o && o.deletedAt) || dAt, (o && o.updatedAt) || stamp, String(o ? o.id : i))
  }))
  tr()
  return true
}

exports.planMoveTask = (db, { taskId, fromDay, toDay }) => {
  const okDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v))
  if (!okDay(fromDay) || !okDay(toDay)) return 0 // reject malformed day keys outright, preventing chips from landing in invisible buckets
  const r = db.prepare('UPDATE plan_chips SET day=?, updatedAt=? WHERE taskId=? AND day=? AND deleted=0').run(String(toDay), Date.now(), String(taskId), String(fromDay))
  return r.changes
}

// P2 idempotency (2026-09-25): `AND deleted=0` mirrors filterDelete/planRemoveIds — a repeat
// delete of an already-deleted task used to re-stamp deletedAt/updatedAt with a fresh now(),
// and every such call minted ANOTHER tombstone-pointer oplog entry (db-oplog's planDeleteTask
// case has no deleted filter), flooding the sender's log on repeated calls. Now a no-op.
exports.planDeleteTask = (db, taskId) => { const r = db.prepare('UPDATE plan_chips SET deleted=1, deletedAt=?, updatedAt=? WHERE taskId=? AND deleted=0').run(Date.now(), Date.now(), String(taskId)); return r.changes > 0 }

exports.planDeleteTaskDay = (db, { taskId, day }) => { const r = db.prepare('UPDATE plan_chips SET deleted=1, deletedAt=?, updatedAt=? WHERE taskId=? AND day=? AND deleted=0').run(Date.now(), Date.now(), String(taskId), String(day)); return r.changes > 0 }

exports.planPrune = (db, { keepDays }) => {
  const keep = Array.isArray(keepDays) ? keepDays.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))) : []
  if (!keep.length) return 0
  const ph = keep.map(() => '?').join(',')
  const r = db.prepare(`DELETE FROM plan_chips WHERE day NOT IN (${ph})`).run(...keep)
  return r.changes
}
