/** Today-page sort mode — pure logic extracted from the store (unit-testable).
 *  Modes are stored as stable keys custom|created|difficulty; legacy persisted data may be Chinese and is normalized for compatibility. */
const LEGACY = { '自定义': 'custom', '按创建日期': 'created', '按难度': 'difficulty' }

export function normalizeSortMode (mode) {
  return LEGACY[mode] || mode || 'custom'
}

/** Review P3 (2026-09-22): numeric field that degrades to `fb` when missing/NaN — a raw NaN in a
 *  subtraction comparator made the sort order implementation-defined (rows could reshuffle or drop
 *  relative order); NaN now means "unknown", sorted into a stable fallback bucket (fb sorts LAST in
 *  ascending order, FIRST when descending). */
function numOr (v, fb) { return (typeof v === 'number' && Number.isFinite(v)) ? v : fb }

/** Return a new sorted array per mode (input not mutated):
 *  custom=manual order (taskSort descending, createTime ascending as stable tiebreak) · created=newest first · difficulty=higher difficulty first */
export function sortByMode (arr, mode) {
  const m = normalizeSortMode(mode)
  const out = [...arr]
  if (m === 'custom') {
    // taskSort fallback: rows without a manual order sit at the BOTTOM (descending key), createTime fallback 0
    out.sort((a, b) => (numOr(b.taskSort, -Infinity) - numOr(a.taskSort, -Infinity)) || (numOr(a.createTime, 0) - numOr(b.createTime, 0)))
  } else if (m === 'created') {
    out.sort((a, b) => numOr(b.createTime, 0) - numOr(a.createTime, 0))
  } else if (m === 'difficulty') {
    out.sort((a, b) => (b.difficulty || 0) - (a.difficulty || 0))
  }
  return out
}
