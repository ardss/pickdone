/**
 * Repeat-group undo support — shared by the store's toggleComplete undo path (B2, 2026-10-02).
 * The CLI twin implements the same removal in cli/lib.js toggleComplete ("F3 P2 2026-09-21"):
 * completing the LAST live instance of a repeat group auto-renews the next instance; undoing
 * that completion must remove the renewed instance again, otherwise a phantom sibling stays
 * in the group forever (only a manual delete clears it).
 *
 * Pure decision function (no store/db access) so both hosts and tests can share one contract:
 * only the instance renewal itself is ever removed — same rid, nearest LATER dayStart, still the
 * group's last live instance, and not itself completed. Any earlier sibling (a genuine older
 * instance the user un-did) is left alone.
 *
 * @param {{ dayStart: number }} undoneTodo the instance being un-completed (dayStart > 0 required)
 * @param {Array<{ complete: boolean, dayStart: number }>} group other live instances of the same
 *        rid (delete filtered out), sorted by dayStart ASCENDING by the caller
 * @returns {object|null} the renewed-next row to remove, or null when nothing should be removed
 */
export function findRenewedNextInstance (undoneTodo, group) {
  if (!undoneTodo || !(undoneTodo.dayStart > 0) || !group || !group.length) return null
  const last = group[group.length - 1]
  const renewedNext = group.find(x => x.dayStart > undoneTodo.dayStart)
  if (renewedNext && !renewedNext.complete && renewedNext.dayStart === last.dayStart) {
    // [P1 2026-10-09, ROOT fix of the 2026-10-08 timed-renewal propagation miss] the day-based
    // heuristic above cannot distinguish a renewal-created instance from a legitimate
    // PRE-GENERATED future instance (RepeatModal slices dates up-front and the CLI's repeatOn
    // pre-generates too), so un-completing soft-deleted a pre-generated sibling and cascaded its
    // chips. Sound discriminator: a renewal instance is minted AT completion time (createTime on
    // the row, db-rows.js rowToTodo), while a pre-generated instance was created BEFORE the
    // completion (undoneTodo.completedAt). Require createTime >= completedAt.
    if (!(renewedNext.createTime > 0) || !(undoneTodo.completedAt > 0)) {
      // Limitation: legacy rows without createTime/completedAt fall back to the old day-only
      // heuristic (removal preserved) rather than skipping the cleanup for all old data.
      return renewedNext
    }
    if (renewedNext.createTime >= undoneTodo.completedAt) return renewedNext
  }
  return null
}

/** Store-side wiring for the B2 undo: find the instance renewal created and soft-delete it the
 *  same way deleteTodo does (version reset to 0 so the soft delete re-enters the sync snapshot;
 *  `deleting` stripped before persisting), plus the schedule-chip snapshot cascade and view
 *  recompute — all best-effort: the undo itself must succeed even if the removal hits a snag.
 *  Deps are injected (Vuex context pieces + the persistence helpers) to keep this module pure. */
export async function removeRenewedInstance ({ todo, state, commit, dispatch, safeUpsert, snapshotForDelete }) {
  try {
    const rid = todo && todo.repeatId
    if (!rid || !(todo.dayStart > 0)) return
    const group = state.todoList
      .filter(x => x.repeatId === rid && !x.delete && x.taskId !== todo.taskId && x.dayStart > 0)
      .sort((a, b) => a.dayStart - b.dayStart)
    const renewedNext = findRenewedNextInstance(todo, group)
    if (!renewedNext) return
    const now = Date.now()
    const merged = { ...renewedNext, delete: true, deleting: true, deletedAt: now, updateTime: now, status: 'delete', version: 0 }
    commit('upsertLocal', merged)
    const row = { ...merged }; delete row.deleting
    safeUpsert(row)
    // Schedule chips follow the removal: same snapshot→clear cascade as deleteTodo
    try { await snapshotForDelete(renewedNext.taskId) } catch (e) { console.warn('[todo] failed to snapshot chips for the removed renewed instance:', e) }
    dispatch('computeViews')
    dispatch('writeCriticalBackup')
  } catch (e) { /* best-effort cleanup */ }
}
