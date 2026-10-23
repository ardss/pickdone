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
// W7 P1 (2026-10-23): the decision body moved verbatim into shared/repeat-undo-core.mjs so the
// CLI twin (cli/lib.js, require(esm)) stops carrying a diverging hand-copy — its day-only
// heuristic was still deleting `repeat on` pre-generated future instances on undo (the exact
// bug the 2026-10-09 P1 root fix closed renderer-side).
export { findRenewedNextInstance } from '../../../shared/repeat-undo-core.mjs'
import { findRenewedNextInstance as _findRenewedNextInstance } from '../../../shared/repeat-undo-core.mjs'

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
    const renewedNext = _findRenewedNextInstance(todo, group)
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
