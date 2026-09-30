/* Change-capture oplog extracted from db.js (2026-09-15 size-ratchet split).
 * One sync_oplog row per successful write op, appended from call(). Factory-injected getDb keeps this
 * module decoupled from the db handle lifecycle (init/close reassign it). commitSyncBatch is excluded
 * at the call site -- the sync-ack echo path must not re-capture what it just acknowledged.
 *
 * Known gaps until the sync engine lands (declared 2026-09-15, review V1):
 * - Physical deletes (hardDelete/purgeRecycleBin/purgeSeedTodos/planPrune) physically remove
 *   tombstoned plan_chips. B9 (2026-09-26): the purge paths now ALSO log per-chip ('plan', id)
 *   tombstone pointers — the chips are physically gone post-op, so db.js stashes the doomed chip
 *   ids (purgeChipsScratch, injected here as getPurgeChips) and the purge expansion appends them
 *   next to the per-id todo pointers. A peer still holding those chips live lands the deletion
 *   through the existing planRemoveIds tombstone apply path instead of LWW-resurrecting ghost
 *   chips of purged todos. Remaining declared gaps: hardDelete/hardDeleteMany stay todo-only for
 *   their cascaded chips (peers recover via the todo tombstone + their own purge), and planPrune
 *   keeps its '*gc*' GC marker (see docs/sync-matrix.md §5).
 *   (purgeRecycleBin/purgeSeedTodos DO capture per-id todo tombstones since 2026-09-18.)
 * - The oplog append is a separate transaction from the business write: a crash between the two
 *   commits loses the delta row (accepted window at synchronous=NORMAL).
 * - planMoveTask/planDeleteTask/planDeleteTaskDay now log per-chip pointers (F3c, 2026-09-20);
 *   pre-fix oplogs may still contain ('plan', taskId) pointers — consumers skip the ghost ids.
 * - planPrune ('plan','*gc*') and tomatoMigrateFromMeta ('tomato','*gc*') keep their single GC
 *   marker (their results feed count-shaped consumers — audit "pruned N chip row(s)"); delta
 *   consumers must skip '*gc*' ids (lan-sync hydration guards against them) and reconcile via a
 *   full snapshot/tomatoAll instead of treating the marker as one record.
 */

// Ring-buffer retention (single source, D3 2026-09-24): every bare 10000 oplog page/limit
// literal (db.js syncOplogSince clamp, sync-apply/lan-sync-bootstrap/tomato-announce pagers)
// now derives from this constant via oplogKeepLimit() instead of duplicating the number.
const SYNC_OPLOG_KEEP = 10000
/** Effective oplog read page size: the requested limit clamped to the ring retention
 *  (Math.min(SYNC_OPLOG_KEEP, limit)) — there is never more than the ring's worth of rows to
 *  page through, so a larger request limit is pointless and a smaller one is honored. */
const oplogKeepLimit = limit => Math.min(SYNC_OPLOG_KEEP, limit)

