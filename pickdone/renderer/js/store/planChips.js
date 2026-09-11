/**
 * Plan-chip sync concern, physically split out of store/todo.js (pure relocation, no semantic change):
 * the per-taskId serial chip-sync chain, the row-mutation chip-sync body, and the pure snapshot-replay
 * side-effect planner used by undo/redo (persistSnapshotDiff).
 */
import { dayjs } from '../utils/core.js'
import { moveTaskChips, clearTaskChips, snapshotForDelete, restoreSnapshot } from '../utils/dayPlans.js'

/** Chip-sync serial chain: when a task's reschedule fires in bursts, guarantees planMoveTask arrival order matches operation order */
const _chipSyncChain = new Map()

/** Serialize chip ops per taskId (shared by updateTodoFields and undo/redo snapshot replay, so both channels
 *  can never interleave planMoveTask/planDeleteTask for the same task out of order) */
export function enqueueChipSync (taskId, fn) {
  const prev = _chipSyncChain.get(taskId) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  _chipSyncChain.set(taskId, next)
  if (_chipSyncChain.size > 64) { for (const k of _chipSyncChain.keys()) { if (k !== taskId) _chipSyncChain.delete(k) } }
  return next
}

const fmtChipDay = ts => dayjs(ts).format('YYYY-MM-DD')

/** Common chip-sync body for a row mutation (shared: updateTodoFields direct edits and persistSnapshotDiff replay
 *  must run the identical migration logic, otherwise the two write channels drift apart) */
export async function rowChipSync (taskId, prevDayStart, nextRow) {
  try {
    const toDay = nextRow.delete === true ? null : (nextRow.dayStart ? fmtChipDay(nextRow.dayStart) : null)
    if (toDay === null) { await snapshotForDelete(taskId); await clearTaskChips(taskId); return }
    const fromDay = prevDayStart ? fmtChipDay(prevDayStart) : null
    await moveTaskChips(taskId, fromDay, toDay)
  } catch (e) { console.warn('[todo] schedule chip sync failed (task updated, chip will converge on next op):', e) }
}

export { fmtChipDay, snapshotForDelete, restoreSnapshot, clearTaskChips, moveTaskChips }

/** Pure planner for snapshot-replay side effects (unit-testable, no dayjs/window — day values stay raw timestamps).
 *  Root cause it addresses: undo/redo replays snapshot rows via safeUpsert, bypassing updateTodoFields' chip-sync /
 *  snapshot-restore chain; this decides which effects each changed row must re-run.
 *  @param before row in the snapshot we came FROM (null = row absent there)
 *  @param after  row in the snapshot we move TO (null = row absent there → replay soft-deletes it as an undone create)
 *  @returns list of effects: {op: 'snapshotForDelete'|'restoreSnapshot'|'clearTaskChips'|'moveTaskChips', taskId, fromTs?, toTs?} */
export function planSnapshotRowSync (before, after) {
  const row = after || before
  if (!row) return []
  const taskId = row.taskId
  if (!after) return [{ op: 'snapshotForDelete', taskId }] // undone create → replay soft-delete must snapshot+clear chips like deleteTodo
  if (before && before.delete === true && !after.delete) return [{ op: 'restoreSnapshot', taskId }] // undone soft-delete → write back the pre-delete chip snapshot like restoreFromRecycle
  const wasLive = !before || before.delete !== true
  if (wasLive && after.delete === true) return [{ op: 'snapshotForDelete', taskId }]
  // active→deleted: snapshotForDelete (photo + clear) is exactly deleteTodo's semantics. This branch also
  // serves REDO of a delete whose preceding undo already consumed the snapshot meta (restoreSnapshot empties
  // it) — clearing alone would leave nothing for the NEXT undo to restore, losing chips permanently
  // (2026-09-09 release review).
  if (wasLive && !after.delete && before && (before.dayStart || 0) !== (after.dayStart || 0)) {
    if (!after.dayStart) return [{ op: 'clearTaskChips', taskId }] // date removed → clear, same as updateTodoFields
    return [{ op: 'moveTaskChips', taskId, fromTs: before.dayStart || 0, toTs: after.dayStart }] // date change → migrate like updateTodoFields
  }
  if (!before && !after.delete && after.dayStart) {
    // redo of an undone create: its soft-delete phase snapshotted+cleared chips; write them back (no-op when no snapshot meta exists)
    return [{ op: 'restoreSnapshot', taskId }]
  }
  return []
}
