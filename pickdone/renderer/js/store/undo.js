/**
 * Undo/redo history concern, physically split out of store/todo.js (pure relocation, no semantic change):
 * the undo/redo stack bookkeeping (50-entry cap + 24MB byte budget + 400ms chained-merge window) as pure
 * state-transform functions, plus the time-travel steps and snapshot-diff persistence — the Vuex actions
 * in todo.js delegate to these.
 *
 * Round-5 P0 — reload epochs (the `_e` tag on stack entries):
 * LAN-sync reloads run todo/init with preserveHistory:true so the user's own undo history survives an
 * inbound sync round. But the surviving stacks hold whole-table snapshots taken BEFORE the peer's rows
 * arrived; undoing across the reload made persistSnapshotDiffCore emit delete:true tombstones for the
 * peer-created ids (present in the DB, absent in the stale snapshot baseline) — and the next sync round
 * propagated that deletion to the peer. Cross-device data loss.
 * Design (reload epoch, chosen over "baseline freshness" heuristics for being exact and stateless per entry):
 *   - `s._histEpoch` starts at 0 and increments once per preserveHistory reload, when a BARRIER snapshot
 *     of the post-reload table is pushed (historyBarrierCore) and the redo stack is cleared (redo across
 *     an inbound sync is meaningless — the "next" state no longer exists).
 *   - Every stack entry is tagged with the epoch current at push time (`withEpoch`).
 *   - The from-only delete loop in persistSnapshotDiffCore runs ONLY when the popped entry's epoch equals
 *     the current epoch — i.e. the baseline cannot predate any inbound rows. Untagged (pre-fix / pre-barrier
 *     session) entries read as epoch 0, so plain offline sessions keep the undo-of-create soft delete.
 *   - The upsert loop keeps running for ALL epochs: undoing to a post-barrier snapshot legitimately
 *     restores peer rows, and LWW on the peer arbitrates genuine edit conflicts.
 */
import { planSnapshotRowSync, enqueueChipSync, fmtChipDay, snapshotForDelete, restoreSnapshot, clearTaskChips, moveTaskChips } from './planChips.js'


export const HISTORY_LIMIT = 50 // undo stack cap (entries)
export const HISTORY_BYTES = 24 * 1024 * 1024 // undo stack byte-budget hard cap: one snapshot ~1MB with a thousand tasks; 50 entries once sat resident ~50MB unbounded

/* Snapshot = JSON string: stringify once on the push side, parse only at undo time; byte budget hard-caps stack memory (with a thousand tasks, 50 full snapshots once sat ~50MB unbounded) */
/** D5 (2026-09-20): shared eviction — run after BOTH the fresh-push accounting and the merge-delta
 *  accounting. The merge path used to skip it, so 400ms typing bursts (each merged delta small on its
 *  own) could grow `_histBytes` past HISTORY_BYTES without bound. */
function evictOverflow (s) {
  while (s.undoStack.length > 1 && (s.undoStack.length > HISTORY_LIMIT || s._histBytes > HISTORY_BYTES)) {
    s._histBytes -= s.undoStack[0].length
    s.undoStack.shift()
  }
}

/* Round-5 P0: snapshots are always produced by our own JSON.stringify of a plain object, so the epoch
 * tag is appended without a re-parse (stringify-once discipline holds). Untagged entries read as 0. */
function withEpoch (s, snapRaw) {
  const e = s._histEpoch || 0
  return e ? snapRaw.slice(0, -1) + `,"_e":${e}}` : snapRaw
}

export function historyPush (s, snapRaw) {
  snapRaw = withEpoch(s, snapRaw)
  // Chained changes within 400ms (EditPanel 350ms debounced saves, batch loops) merge into the stack top
  const now = Date.now()
  if (now - (s._histLastPushAt || 0) < 400 && s.undoStack.length) {
    const top = s.undoStack.length - 1
    s._histBytes = Math.max(0, (s._histBytes || 0) + snapRaw.length - s.undoStack[top].length)
    s.undoStack[top] = snapRaw
    s._histLastPushAt = now
    s.redoStack = []
    s._histRedoBytes = 0
    evictOverflow(s) // merge-delta accounting must respect the same byte budget as a fresh push
    return
  }
  s._histLastPushAt = now
  s.undoStack.push(snapRaw)
  s._histBytes = (s._histBytes || 0) + snapRaw.length
  // Dual limits: entry cap (old) + byte budget; evicted from the oldest end
  evictOverflow(s)
  s.redoStack = []
  s._histRedoBytes = 0
}

