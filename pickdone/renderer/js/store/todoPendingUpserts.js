/**
 * Extracted from store/todo.js (structure-size ratchet): the DB write pending queue +
 * the settings date-range resolver. No behavior change — code moved verbatim.
 */
import { commit as commitCommand } from '../utils/commandBus.js'
import { rangeDays } from '../utils/core.js'

// ---- DB write pending queue (mirrors tomato.js's _pendingLedger): a failed task upsert stays queued and replays on the next quit flush, so a transient IPC/db failure can't silently drop a task edit ----
const _pendingUpserts = []
let _todoFlushHooked = false

/** Queue a raw entry (upsertMany / commitSyncBatch share safeUpsert's replay guarantee:
 *  queueing also arms the quit-flush hook, same as safeUpsert). */
export function queuePendingUpsert (entry) {
  _pendingUpserts.push(entry)
  hookQuitFlush()
}

/** Live queue (test seam: _testInternals exposes the same array instance). */
export function pendingUpserts () { return _pendingUpserts }

/** Unified exit for DB persistence: failures are logged, never producing floating rejections (local/DB mismatch is visible in the console)
 *  JSON round-trip de-proxies: row objects come from reactive state, so nested arrays like reminderOffsets are Proxies
 *  that fail IPC structured cloning (symptom: every task edit logs "An object could not be cloned" and the DB receives no update) */
// Exported for unit tests (same precedent as planSnapshotRowSync): the quit-flush retry contract
// (a failed upsert stays queued and is replayed) is behavior worth pinning.
export function safeUpsert (row) {
  let plain
  try { plain = JSON.parse(JSON.stringify(row)) } catch (e) { plain = row }
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
  for (const entry of [..._pendingUpserts]) {
    window.todoAPI.dbCall(entry.op, entry.params)
      .then(() => { const i = _pendingUpserts.indexOf(entry); if (i >= 0) _pendingUpserts.splice(i, 1) })
      .catch(e => console.error('[todo] pending upsert flush failed at quit (kept for retry):', e))
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
