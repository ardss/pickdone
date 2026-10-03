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

/* ---- D15 (TL-2) crash-proof queue: localStorage mirror, same contract as tomato.js's
 * retry queues (d11-r3). The queue used to be pure memory whose ONLY drain was the quit-flush
 * hook — a crash / force-kill before orderly quit dropped every queued entry with the process
 * while the DB never received the row (op-feedback unenforced). Every queue mutation now mirrors
 * to a single localStorage blob ({v, seq, ts, ...entry}); the module hydrates it at load, and the
 * boot drain (main.js, right after todo/init) replays hydrated entries — boot drain is the
 * primary recovery path, the quit flush an optimization. Residual window (stated, not masked):
 * the enqueue-time persist rides the same localStorage the renderer already trusts; a total
 * renderer-process death mid-write can lose the not-yet-saved blob — the same trust level as
 * every other renderer-side write. */
const PENDING_QUEUE_KEY = 'todoPendingUpserts'
const PENDING_QUEUE_V = 1
let _pendingSeq = 0
function nextPendingSeq () { _pendingSeq += 1; return _pendingSeq }
function persistQueue () {
  try {
    localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify({
      v: PENDING_QUEUE_V,
      entries: _pendingUpserts.map(e => ({ seq: e.seq, ts: e.ts, op: e.op, params: e.params }))
    }))
  } catch (e) { console.error('[todo] pending queue persist failed:', e) }
}
const hydratePendingQueue = (function hydrate () {
  let blob
  try { blob = JSON.parse(localStorage.getItem(PENDING_QUEUE_KEY)) } catch (e) {
    console.error('[todo] pending queue "' + PENDING_QUEUE_KEY + '" is corrupt, starting empty:', e)
    return
  }
  if (!blob || typeof blob !== 'object' || blob.v !== PENDING_QUEUE_V || !Array.isArray(blob.entries)) return
  for (const raw of blob.entries) {
    if (!raw || typeof raw.op !== 'string' || raw.params === undefined) continue
    const seq = typeof raw.seq === 'number' ? raw.seq : nextPendingSeq()
    if (seq > _pendingSeq) _pendingSeq = seq
    _pendingUpserts.push({ op: raw.op, params: raw.params, seq, ts: typeof raw.ts === 'number' ? raw.ts : Date.now() })
  }
})
hydratePendingQueue() // startup hydration: entries queued in a previous process life come back

/** Single removal point: splice + LS mirror re-save. */
function removeQueued (entry) {
  const i = _pendingUpserts.indexOf(entry)
  if (i < 0) return false
  _pendingUpserts.splice(i, 1)
  persistQueue()
  return true
}

/* ---- D15 (TL-1) terminal-vs-transient replay classification, one choke point for every op shape.
 * The flush catch used to keep every failed entry unconditionally, so a PERMANENT failure looped
 * on every replay forever (stale batch rejected, UNIQUE partial-index violation on a renewal
 * loser). classifyReplayFailure names the two known permanent modes; future permanent-failure
 * modes are added here once, and both choke points (safeUpsert's catch and flushPendingUpserts'
 * catch) inherit the semantics without per-caller knowledge. */
export function isUniqueViolation (err) {
  return !!(err && /UNIQUE constraint failed/.test(String((err && err.message) || err)))
}
export function classifyReplayFailure (err, entry) {
  void entry // every queued op shape shares the same permanent-failure surface today; the arg keeps the signature stable for future per-op modes
  return (isStaleBatchError(err) || isUniqueViolation(err)) ? 'terminal' : 'transient'
}

/** D15 (TL-1): addTodo's adopt-the-winner routine, extracted so the REPLAY path can reuse it.
 *  A UNIQUE-loser renewal entry queued with its own distinct taskId can never be superseded by
 *  taskId (the winner row lives under a different id); the only terminal conversion is to find
 *  the durably-present winner via the same queryTodos filter addTodo uses, and adopt (or drop). */