module.exports = Object.assign(({ getDb, log, getPurgeChips, onAppendFailure }) => {
  /* ---------- Change-capture oplog (P1 sync groundwork, 2026-09-15) ---------- */
  // One sync_oplog row per successful write op. Appended in call() (db layer, like the ledger hook) so
  // IPC, aux windows and the CLI are all captured. commitSyncBatch is excluded — it is the sync-ack
  // echo path and a real sync engine must not re-capture the rows it just acknowledged. The log is a
  // ring buffer (SYNC_OPLOG_KEEP, exported above): long-range history gaps are covered by periodic
  // full snapshots, not by unbounded log retention.
  // entity + affected ids per write op (batch ops expand to one row per id so deltas are row-granular)
  function oplogEntriesFor (op, params, result) {
    const now = Date.now()
    const one = (entity, entityId) => ({ entity, entityId: String(entityId), ts: now })
    const arr = (entity, ids) => (Array.isArray(ids) ? ids : [ids]).filter(v => v != null && v !== '').map(id => one(entity, id))
    switch (op) {
      case 'upsert': return [one('todo', params && params.taskId)]
      case 'upsertMany': return arr('todo', (params || []).map(t => t && t.taskId))
      // P2 2026-09-17: a failed bump (missing/deleted task → { ok:false }) must not emit a delta —
      // the oplog row would point delta consumers at a row that never changed (ghost pointer).
      // Sync-8: a DEDUPED replay ({ ok:true, minutes:0, deduped:true }) changed nothing either —
      // it used to pass the ok check and emit a phantom delta per replayed focus session.
      case 'bumpSnow': return (result && (result.ok === false || result.deduped)) ? [] : [one('todo', params && params.taskId)]
      // Sync-5: both ops return the ids PHYSICALLY deleted ([] for an id that was never there) —
      // the params-side expansion used to emit a tombstone pointer for an absent id, telling
      // peers to delete a row they may still hold live.
      case 'hardDelete': case 'hardDeleteMany': return arr('todo', result)
      // 2026-09-18: both purge ops return the purged ids — expanded into per-id tombstone
      // pointers so purges propagate as real deletions (the old single ('todo','*gc*') marker
      // hydrated as a ghost tombstone on peers and could not stop snapshot/merge resurrection).
      // B9 (2026-09-26): the cascade-deleted plan_chips are physically gone by expansion time,
      // so db.js hands us their ids via getPurgeChips (captured INSIDE the purge transaction) —
      // expanded into per-chip tombstone pointers riding the existing plan.removeIds apply path.
      case 'purgeRecycleBin': case 'purgeSeedTodos': {
        let chips = []
        try { chips = (typeof getPurgeChips === 'function' ? getPurgeChips() : []) || [] } catch { /* scratch unavailable (legacy caller): todo pointers only */ }
        return [...arr('todo', result), ...arr('plan', chips)]
      }
      // H2 2026-09-16: an identical no-change upsert returns false — it must not produce a fake delta
      case 'upsertCategory': return result === false ? [] : [one('category', params && params.id)]
      // P2 2026-09-17: a no-change re-save returns false — it must not emit a delta (the old path
      // logged entity 'filter' with entityId 'false')
      case 'filterUpsert': return result === false ? [] : [one('filter', result)]
      // Bulk sync-apply variants (2026-09-18): result = ids that actually changed (same
      // row-granular delta shape as their single-row counterparts).
      case 'upsertCategoryMany': return arr('category', result)
      case 'filterUpsertMany': return arr('filter', result)
      // R7 P1-2: filterDelete params may be (id) or ([id, {deletedAt, updatedAt}]) — sync apply
      // passes the tombstone stamps. result=false (no live row matched) is a phantom: no delta.
      case 'filterDelete': return result === false ? [] : [one('filter', Array.isArray(params) ? params[0] : params)]
      case 'planAddMany': return arr('plan', result)
      // P2-5 (R4 2026-09-21): false = the UPDATE matched no live chip (no change) — no delta.
      case 'planUpdateChip': return result === false ? [] : [one('plan', params && params.id)]
      // planRemoveIds accepts plain ids or {id, deletedAt, updatedAt} stamps (sync apply path).
      // D11 finding 11: result-aware like its siblings — the op returns the ids that ACTUALLY
      // changed (the `AND deleted=0` guard no-ops a ghost/duplicate id); a phantom pointer for an
      // id the UPDATE never matched used to be emitted from params alone.
      case 'planRemoveIds': return arr('plan', result)
      // F3c (2026-09-20): these three ops move/delete CHIPS but used to log a single ('plan',
      // taskId) pointer — peers hydrated that as a GHOST tombstone (no chip has id = taskId) and
      // no-op'd, so task-level chip moves/deletes never propagated. Runs AFTER the write
      // (call() appends post-op), so the affected chip ids are resolved from the rows themselves;
      // planMoveTask's moved chips now sit at toDay. Legacy ('plan', taskId) pointers already in
      // retained oplogs stay harmless no-ops (ghost guard in sync-apply hydration). Chips already
      // sitting at toDay that were not moved may be over-logged: on peers they land as
      // identical-content no-ops, which is the standard echo-suppression path.
      case 'planMoveTask': return arr('plan', getDb().prepare('SELECT id FROM plan_chips WHERE taskId = ? AND day = ?')
        .all(String(params && params.taskId), String(params && params.toDay)).map(r => r.id))
      // planDeleteTask is called with a BARE taskId string (unlike planDeleteTaskDay's object);
      // accept both shapes. P2 idempotency (2026-09-25): a no-op delete (op returned false —
      // the chips were already deleted, see the `AND deleted=0` guard in db.js) captures NOTHING;
      // previously every repeat delete re-logged the same tombstone pointers and flooded the
      // sender's oplog. The SELECTs stay unfiltered by `deleted` on purpose: capture runs POST-op
      // and a REAL first delete must still see the (now deleted=1) chip ids.
      case 'planDeleteTask': return result === false ? [] : arr('plan', getDb().prepare('SELECT id FROM plan_chips WHERE taskId = ?')
        .all(String((params && typeof params === 'object') ? params.taskId : params)).map(r => r.id))
      case 'planDeleteTaskDay': return result === false ? [] : arr('plan', getDb().prepare('SELECT id FROM plan_chips WHERE taskId = ? AND day = ?')
        .all(String(params && params.taskId), String(params && params.day)).map(r => r.id))
      case 'planPrune': return [one('plan', '*gc*')]
      case 'setMeta': return [one('meta', Array.isArray(params) ? params[0] : params)]
      // setMetaMany takes a list of [k, v] pairs — same meta entity, row-granular pointers per key
      case 'setMetaMany': return arr('meta', (Array.isArray(params) ? params : []).map(p => p && p[0]))
      // H2 2026-09-16: meta deletions were never captured (not in WRITE_OPS, no case here) — a removed
      // meta key could never propagate to other devices. Accepts ('k') or (['k']) argument forms.
      case 'deleteMeta': return [one('meta', Array.isArray(params) ? params[0] : params)]
      // P2 settings_rows (docs/sync §4.2): row-granular deltas; a no-change put (result false)
      // emits nothing, PutMany's result is the list of keys that actually changed
      case 'settingsRowPut': return result === false ? [] : [one('setting', params && params.key)]
      case 'settingsRowPutMany': return arr('setting', result)
      // Sync-6: rowDelete returns changes>0 — false means the row was already tombstoned (or
      // never existed), so re-logging the pointer would churn the ring and falsify delete order.
      case 'settingsRowDelete': return result === false ? [] : [one('setting', params && typeof params === 'object' ? params.key : params)]
      case 'tomatoAppendMany': {
        const ids = (Array.isArray(params) ? params : [params]).map(r => r && r.tomatoId).filter(Boolean)
        return arr('tomato', ids)
      }
      // P2-5 (R4 2026-09-21): both ops return changes > 0 as a boolean — false means the UPDATE
      // matched nothing (missing/tombstoned row) or the write was an identical no-op. The old
      // unconditional pointer emitted a PHANTOM delta in exactly those cases (delta consumers
      // hydrate a row that never changed; e.g. the float's every-tick tomatoUpdateById echo).
      case 'tomatoUpdateById': return result === false ? [] : [one('tomato', params && params.tomatoId)]
      // D11 finding 2: params may be plain ids or {tomatoId, deletedAt, updatedAt} stamps (sync
      // apply path) — extract the id, an object would have String()-ified into a garbage pointer.
      // Sync-6: result-aware like planRemoveIds — the op (with its `AND deleted=0` guard) returns
      // the ids ACTUALLY tombstoned; a re-delete of an already-dead id used to re-stamp its
      // deletedAt AND emit a fresh pointer per call (echo fuel).
      case 'tomatoRemoveByIds': return arr('tomato', result)
      // r2 2026-09-28: result-aware like its siblings above — tomatoMigrateFromMeta returns 0 in
      // the steady state (rows already present / no blob / corrupted blob), and the CLI's open()
      // runs it on EVERY command (including pure reads). The unconditional pointer wrote one
      // PHANTOM ('tomato','*gc*') sync row per CLI invocation. Only a real migration (result > 0)
      // emits the GC marker.
      case 'tomatoMigrateFromMeta': return result === 0 ? [] : [one('tomato', '*gc*')]
      default: return []
    }
  }

  let oplogInsert = null
  let oplogCount = null
  let oplogOpCount = 0
  // r3 fix (2026-09-28): a failed append used to be log.warn-only — the local write succeeded,
  // but its delta pointer is now PERMANENTLY missing from the ring (the only record increment
  // propagation has), peers silently stop receiving that change until the next full snapshot,
  // and the push watermark advances as if nothing happened. Fail loud like the egress side
  // (hydrateRow already throws+counts): keep a monotonic failure counter (oplogStats below)
  // and invoke the injected onAppendFailure hook so the caller can surface the loss
  // (db.js wires it to an 'oplog-append-failed' syncEvent → Device Center).
  let oplogAppendFailures = 0
  // R7 fix (pending-count churn): machine-local bookkeeping keys (_savedAt/_lsAt stamps,
  // db.settingsState/db.habitsState blob mirrors, sync.* state) must never ENTER the ring —
  // the settings mirror rewrites them every few seconds, so ~3 no-op pointers landed per tick,
  // the push watermark could never catch up with generation, and Device Center permanently
  // showed a few hundred "pending" rows that were pure self-echo. hydrateRow already refuses
  // them at egress (peers apply 0); the ring is the earlier choke point and the cheaper fix.
  let localKeyPredicates = null
  function isLocalBookkeeping (entity, entityId) {
    try { if (!localKeyPredicates) localKeyPredicates = require('./sync-apply.js') } catch { return false }
    const k = String(entityId)
    if (entity === 'setting') return localKeyPredicates.isMachineLocalSettingKey(k)
    if (entity === 'meta') return localKeyPredicates.isMachineLocalMetaKey(k) || localKeyPredicates.isSyncBlobMetaKey(k)
    return false
  }
  // r4 fix (2026-09-28): oplogEntriesFor runs OUTSIDE appendOplog's try/catch (db.js call()),
  // so when IT threw, the same delta loss was reported via log.warn only — no counter, no hook,
  // no 'oplog-append-failed' syncEvent. Both failure entry points now share ONE reporter.
  function reportAppendFailure (errorMsg) {
    oplogAppendFailures++
    log.warn('[TodoDB] oplog append FAILED — that change will NOT propagate to peers until the next full snapshot:', errorMsg)
    try { if (typeof onAppendFailure === 'function') onAppendFailure({ count: oplogAppendFailures, error: errorMsg }) } catch { /* surfacing is best-effort */ }
  }
  function appendOplog (entries) {
    if (!entries.length) return
    try {
      if (!oplogInsert) {
        oplogInsert = getDb().prepare('INSERT INTO sync_oplog (entity, entityId, ts) VALUES (?, ?, ?)')
        oplogCount = getDb().prepare('SELECT COUNT(*) n FROM sync_oplog')
      }
      const kept = entries.filter(e => !isLocalBookkeeping(e.entity, e.entityId))
      if (!kept.length) return
      const tr = getDb().transaction(() => kept.forEach(e => oplogInsert.run(e.entity, e.entityId, e.ts)))
      tr()
      // Cheap amortized ring-buffer trim: check every 200 appends, not every write
      if (++oplogOpCount % 200 === 0) {
        const n = oplogCount.get().n
        if (n > SYNC_OPLOG_KEEP) getDb().prepare('DELETE FROM sync_oplog WHERE seq <= (SELECT MAX(seq) FROM sync_oplog) - ?').run(SYNC_OPLOG_KEEP)
      }
    } catch (e) { reportAppendFailure(e.message) }
  }

  // Drop prepared statements on db re-init/close so the next handle re-prepares cleanly
  function oplogReset () { oplogInsert = null; oplogCount = null; oplogOpCount = 0 }

  // r3 fix: read-side for the failure counter (Device Center / tests).
  function oplogStats () { return { appendFailures: oplogAppendFailures } }

  return { oplogEntriesFor, appendOplog, oplogReset, oplogStats, reportAppendFailure }
}, { SYNC_OPLOG_KEEP, oplogKeepLimit })
