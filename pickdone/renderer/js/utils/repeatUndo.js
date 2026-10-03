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
  if (renewedNext && !renewedNext.complete && renewedNext.dayStart === last.dayStart) return renewedNext
  return null
}
