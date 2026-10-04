/**
 * Subtask completion rule — pure, dependency-free.
 * Single source for BOTH ends: renderer/js/utils/core.js re-exports it (TodoItem._applySubCheck /
 * EditPanel use subsCompleteTarget), and cli/lib-subs.cjs consumes it via require(esm) so the CLI's
 * `subtask check` toggles the parent task in lockstep with the App instead of leaving a fully-checked
 * parent uncompleted (or a partially-unchecked parent completed).
 */

/** Whether all subtasks are complete (an empty list does not count as all complete) */
export function allSubsDone (subs) {
  return Array.isArray(subs) && subs.length > 0 && subs.every(x => x && x.checked)
}

/** Whether the parent task's completion state should toggle in sync with subtask completion:
 *  returns the completion state the parent should have, or null if no change needed */
export function subsCompleteTarget (subs, curComplete) {
  const all = allSubsDone(subs)
  if (all && !curComplete) return true
  if (!all && curComplete) return false
  return null
}
