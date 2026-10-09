/**
 * syncTodos implementation, extracted verbatim from store/todo.js (structure-size ratchet).
 * Pure relocation: the action is now a thin wrapper (`syncTodos (ctx) { return syncTodosCore(ctx) }`);
 * snapshot selection, the version fence, the retry-enqueue and the backup dispatch are unchanged.
 */
import { reportError } from '../../utils/core.js'
import { commit as commitCommand } from '../../utils/commandBus.js'
import { queuePendingUpsert, isStaleBatchError, supersedePendingBatch } from './todoPendingUpserts.js'
import { deproxyRows } from './todoViews.js'

export async function syncTodosCore ({ state, commit, dispatch }) {
  if (state.isSyncing) return
  commit('setSyncing', true)
  // Declared out here (not in the try) so the catch's retry-enqueue can reach it — a `const`
  // inside the try block is invisible to catch, which silently killed the whole compensation
  let snapshot = []
  // Hoisted like `snapshot` (same try-scoped `const` trap): the catch's retry-enqueue must reuse the
  // snapshot-time version. Using live `state.version` there would push the quit-flush replay cursor past
  // rows the user edited during the await, letting the db layer mark that newer content status='sync'
  // even though it was never sent.
  let serverV = state.version
  try {
    // Snapshot only dirty rows (status !== 'sync'); during the await, the user's new edits (status='update') aren't wrongly marked synced.
    // A recycle-bin row already acked (version > 0, stamped by a previous syncTodos success) is
    // excluded — otherwise it re-entered the snapshot and the commitSyncBatch write on EVERY sync
    // (P3 2026-09-12). A fresh delete resets version to 0 and is sent once.
    // An already-synced whole table skips the wholesale upsertMany write entirely (Ctrl+S with no changes = no write)
    // [empty-sync-version fix] the version bump moved BELOW the empty-snapshot early return: a
    // no-op sync used to increment state.version without writing the todosVersion cursor, so
    // the in-memory counter ran ahead of the persisted one and reset backward across restarts.
    snapshot = [...state.todoList, ...state.recycleList]
      .filter(t => t.status !== 'sync' && !(t.status === 'delete' && t.version > 0))
    if (!snapshot.length) return
    commit('bumpVersion')
    serverV = state.version
    const snapshotIds = new Set(snapshot.map(t => t.taskId))
    // Atomic commit (W3 2026-09-12): rows + todosVersion cursor go to the DB in ONE transaction
    // (commitSyncBatch) instead of two separate dbCalls. Crash safety: previously a crash between the
    // upsertMany and the setMeta left rows at 'add'/'update' (harmless — they were just re-sent), but
    // writing status='sync' into the DB without atomicity would create a fatal intermediate state —
    // rows marked 'sync' with the cursor behind get skipped by the dirty-row filter and the cursor
    // never advances again = silent permanent non-convergence. Inside one transaction there is no
    // intermediate state: after a crash the batch is either fully re-sent (old dirty semantics) or
    // fully acknowledged (new semantics). The db layer forces status='sync' on every row.
    await commitCommand("todo", "commitBatch", { rows: deproxyRows(snapshot), version: serverV })
    // [TL-1 doom-loop fix] a commitSyncBatch queued by an EARLIER transient failure (version <=
    // serverV) is doomed from here on: the quit-flush replay would be rejected as stale on every
    // flush forever, because the success path used to run no supersede (only the catch paths did).
    // The successful batch covered every row that was dirty at snapshot time — a superset of any
    // older queued batch's rows — so dropping queued copies with version <= serverV loses nothing.
    supersedePendingBatch(serverV)
    // Only rows in the snapshot that weren't re-edited during the await are marked synced (can't do a wholesale markSyncedAll).
    // Recycle-bin rows (status==='delete' in memory) keep that status — but get the server version
    // stamped so they stop re-entering the dirty snapshot on every sync (P3 2026-09-12)
    ;[...state.todoList, ...state.recycleList]
      .filter(t => snapshotIds.has(t.taskId) && t.status !== 'update')
      .forEach(t => { t.status = t.status === 'delete' ? 'delete' : 'sync'; t.version = serverV })
  } catch (err) {
    reportError('syncTodos', err)
    // Version-fence handling (P2): the db layer rejects a stale batch with
    // "commitSyncBatch: version N < current todosVersion M — stale batch rejected" — a NEWER
    // batch already persisted these rows, so re-enqueueing would replay a doomed batch forever
    // (every quit flush). Drop it; the rows in memory are already acked by the newer batch.
    // Any other failure (IO/lock/transient) keeps the retry-enqueue below.
    // [Fault-1] the stale-batch shape check is the shared isStaleBatchError predicate
    // (todoPendingUpserts.js) instead of a private inline regex.
    const staleBatch = isStaleBatchError(err)
    if (staleBatch) {
      // [Fault-1 stale splice] a PREVIOUS failure of this same version may already have queued the
      // doomed batch for quit-flush replay — a stale rejection proves it can never succeed, so
      // splice it out of the queue instead of leaving it to be rejected on every flush.
      supersedePendingBatch(serverV)
    }
    // Enqueue for retry like reorderTodos/safeUpsert (round-6 leftover): rows stay dirty in memory,
    // but the quit-flush replay needs the op verbatim to survive a close-before-retry
    // [Fault-2] the new batch supersedes any older queued batch copies (same version retries queue
    // twice otherwise, and an older-version copy would replay doomed forever)
    if (!staleBatch && snapshot.length) {
      try { supersedePendingBatch(serverV); queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: deproxyRows(snapshot), version: serverV } }) } catch (queueErr) {
        // R7 sweep (2026-10-10): a failed compensation enqueue (localStorage quota/private mode) used
        // to be fully silent — rows stayed dirty in memory only, and a quit before the next periodic
        // sync lost them with no trace beyond a devtools line. Escalate through the same channel the
        // outer failure uses so the failure is user-visible, while keeping the UI flow alive.
        console.error('[todoSync] quit-flush compensation enqueue failed — unsynced rows at risk:', queueErr)
        try { reportError('syncTodos', queueErr) } catch { /* surface is best-effort */ }
      }
    }
  } finally {
    commit('setSyncing', false)
    // In the finally block: the empty-snapshot early return used to skip the critical backup entirely
    dispatch('writeCriticalBackup')
  }
  // Stay quiet on sync success (per common practice, auto sync doesn't disturb the user); the version number is an implementation detail and goes into no copy
}
