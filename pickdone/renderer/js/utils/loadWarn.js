/** Per-day schedule-load evaluation (v0.2 load warning).
 *  Single math source shared by the Today capacity band and project-panel load badges.
 *  Pure functions only: callers pass the task subset they consider "planned for the day"
 *  (Today page = today's + overdue incomplete; project badge = that project's tasks scheduled today). */

/** Sum of estimated tomatoes over incomplete tasks. estimateOf(task) is injected by the caller
 *  (utils/tomatoEstimate getEstimate(task.id)); a task with a missing/0 estimate still consumes
 *  one slot — mirrors the capacity-band denominator intent (a task is at least one tomato of work). */
export function dayPlannedLoad (todos, estimateOf) {
  let planned = 0
  for (const t of (todos || [])) {
    if (!t || t.delete || t.complete) continue
    const raw = estimateOf ? estimateOf(t) : t.tomatoEstimate
    planned += Math.max(1, Math.round(Number(raw) || 1))
  }
  return planned
}

/** Threshold <= 0 disables the warning ('off'). planned strictly above threshold -> 'warn'. */
export function loadLevel (planned, threshold) {
  const th = Math.round(Number(threshold) || 0)
  if (th <= 0) return 'off'
  return planned > th ? 'warn' : 'ok'
}
