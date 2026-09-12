/**
 * Plan-chip sync concern, physically split out of store/todo.js (pure relocation, no semantic change):
 * the per-taskId serial chip-sync chain, the row-mutation chip-sync body, and the pure snapshot-replay
 * side-effect planner used by undo/redo (persistSnapshotDiff).
 *
 * SINGLE FACADE (2026-09-12 convergence): moveTaskChips / clearTaskChips / snapshotForDelete /
 * restoreSnapshot have exactly one implementation (utils/dayPlans.js) and are re-exported from here.
 * Store consumers (undo.js / todo.js) must import these names from THIS module, never from
 * utils/dayPlans.js directly — guarded by tests/unit/store/w4-plan-chips-facade.test.mjs.
 */
import { dayjs, FMT } from '../utils/core.js'
import { moveTaskChips, clearTaskChips, snapshotForDelete, restoreSnapshot } from '../utils/dayPlans.js'

/** Chip-sync serial chain: when a task's reschedule fires in bursts, guarantees planMoveTask arrival order matches operation order.
 *  Values are {promise, settled} entries: the chain deletes itself once settled, and the size cap below only evicts
 *  already-settled entries (2026-09-12: blindly deleting a pending entry used to detach the queued tail from its
 *  predecessor, so the next enqueue started a fresh Promise.resolve() chain and the two chains ran in parallel
 *  out of order). */
const _chipSyncChain = new Map()

/** Serialize chip ops per taskId (shared by updateTodoFields and undo/redo snapshot replay, so both channels
 *  can never interleave planMoveTask/planDeleteTask for the same task out of order) */
export function enqueueChipSync (taskId, fn) {
  const prev = _chipSyncChain.get(taskId) || { promise: Promise.resolve() }
  const next = prev.promise.catch(() => {}).then(fn)
  const entry = { promise: next, settled: false }
  next.then(() => { entry.settled = true }, () => { entry.settled = true })
    .then(() => { if (_chipSyncChain.get(taskId) === entry) _chipSyncChain.delete(taskId) })
  _chipSyncChain.set(taskId, entry)
  if (_chipSyncChain.size > 64) {
    for (const [k, e] of _chipSyncChain) { if (k !== taskId && e.settled) _chipSyncChain.delete(k) }
  }
  return next
}

const fmtChipDay = ts => dayjs(ts).format(FMT.date)

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

/** Facade re-exports: the four chip ops above (single impl in utils/dayPlans.js) + fmtChipDay */
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
    // date removed → snapshot+clear (2026-09-12: previously cleared without snapshotting, so an undo of the
    // date-clear had no snapshot meta to restore and the schedule chips were lost permanently — rowChipSync's
    // same-scenario path already snapshotted via updateTodoFields' delete-branch parity)
    if (!after.dayStart) return [{ op: 'snapshotForDelete', taskId }, { op: 'clearTaskChips', taskId }]
    return [{ op: 'moveTaskChips', taskId, fromTs: before.dayStart || 0, toTs: after.dayStart }] // date change → migrate like updateTodoFields
  }
  if (!before && !after.delete && after.dayStart) {
    // redo of an undone create: its soft-delete phase snapshotted+cleared chips; write them back (no-op when no snapshot meta exists)
    return [{ op: 'restoreSnapshot', taskId }]
  }
  return []
}