// redo()'s post-restore push: same eviction budget as historyPush but keeps the remaining redo
// entries alive (historyPush resets redoStack, which used to kill every redo step after the first),
// and breaks the merge window so a following edit starts a fresh undo step instead of fusing
export function historyPushKeepRedo (s, snapRaw) {
  snapRaw = withEpoch(s, snapRaw)
  s._histLastPushAt = 0
  s.undoStack.push(snapRaw)
  s._histBytes = (s._histBytes || 0) + snapRaw.length
  evictOverflow(s)
}

export function historyClear (s) { s.undoStack = []; s.redoStack = []; s._histLastPushAt = 0; s._histBytes = 0; s._histRedoBytes = 0 }

/** Round-5 P0: barrier pushed after a preserveHistory reload (inbound LAN-sync round). Bumps the reload
 *  epoch, clears the redo stack (its "next" states predate the inbound rows — redoing into them would
 *  resurrect stale tables), and records the post-reload table as the newest undo entry so the FIRST undo
 *  lands on the merged state instead of the pre-sync snapshot. Older (stale-epoch) entries stay reachable
 *  for the user's own earlier edits, but their diff can no longer emit delete tombstones (see
 *  persistSnapshotDiffCore). */
export function historyBarrierCore (s) {
  s._histEpoch = (s._histEpoch || 0) + 1
  s._histLastPushAt = 0 // barrier is its own discrete step: break the 400ms merge window
  s.redoStack = []
  s._histRedoBytes = 0
  const snapRaw = withEpoch(s, JSON.stringify({ todoList: s.todoList, recycleList: s.recycleList }))
  s.undoStack.push(snapRaw)
  s._histBytes = (s._histBytes || 0) + snapRaw.length
  evictOverflow(s)
}

// Break the 400ms chained merge: discrete ops (add/delete/purge) call this so the next push starts a fresh undo step,
// keeping those ops undoable on their own instead of fusing into a following EditPanel edit
export function historyBreakMerge (s) { s._histLastPushAt = 0 }

export function historyUndoPop (s) {
  const popped = s.undoStack.pop()
  if (popped) s._histBytes = Math.max(0, (s._histBytes || 0) - popped.length)
}

export function historyRedoPop (s) {
  const popped = s.redoStack.pop()
  if (popped) s._histRedoBytes = Math.max(0, (s._histRedoBytes || 0) - popped.length)
}

/** U-9 (2026-09-20): the redo stack gets the same dual budget as the undo stack — entries cap + byte
 *  budget (tracked in _histRedoBytes). Previously only the entry cap applied, so redo snapshots
 *  (each ~1MB with a thousand tasks) sat resident unbounded. */
function evictRedoOverflow (s) {
  while (s.redoStack.length > 1 && (s.redoStack.length > HISTORY_LIMIT || (s._histRedoBytes || 0) > HISTORY_BYTES)) {
    s._histRedoBytes = Math.max(0, (s._histRedoBytes || 0) - s.redoStack[0].length)
    s.redoStack.shift()
  }
}

export function historyRedoPush (s, snap) {
  snap = withEpoch(s, snap)
  s.redoStack.push(snap)
  s._histRedoBytes = (s._histRedoBytes || 0) + snap.length
  evictRedoOverflow(s)
}

/* ---------- Time travel (undo/redo) + snapshot-diff persistence ---------- */
// These mirror the Vuex action bodies 1:1; the actions in todo.js delegate here with their context.
// `dispatchPersistDiff` is injected because persistSnapshotDiff stays a todo-module action (it needs safeUpsert).

export async function undoStep ({ state, commit, dispatch }) {
  if (!state.undoStack.length) return false
  // Parse-before-pop: a corrupt snapshot used to be popped first and only then JSON.parse'd — the step vanished
  // into an unhandled rejection (main.js had no .catch) while the stack had already been mutated.
  const prevRaw = state.undoStack[state.undoStack.length - 1]
  let prev
  try { prev = JSON.parse(prevRaw) } catch (e) {
    console.error('[todo] undo snapshot corrupted, dropping the corrupt step:', e)
    commit('historyUndoPop') // dispose the unreadable entry so older (valid) undo steps stay reachable
    return false
  }
  commit('historyUndoPop')
  const cur = { todoList: state.todoList, recycleList: state.recycleList }
  commit('historyRedoPush', JSON.stringify(cur)) // stringify once here only, on the push side (tagged by historyRedoPush)
  commit('historyRestore', prev)
  const changedRows = (await dispatch('persistSnapshotDiff', {
    from: cur,
    to: prev,
    // Round-5 P0: stale-epoch baselines must not tombstone ids the snapshot never saw (peer-created rows)
    allowDeletes: (prev._e === undefined ? 0 : prev._e) === (state._histEpoch || 0)
  })) || []
  dispatch('computeViews')
  dispatch('writeCriticalBackup')
  // label reuses the diff result; no more two rounds of full stringify over both snapshots
  return { ok: true, label: changedRows.length === 1 ? (changedRows[0].taskContent || '') : '' }
}