export async function adoptDuplicateWinnerRow (params) {
  if (!params || !params.repeatId) return null
  const targetDay = params.dayStart != null && params.dayStart !== 0
    ? params.dayStart
    : (params.todoTime ? +(window.dayjs(params.todoTime).startOf('day')) : 0)
  if (!targetDay) return null
  const existing = await window.todoAPI.dbCall('queryTodos', { deleted: 0, repeatId: params.repeatId, dayStartFrom: targetDay, dayStartTo: targetDay })
  return Array.isArray(existing) && existing.length ? existing[0] : null
}

/** D15 (TL-4): the rows an entry would write, in its op's own shape. */
function entryRows (entry) {
  if (!entry || !entry.params) return null
  if (entry.op === 'upsert') return [entry.params]
  if (entry.op === 'upsertMany') return Array.isArray(entry.params) ? entry.params : null
  if (entry.op === 'commitSyncBatch') return Array.isArray(entry.params.rows) ? entry.params.rows : null
  return null
}
function setEntryRows (entry, next) {
  if (entry.op === 'commitSyncBatch') entry.params.rows = next
  else if (entry.op === 'upsertMany') entry.params = next
}
/** D15 (TL-4) freshness gate, replay side of supersedePendingRow: batched-read the durable
 *  store's updateTime stamps and drop rows the DB already holds a STRICTLY newer version of
 *  (same newest-version-wins rule the enqueue path enforces in memory; ties dispatch as today).
 *  A failed/unusable read yields null = no gate information = dispatch as before (degradation,
 *  logged — never a silent skip of live data). */
async function loadDurableStamps () {
  try {
    const rows = await window.todoAPI.dbCall('getAll', {})
    if (!Array.isArray(rows)) return null
    const m = new Map()
    for (const r of rows) if (r && r.taskId != null) m.set(r.taskId, r.updateTime)
    return m
  } catch (e) {
    console.error('[todo] pending-flush freshness read failed (gating skipped this round):', e)
    return null
  }
}

/** [replay guard] The queue must hold only the NEWEST pending version of each row. A failed
 *  upsert used to keep its full row JSON queued forever; a later edit of the same task queued a
 *  SECOND entry, and on replay the STALE one was re-dispatched too — the older row JSON (db.js
 *  OPS.upsert is a blind ON CONFLICT DO UPDATE, src/main/db.js) then overwrote the newer edit:
 *  stale-wins until the next edit of that task. Single invariant, enforced at enqueue time for
 *  every op shape that carries rows ('upsert' single row / 'upsertMany' + 'commitSyncBatch' row
 *  lists): a newer write supersedes the older queued copy of the same taskId. */
export function supersedePendingRow (taskId) {
  if (taskId == null) return
  let changed = false
  for (let i = _pendingUpserts.length - 1; i >= 0; i--) {
    const entry = _pendingUpserts[i]
    if (!entry) continue
    if (entry.op === 'upsert') {
      if (entry.params && entry.params.taskId === taskId) _pendingUpserts.splice(i, 1)
    } else if (entry.op === 'upsertMany' || entry.op === 'commitSyncBatch') {
      const rows = entry.params && entry.params.rows !== undefined ? entry.params.rows : entry.params
      if (!Array.isArray(rows)) continue
      const next = rows.filter(r => !(r && r.taskId === taskId))
      if (next.length === 0) _pendingUpserts.splice(i, 1), changed = true
      else if (next.length !== rows.length) {
        if (entry.op === 'commitSyncBatch') entry.params.rows = next
        else entry.params = next
        changed = true
      }
    }
  }
  if (changed) persistQueue()
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
  let changed = false
  for (let i = _pendingUpserts.length - 1; i >= 0; i--) {
    const entry = _pendingUpserts[i]
    if (entry && entry.op === 'commitSyncBatch' && entry.params && entry.params.version != null && entry.params.version <= version) {
      _pendingUpserts.splice(i, 1)
      changed = true
    }
  }
  if (changed) persistQueue()
}

