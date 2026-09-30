/**
 * Extracted from store/todo.js (structure-size ratchet): the DB write pending queue +
 * the settings date-range resolver. No behavior change — code moved verbatim.
 */
import { commit as commitCommand } from '../../utils/commandBus.js'
import { rangeDays } from '../../utils/core.js'

// ---- DB write pending queue (mirrors tomato.js's _pendingLedger): a failed task upsert stays queued and replays on the next quit flush, so a transient IPC/db failure can't silently drop a task edit ----
const _pendingUpserts = []
let _todoFlushHooked = false
let _flushing = false

/** Live queue (test seam: _testInternals exposes the same array instance). */
export function pendingUpserts () { return _pendingUpserts }

/** [replay guard] The queue must hold only the NEWEST pending version of each row. A failed
 *  upsert used to keep its full row JSON queued forever; a later edit of the same task queued a
 *  SECOND entry, and on replay the STALE one was re-dispatched too — the older row JSON (db.js
 *  OPS.upsert is a blind ON CONFLICT DO UPDATE, src/main/db.js) then overwrote the newer edit:
 *  stale-wins until the next edit of that task. Single invariant, enforced at enqueue time for
 *  every op shape that carries rows ('upsert' single row / 'upsertMany' + 'commitSyncBatch' row
 *  lists): a newer write supersedes the older queued copy of the same taskId. */
export function supersedePendingRow (taskId) {
  if (taskId == null) return
  for (let i = _pendingUpserts.length - 1; i >= 0; i--) {
    const entry = _pendingUpserts[i]
    if (!entry) continue
    if (entry.op === 'upsert') {
      if (entry.params && entry.params.taskId === taskId) _pendingUpserts.splice(i, 1)
    } else if (entry.op === 'upsertMany' || entry.op === 'commitSyncBatch') {
      const rows = entry.params && entry.params.rows !== undefined ? entry.params.rows : entry.params
      if (!Array.isArray(rows)) continue
      const next = rows.filter(r => !(r && r.taskId === taskId))
      if (next.length === 0) _pendingUpserts.splice(i, 1)
      else if (next.length !== rows.length) {
        if (entry.op === 'commitSyncBatch') entry.params.rows = next
        else entry.params = next
      }
    }
  }
}

/** [Fault-1] Shared stale-batch predicate: the db layer (src/main/db.js commitSyncBatch) rejects a
 *  batch whose version is older than the persisted todosVersion with "— stale batch rejected".
 *  That check lived as an inline regex ONLY in todoSync's catch; any other caller (flush replay,
 *  tests) had to re-derive the string. Single source here. */
export function isStaleBatchError (err) {
  return !!(err && /stale batch rejected/.test(String((err && err.message) || err)))
}

/** [Fault-2] Batch-level supersede, mirroring supersedePendingRow's row invariant: a queued
 *  commitSyncBatch replaying AFTER a newer batch has been persisted is a doomed replay — the db
 *  layer rejects it as stale on every quit flush forever. Drop every queued batch whose version is
 *  not newer than `version` (the version of the batch/about-to-be-queued state that supersedes it). */
export function supersedePendingBatch (version) {
  if (version == null) return
  for (let i = _pendingUpserts.length - 1; i >= 0; i--) {
    const entry = _pendingUpserts[i]
    if (entry && entry.op === 'commitSyncBatch' && entry.params && entry.params.version != null && entry.params.version <= version) {
      _pendingUpserts.splice(i, 1)
    }
  }
}

/** Queue a raw entry (upsertMany / commitSyncBatch share safeUpsert's replay guarantee:
 *  queueing also arms the quit-flush hook, same as safeUpsert). Callers queue batch entries that
 *  are already the newest known state of their rows — call supersedePendingBatch first to drop
 *  older queued copies of the same batch. */
export function queuePendingUpsert (entry) {
  _pendingUpserts.push(entry)
  hookQuitFlush()
}

/** Unified exit for DB persistence: failures are logged, never producing floating rejections (local/DB mismatch is visible in the console)
 *  JSON round-trip de-proxies: row objects come from reactive state, so nested arrays like reminderOffsets are Proxies
 *  that fail IPC structured cloning (symptom: every task edit logs "An object could not be cloned" and the DB receives no update) */
// Exported for unit tests (same precedent as planSnapshotRowSync): the quit-flush retry contract
// (a failed upsert stays queued and is replayed) is behavior worth pinning.
export function safeUpsert (row) {
  let plain
  try { plain = JSON.parse(JSON.stringify(row)) } catch (e) { plain = row }
  // Replay guard: this write supersedes any older queued copy of the same row (see supersedePendingRow)
  supersedePendingRow(plain && plain.taskId)
  const entry = { op: 'upsert', params: plain }
  _pendingUpserts.push(entry)
  Promise.resolve(commitCommand('todo', 'put', plain))
    .then(() => { const i = _pendingUpserts.indexOf(entry); if (i >= 0) _pendingUpserts.splice(i, 1) })
    .catch(err => console.error('[todo] persist failed (queued for quit-flush retry):', err))
  hookQuitFlush()
}
function hookQuitFlush () {
  if (_todoFlushHooked || !window.todoAPI || !window.todoAPI.onAppQuittingFlush) return
  _todoFlushHooked = true
  window.todoAPI.onAppQuittingFlush(() => flushPendingUpserts())
}
/** Exit flush: send every pending upsert. maint-d7: failed entries NEVER leave the queue — the
 *  splice happens per-entry only on success (safeUpsert's own removal shape). The old
 *  splice-all-then-requeue-in-Promise.all requeued failures in an async aggregate callback, which
 *  never ran when the process exited between the IPC dispatch and the callback (quit-flush: the ack
 *  defer can outrun Promise.all) — every failed upsert was permanently lost. Replay is safe: upsert
 *  is an idempotent row write. */
// Exported for unit tests (same precedent as planSnapshotRowSync)
export { flushPendingUpserts }
function flushPendingUpserts () {
  // Re-entrancy guard: the quit-flush broadcast can arrive more than once (aborted round →
  // re-issued quit) while entries from the first round are still in flight — a second concurrent
  // flush re-dispatched the SAME still-queued entries (removal happens on success only).
  if (_flushing) return
  _flushing = true
  try {
    for (const entry of [..._pendingUpserts]) {
      window.todoAPI.dbCall(entry.op, entry.params)
        .then(() => { const i = _pendingUpserts.indexOf(entry); if (i >= 0) _pendingUpserts.splice(i, 1) })
        .catch(e => console.error('[todo] pending upsert flush failed at quit (kept for retry):', e))
    }
  } finally {
    // Hold the guard for a couple of microtasks so a same-tick re-broadcast cannot re-dispatch
    // entries whose success-removal callbacks have not run yet (real quit rounds are seconds apart)
    Promise.resolve().then(() => Promise.resolve()).then(() => { _flushing = false })
  }
}

function daysRangeTs (settings) {
  // "today/yesterday" are semantic options and can't be resolved by extracting digits (would NaN-fallback to 7): today = current day only (1), yesterday = from yesterday (2)
  const num = s => rangeDays(s, 7)
  return {
    expCompletedDays: num(settings.expiredCompletedTodoRange || '7d'),
    expUncompletedDays: num(settings.expiredUncompletedTodoRange || '30d'),
    upcomingDays: num(settings.upcomingTodoRange || '30d')
  }
}
export { daysRangeTs }
