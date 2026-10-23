/**
 * Repeat-group undo renewal discriminator — SINGLE SOURCE shared by both hosts:
 *   - renderer/js/utils/repeatUndo.js (ESM import, store's toggleComplete undo path, B2 2026-10-02)
 *   - cli/lib.js toggleComplete (CJS require(esm), same require(esm) pattern as shared/limits.mjs —
 *     Node >= 22.12; Electron 39 embeds node 22.x)
 *
 * W7 P1 (2026-10-23, CLI twin of the 2026-10-09 renderer root fix): the CLI kept a hand-copied
 * day-only heuristic that could not distinguish a renewal-created instance from a legitimate
 * PRE-GENERATED future instance (RepeatModal slices dates up-front and the CLI's `repeat on`
 * pre-generates too) — undoing a completion soft-deleted a pre-generated sibling and cascaded
 * its chips. This module carries the sound discriminator so the two ends can no longer drift.
 *
 * Pure decision function (no store/db access):
 * only the instance renewal itself is ever removed — same rid (caller filters the group),
 * nearest LATER dayStart, still the group's last live instance, and not itself completed.
 * Any earlier sibling (a genuine older instance the user un-did) is left alone.
 *
 * @param {{ dayStart: number, completedAt?: number }} undoneTodo the instance being un-completed
 *        (dayStart > 0 required)
 * @param {Array<{ complete: boolean, dayStart: number, createTime?: number }>} group other live
 *        instances of the same rid (delete filtered out), sorted by dayStart ASCENDING by the caller
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
