/* Change-capture oplog extracted from db.js (2026-09-15 size-ratchet split).
 * One sync_oplog row per successful write op, appended from call(). Factory-injected getDb keeps this
 * module decoupled from the db handle lifecycle (init/close reassign it). commitSyncBatch is excluded
 * at the call site -- the sync-ack echo path must not re-capture what it just acknowledged.
 */

module.exports = ({ getDb, log }) => {
  /* ---------- Change-capture oplog (P1 sync groundwork, 2026-09-15) ---------- */
  // One sync_oplog row per successful write op. Appended in call() (db layer, like the ledger hook) so
  // IPC, aux windows and the CLI are all captured. commitSyncBatch is excluded — it is the sync-ack
  // echo path and a real sync engine must not re-capture the rows it just acknowledged. The log is a
  // ring buffer (SYNC_OPLOG_KEEP): long-range history gaps are covered by periodic full snapshots, not
  // by unbounded log retention.
  const SYNC_OPLOG_KEEP = 10000
  // entity + affected ids per write op (batch ops expand to one row per id so deltas are row-granular)
  function oplogEntriesFor (op, params, result) {
    const now = Date.now()
    const one = (entity, entityId) => ({ entity, entityId: String(entityId), ts: now })
    const arr = (entity, ids) => (Array.isArray(ids) ? ids : [ids]).filter(v => v != null && v !== '').map(id => one(entity, id))
    switch (op) {
      case 'upsert': return [one('todo', params && params.taskId)]
      case 'upsertMany': return arr('todo', (params || []).map(t => t && t.taskId))
      case 'bumpSnow': return [one('todo', params && params.taskId)]
      case 'hardDelete': case 'hardDeleteMany': return arr('todo', params)
      case 'purgeRecycleBin': case 'purgeSeedTodos': return [one('todo', '*gc*')]
      case 'upsertCategory': return [one('category', params && params.id)]
      case 'filterUpsert': return [one('filter', result)]
      case 'filterDelete': return [one('filter', params)]
      case 'planAddMany': return arr('plan', result)
      case 'planUpdateChip': return [one('plan', params && params.id)]
      case 'planRemoveIds': return arr('plan', params)
      case 'planMoveTask': return [one('plan', params && params.taskId)]
      case 'planDeleteTask': case 'planDeleteTaskDay': return [one('plan', params && params.taskId)]
      case 'planPrune': return [one('plan', '*gc*')]
      case 'setMeta': return [one('meta', Array.isArray(params) ? params[0] : params)]
      case 'tomatoAppendMany': {
        const ids = (Array.isArray(params) ? params : [params]).map(r => r && r.tomatoId).filter(Boolean)
        return arr('tomato', ids)
      }
      case 'tomatoUpdateById': return [one('tomato', params && params.tomatoId)]
      case 'tomatoRemoveByIds': return arr('tomato', params)
      case 'tomatoMigrateFromMeta': return [one('tomato', '*gc*')]
      default: return []
    }
  }

  let oplogInsert = null
  let oplogCount = null
  let oplogOpCount = 0
  function appendOplog (entries) {
    if (!entries.length) return
    try {
      if (!oplogInsert) {
        oplogInsert = getDb().prepare('INSERT INTO sync_oplog (entity, entityId, ts) VALUES (?, ?, ?)')
        oplogCount = getDb().prepare('SELECT COUNT(*) n FROM sync_oplog')
      }
      const tr = getDb().transaction(() => entries.forEach(e => oplogInsert.run(e.entity, e.entityId, e.ts)))
      tr()
      // Cheap amortized ring-buffer trim: check every 200 appends, not every write
      if (++oplogOpCount % 200 === 0) {
        const n = oplogCount.get().n
        if (n > SYNC_OPLOG_KEEP) getDb().prepare('DELETE FROM sync_oplog WHERE seq <= (SELECT MAX(seq) FROM sync_oplog) - ?').run(SYNC_OPLOG_KEEP)
      }
    } catch (e) { log.warn('[TodoDB] oplog append failed (write itself is unaffected):', e.message) }
  }

  // Drop prepared statements on db re-init/close so the next handle re-prepares cleanly
  function oplogReset () { oplogInsert = null; oplogCount = null; oplogOpCount = 0 }

  return { oplogEntriesFor, appendOplog, oplogReset }
}