/** Queue a raw entry (upsertMany / commitSyncBatch share safeUpsert's replay guarantee:
 *  queueing also arms the quit-flush hook, same as safeUpsert). Callers queue batch entries that
 *  are already the newest known state of their rows — call supersedePendingBatch first to drop
 *  older queued copies of the same batch. */
export function queuePendingUpsert (entry) {
  _pendingUpserts.push({ op: entry.op, params: entry.params, seq: nextPendingSeq(), ts: Date.now() })
  persistQueue()
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
  const entry = { op: 'upsert', params: plain, seq: nextPendingSeq(), ts: Date.now() }
  _pendingUpserts.push(entry)
  persistQueue()
  Promise.resolve(commitCommand('todo', 'put', plain))
    .then(() => { removeQueued(entry) })
    // [TL-1] same terminal-vs-transient classification as the flush choke point: a permanent
    // failure (stale batch / UNIQUE loser) can never succeed on replay — drop it loudly instead
    // of leaving a doomed entry to be rejected on every quit flush forever.
    .catch(err => {
      if (classifyReplayFailure(err, entry) === 'terminal') {
        console.error('[todo] persist failed terminally (can never succeed on replay) — dropped from the replay queue:', err)
        removeQueued(entry)
      } else {
        console.error('[todo] persist failed (queued for quit-flush retry):', err)
      }
    })
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
async function flushPendingUpserts () {
  // Re-entrancy guard: the quit-flush broadcast can arrive more than once (aborted round →
  // re-issued quit) while entries from the first round are still in flight — a second concurrent
  // flush re-dispatched the SAME still-queued entries (removal happens on success only).
  if (_flushing) return
  _flushing = true
  try {
    // [TL-4] one batched freshness read for the whole round (read-only getAll, already the
    // renderer's init door); a failed/unusable read returns null and the round dispatches
    // ungated (logged degradation, never a silent skip).
    const stamps = await loadDurableStamps()
    for (const entry of [..._pendingUpserts]) {
      // [TL-4] newest-version-wins against the durable store: drop rows the DB already holds a
      // STRICTLY newer version of (ties dispatch — same rule supersedePendingRow enforces in
      // memory at enqueue). An entry with no surviving rows is superseded: removed, not dispatched.
      if (stamps) {
        const rows = entryRows(entry)
        if (rows) {
          const stale = rows.filter(r => r && r.taskId != null && stamps.has(r.taskId) &&
            Number(stamps.get(r.taskId)) > Number(r.updateTime || 0))
          if (stale.length === rows.length) { removeQueued(entry); continue }
          if (stale.length) {
            const keep = rows.filter(r => !stale.includes(r))
            setEntryRows(entry, keep)
            persistQueue()
          }
        }
      }
      window.todoAPI.dbCall(entry.op, entry.params)
        .then(() => { removeQueued(entry) })
        // [TL-1] queue-owned failure classification: stale batches and UNIQUE losers are
        // terminal (dropped, optionally adopt-the-winner); everything else stays queued.
        .catch(async e => {
          if (classifyReplayFailure(e, entry) === 'transient') {
            console.error('[todo] pending upsert flush failed at quit (kept for retry):', e)
            return
          }
          removeQueued(entry)
          if (isUniqueViolation(e) && entry.op === 'upsert') {
            // [TL-1] adopt-the-winner: convert the loser entry to the durably-present winner's
            // row (idempotent write) instead of looping on the partial index forever.
            try {
              const winner = await adoptDuplicateWinnerRow(entry.params)
              if (winner) {
                const wEntry = { op: 'upsert', params: winner, seq: nextPendingSeq(), ts: Date.now() }
                _pendingUpserts.push(wEntry)
                persistQueue()
                await window.todoAPI.dbCall('upsert', winner)
                removeQueued(wEntry)
              }
            } catch (e2) { console.error('[todo] duplicate-winner adoption failed (loser already dropped; winner is durably in the DB):', e2) }
          } else {
            console.error('[todo] pending upsert flush failed terminally — dropped from the replay queue:', e)
          }
        })
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
