/**
 * Plan-chips (timeline planning layer) ops extracted verbatim from db.js (structure-size ratchet).
 * Pure relocation: db.js keeps thin delegates in OPS so db.call surfaces and return shapes are
 * unchanged.
 */
// electron-log only exists inside the packaged App; the standalone CLI bundle has no
// node_modules/electron-log, so fall back to a no-op logger instead of crashing at require time
let log
try { log = require('electron-log') } catch { log = { info () {}, warn () {}, error () {} } }
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
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
  // a poison pill in the sync flush wedged plan ingestion forever. Invalid rows are skipped.
  const rawList = (Array.isArray(chips) ? chips : [chips])
  const list = []
  // D13 finding 3 (uniform bulk-flush rejection contract): surface the skipped rows instead of
  // silently filtering them — a buffered segment whose tail never landed used to ack ok=true
  // past lost chips. `rejected` rides the accepted-ids array as a NON-enumerable property.
  const rejected = []
  // B8-P2 (2026-10-02, D20 category-mint parity cli/lib-categories.cjs): the bare
  // Date.now()+rand mint collided within the same millisecond and the ON CONFLICT upsert silently
  // MOVED an unrelated chip onto the colliding id. Re-mint in a bounded loop until the id is free
  // (wider jitter space when the fast path keeps colliding).
  const seenBatch = new Set() // same-batch mints collide too (DB check cannot see unsent rows)
  const taken = id => seenBatch.has(id) || !!db.prepare('SELECT 1 FROM plan_chips WHERE id = ?').get(id)
  const mintId = () => {
    let id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    for (let i = 0; taken(id) && i < 16; i++) id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
    seenBatch.add(id)
    return id
  }
  for (let i = 0; i < rawList.length; i++) {
    const c = rawList[i]
    if (c && c.taskId && /^\d{4}-\d{2}-\d{2}$/.test(String(c.day)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.mm))) {
      list.push({
        id: (c && c.id) || mintId(),
        taskId: String(c.taskId || ''), day: String(c.day || ''), mm: String(c.mm || ''), sort: Number(c.sort) || 0,
        // M2 (2026-09-20): an explicit updatedAt (the sync apply path carries the peer row's age)
        // must survive — re-stamping now() here made the applied chip differ from the peer's row
        // (fresh LWW age + a new oplog delta per applied chip = apply/push ping-pong).
        updatedAt: Number(c && c.updatedAt) > 0 ? Number(c.updatedAt) : 0
      })
    } else {
      rejected.push({ index: i, taskId: c && c.taskId != null ? String(c.taskId) : null, reason: 'invalid chip (taskId/day/mm)' })
    }
  }
  if (rejected.length) log.warn(`[TodoDB] planAddMany: rejected ${rejected.length} of ${rawList.length} chips (invalid taskId/day/mm)`)
  // D20-B12 note: a storage-level LWW gate here (DO UPDATE ... WHERE excluded.updatedAt > existing)
  // was tried and REVERTED — sync-apply already adjudicates plan winners before the flush write
  // (tombstone-winner branch, planRemoveIds carries the winner stamps), while the conflict-backup
  // restore path legitimately re-applies OLDER values (its whole purpose), which the gate broke.
  const ins = db.prepare('INSERT INTO plan_chips (id, taskId, day, mm, sort, deleted, deletedAt, updatedAt) VALUES (@id,@taskId,@day,@mm,@sort,0,0,@updatedAt) ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, day=excluded.day, mm=excluded.mm, sort=excluded.sort, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt')
  const now = Date.now()
  const tr = db.transaction(() => list.forEach(c => ins.run({ ...c, updatedAt: c.updatedAt || now }))); tr()
  const accepted = list.map(c => c.id)
  Object.defineProperty(accepted, 'rejected', { value: rejected, enumerable: false })
  return accepted
}

exports.planUpdateChip = (db, { id, day, mm }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('planUpdateChip: day must be YYYY-MM-DD')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(mm))) throw new Error('planUpdateChip: mm must be HH:mm')
  // B7-P3 (2026-10-02, planDeleteTask idempotency parity): a chip update that does not actually
  // change day/mm used to re-stamp updatedAt and mint another oplog delta per no-op call — peers
  // churned on phantom plan pointers every round. Read-compare first; a no-op returns false
  // (no stamp, no oplog) exactly like planDeleteTask's already-deleted no-op.
  const cur = db.prepare('SELECT day, mm FROM plan_chips WHERE id=? AND deleted=0').get(String(id))
  if (!cur || (cur.day === String(day) && cur.mm === String(mm))) return false
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
  // D11 finding 11 (same row-granular delta shape as planAddMany/planDeleteTask): return the ids
  // that ACTUALLY changed — the `AND deleted=0` guard makes a ghost id (never existed, or already
  // deleted) a no-op UPDATE, and the oplog used to emit a PHANTOM ('plan', ghostId) tombstone
  // pointer for it (delta consumers hydrate a chip that never changed; peers then churn on a
  // ghost tombstone every round). db-oplog.js's planRemoveIds case consumes this result.
  const changed = []
  const tr = db.transaction(() => list.forEach(i => {
    const o = (i && typeof i === 'object') ? i : null
    const r = del.run((o && o.deletedAt) || dAt, (o && o.updatedAt) || stamp, String(o ? o.id : i))
    if (r.changes > 0) changed.push(String(o ? o.id : i))
  }))
  tr()
  return changed
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