export async function redoStep ({ state, commit, dispatch }) {
  if (!state.redoStack.length) return false
  // Parse-before-pop (same corruption guard as undo)
  const nextRaw = state.redoStack[state.redoStack.length - 1]
  let next
  try { next = JSON.parse(nextRaw) } catch (e) {
    console.error('[todo] redo snapshot corrupted, dropping the corrupt step:', e)
    commit('historyRedoPop')
    return false
  }
  commit('historyRedoPop')
  const cur = { todoList: state.todoList, recycleList: state.recycleList }
  commit('historyPushKeepRedo', JSON.stringify(cur))
  commit('historyRestore', next)
  const changedRows = (await dispatch('persistSnapshotDiff', {
    from: cur,
    to: next,
    allowDeletes: (next._e === undefined ? 0 : next._e) === (state._histEpoch || 0)
  })) || []
  dispatch('computeViews')
  dispatch('writeCriticalBackup')
  return { ok: true, label: changedRows.length === 1 ? (changedRows[0].taskContent || '') : '' }
}

/** Persist the diff after a snapshot switch: rows present in "after" but missing/different in "before" are upserted;
    rows present in "before" but missing in "after" (undoing a "create") are soft-deleted, guaranteeing they can be restored again.
    Returns the changed-rows list (reused for the undo toast's label). Row-change detection uses the updateTime invariant (all writes bump it uniformly via updateTodoFields/reorder/delete). */
export async function persistSnapshotDiffCore ({ commit }, { from, to, allowDeletes = true }, safeUpsert) {
  const fromMap = new Map(from.todoList.concat(from.recycleList).map(t => [t.taskId, t]))
  const toRows = to.todoList.concat(to.recycleList)
  const toIds = new Set(toRows.map(t => t.taskId))
  const changedRows = []
  const effects = []
  for (const row of toRows) {
    const before = fromMap.get(row.taskId)
    if (!before || before.updateTime !== row.updateTime) {
      commit('upsertLocal', row)
      safeUpsert({ ...row, status: 'update' })
      changedRows.push(row)
      // Snapshot replay bypasses updateTodoFields' chip-sync/snapshot-restore chain — plan the equivalent side effects
      for (const eff of planSnapshotRowSync(before || null, row)) effects.push(eff)
    }
  }
  for (const row of from.todoList.concat(from.recycleList)) {
    if (!toIds.has(row.taskId)) {
      // Round-5 P0: a stale-epoch baseline (taken before an inbound sync reload delivered peer rows) must
      // never tombstone ids it never saw — the delete:true row would propagate to the peer on the next
      // round and delete the task there. Local rows are still restored correctly via the upsert loop.
      if (!allowDeletes) continue
      // version reset to 0 (same as deleteTodo): a re-delete after restore must re-enter the sync
      // snapshot — syncTodos excludes delete rows already acked with version > 0, so without the
      // reset the undo-of-create soft delete never propagated
      const merged = { ...row, delete: true, updateTime: Date.now(), status: 'delete', version: 0 }
      commit('upsertLocal', merged)
      safeUpsert(merged)
      changedRows.push(merged)
      // Undone create → replay soft-delete: snapshot+clear schedule chips like deleteTodo does
      for (const eff of planSnapshotRowSync(row, null)) effects.push(eff)
    }
  }
  // Run the planned side effects through the same per-taskId serial chain as direct edits
  for (const eff of effects) {
    enqueueChipSync(eff.taskId, async () => {
      try {
        if (eff.op === 'snapshotForDelete') await snapshotForDelete(eff.taskId)
        else if (eff.op === 'restoreSnapshot') await restoreSnapshot(eff.taskId)
        else if (eff.op === 'clearTaskChips') await clearTaskChips(eff.taskId)
        else if (eff.op === 'moveTaskChips') await moveTaskChips(eff.taskId, eff.fromTs ? fmtChipDay(eff.fromTs) : null, fmtChipDay(eff.toTs))
      } catch (e) { console.warn('[todo] snapshot-replay chip sync failed (will converge on next op):', e) }
    })
  }
  return changedRows
}
