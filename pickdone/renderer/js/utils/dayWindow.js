/**
 * [A3] DayDeck ±7-day window helpers. Pure so the clamp is unit-testable without mounting
 * the component.
 */

/**
 * Clamp a timestamp to a member of a sorted ascending day-timestamp window.
 * - an exact member passes through (the usual strip click);
 * - a ts inside the window's span but not an exact member snaps to the NEAREST member (also
 *   absorbs the ±1h drift a fixed 86400000ms window accumulates across a DST transition);
 * - a ts BEFORE the window clamps to the first day, AFTER clamps to the last day, so the
 *   deck's front card and the store's daySelectedTs can never disagree (the old findIndex
 *   silently fell through and strip and stack drifted apart);
 * - an empty window returns the input unchanged.
 *
 * @param {number[]} days sorted ascending start-of-day timestamps
 * @param {number} ts candidate timestamp
 * @returns {number} a timestamp guaranteed to be a member of `days` (unless days is empty)
 */
export function clampToDayWindow (days, ts) {
  if (!Array.isArray(days) || !days.length) return ts
  const n = Number(ts) || 0
  if (days.includes(n)) return n
  if (n <= days[0]) return days[0]
  const last = days[days.length - 1]
  if (n >= last) return last
  let best = days[0]
  for (const d of days) if (Math.abs(d - n) < Math.abs(best - n)) best = d
  return best
}
