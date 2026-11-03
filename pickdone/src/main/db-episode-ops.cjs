/**
 * Work-episode / source-ref / task-source-link ops (S1 vertical slice, migration v11).
 * Split modeled on db-plan-ops.js: pure domain functions taking the db handle; db.js keeps
 * thin delegates in OPS so every db.call surface and return shape stays unchanged.
 *
 * Semantics shared with the plan-chip family:
 * - Puts are id-referenced upserts (ON CONFLICT(id) DO UPDATE) that restore tombstoned rows
 *   (deleted=0, deletedAt=0); an explicit updatedAt (the sync-apply path carries the peer row's
 *   age) is preserved verbatim — re-stamping it would break LWW; the command bus stamps
 *   updatedAt for local callers that send none (manifest lwwField).
 * - Removes are tombstones (deleted=1) that return the ids ACTUALLY changed (row-granular
 *   contract like planRemoveIds — a ghost or already-deleted id is a no-op and minted no
 *   phantom delta).
 * - source_refs / task_source_links carry pair-unique indexes; the put ops pre-check the pair
 *   so a colliding caller gets an EXPLICIT error naming the pair, not a bare SQLITE message.
 */
const mintId = prefix => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

// ---- work_episodes ----
exports.episodePut = (db, ep = {}) => {
  if (!ep || ep.taskId == null || ep.taskId === '') {
    throw new Error('[db-episode-ops] episodePut: taskId is required')
  }
  const id = ep.id != null && ep.id !== '' ? String(ep.id) : mintId('ep')
  const now = Date.now()
  db.prepare(`INSERT INTO work_episodes (id, taskId, startedAt, endedAt, note, deleted, deletedAt, updatedAt)
    VALUES (@id,@taskId,@startedAt,@endedAt,@note,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, startedAt=excluded.startedAt, endedAt=excluded.endedAt,
      note=excluded.note, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({
      id,
      taskId: String(ep.taskId),
      startedAt: Number(ep.startedAt) || 0,
      endedAt: Number(ep.endedAt) || 0,
      note: ep.note != null ? String(ep.note) : null,
      updatedAt: Number(ep.updatedAt) > 0 ? Number(ep.updatedAt) : now
    })
  return id
}

// Items may be plain ids (renderer/CLI) or {id, deletedAt, updatedAt} tombstone stamps (sync apply).
exports.episodeRemoveIds = (db, ids, opts = {}) => removeByIds(db, 'work_episodes', ids, opts)

// Read-side (pd20 S3 'continue work' section): the EditPanel reads a task's episodes via
// dbCall('queryEpisodesByTask', taskId). The renderer's contract (editpanel-work pins) is a
// view model — {episodeId, summary, resources} — so the storage columns (id/note) are mapped
// HERE, once: the renderer never learns the row schema. Oldest startedAt first; tombstoned
// episodes and tombstoned links/refs are invisible. Read-only → no manifest row needed (same
// class as tomatoGetById); whitelisted for any renderer window in handlers/todo.js.
exports.queryEpisodesByTask = (db, taskId) => {
  if (taskId == null || taskId === '') return []
  const eps = db.prepare(
    'SELECT id, startedAt, endedAt, note FROM work_episodes WHERE taskId = @taskId AND deleted = 0 ORDER BY startedAt ASC, id ASC'
  ).all({ taskId: String(taskId) })
  const resources = db.prepare(
    'SELECT sr.title FROM task_source_links tsl JOIN source_refs sr ON sr.id = tsl.sourceRefId' +
    ' WHERE tsl.taskId = @taskId AND tsl.deleted = 0 AND sr.deleted = 0 ORDER BY sr.id ASC'
  ).all({ taskId: String(taskId) }).map(r => r.title || '').filter(Boolean)
  return eps.map(e => ({ episodeId: e.id, startedAt: e.startedAt, endedAt: e.endedAt, summary: e.note || '', resources }))
}

// Read-side (pd20 handoff copy): the EditPanel 'continue work' section's Copy-Handoff button
// assembles the handoff from this task's linked source refs (buildHandoff's `sources` input:
// L0..Ln provenance rows with canonicalUri). Storage models a source as (providerId, externalId);
// the canonical URI is composed HERE, once — the renderer never learns the row schema (same
// doctrine as queryEpisodesByTask). Read-only → no manifest row needed; whitelisted alongside
// queryEpisodesByTask in handlers/todo.js.
exports.querySourcesByTask = (db, taskId) => {
  if (taskId == null || taskId === '') return []
  return db.prepare(
    'SELECT sr.providerId, sr.externalId, sr.title FROM task_source_links tsl JOIN source_refs sr ON sr.id = tsl.sourceRefId' +
    ' WHERE tsl.taskId = @taskId AND tsl.deleted = 0 AND sr.deleted = 0 ORDER BY sr.id ASC'
  ).all({ taskId: String(taskId) }).map(r => ({
    level: 'L0',
    canonicalUri: String(r.providerId) + '://' + String(r.externalId),
    title: r.title || ''
  }))
}

// ---- source_refs ----
exports.sourcePut = (db, row = {}) => {
  if (!row || row.providerId == null || row.providerId === '' || row.externalId == null || row.externalId === '') {
    throw new Error('[db-episode-ops] sourcePut: providerId and externalId are required')
  }
  const id = row.id != null && row.id !== '' ? String(row.id) : mintId('src')
  const providerId = String(row.providerId)
  const externalId = String(row.externalId)
  const now = Date.now()
  // Explicit pair pre-check → a named error (the UNIQUE index is the storage backstop for races).
  const pair = db.prepare('SELECT id FROM source_refs WHERE providerId = ? AND externalId = ?').get(providerId, externalId)
  if (pair && pair.id !== id) {
    throw new Error(`[db-episode-ops] sourcePut: (providerId=${providerId}, externalId=${externalId}) already exists as id ${pair.id} — put that id instead of minting a duplicate`)
  }
  db.prepare(`INSERT INTO source_refs (id, providerId, externalId, title, deleted, deletedAt, updatedAt)
    VALUES (@id,@providerId,@externalId,@title,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET providerId=excluded.providerId, externalId=excluded.externalId, title=excluded.title,
      deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({
      id, providerId, externalId,
      title: row.title != null ? String(row.title) : null,
      updatedAt: Number(row.updatedAt) > 0 ? Number(row.updatedAt) : now
    })
  return id
}

exports.sourceRemoveByIds = (db, ids, opts = {}) => removeByIds(db, 'source_refs', ids, opts)

// ---- task_source_links ----
exports.taskSourcePut = (db, row = {}) => {
  if (!row || row.taskId == null || row.taskId === '' || row.sourceRefId == null || row.sourceRefId === '') {
    throw new Error('[db-episode-ops] taskSourcePut: taskId and sourceRefId are required')
  }
  const id = row.id != null && row.id !== '' ? String(row.id) : mintId('tsl')
  const taskId = String(row.taskId)
  const sourceRefId = String(row.sourceRefId)
  const now = Date.now()
  const pair = db.prepare('SELECT id FROM task_source_links WHERE taskId = ? AND sourceRefId = ?').get(taskId, sourceRefId)
  if (pair && pair.id !== id) {
    throw new Error(`[db-episode-ops] taskSourcePut: (taskId=${taskId}, sourceRefId=${sourceRefId}) already exists as id ${pair.id}`)
  }
  db.prepare(`INSERT INTO task_source_links (id, taskId, sourceRefId, deleted, deletedAt, updatedAt)
    VALUES (@id,@taskId,@sourceRefId,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, sourceRefId=excluded.sourceRefId,
      deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({ id, taskId, sourceRefId, updatedAt: Number(row.updatedAt) > 0 ? Number(row.updatedAt) : now })
  return id
}

exports.taskSourceRemove = (db, ids, opts = {}) => removeByIds(db, 'task_source_links', ids, opts)

// Shared tombstone core (planRemoveIds shape): row-granular changed-id list, stamp opts honored.
function removeByIds (db, table, ids, opts = {}) {
  const list = Array.isArray(ids) ? ids : [ids]
  const now = Date.now()
  const dAt = (opts && opts.deletedAt) || now
  const stamp = (opts && opts.updatedAt) || dAt
  const del = db.prepare(`UPDATE ${table} SET deleted=1, deletedAt=?, updatedAt=? WHERE id = ? AND deleted=0`)
  const changed = []
  const tr = db.transaction(() => list.forEach(i => {
    const o = (i && typeof i === 'object') ? i : null
    const r = del.run((o && o.deletedAt) || dAt, (o && o.updatedAt) || stamp, String(o ? o.id : i))
    if (r.changes > 0) changed.push(String(o ? o.id : i))
  }))
  tr()
  return changed
}
