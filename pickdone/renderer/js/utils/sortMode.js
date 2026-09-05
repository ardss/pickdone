/** Today-page sort mode — pure logic extracted from the store (unit-testable).
 *  Modes are stored as stable keys custom|created|difficulty; legacy persisted data may be Chinese and is normalized for compatibility. */
const LEGACY = { '自定义': 'custom', '按创建日期': 'created', '按难度': 'difficulty' }

export function normalizeSortMode (mode) {
  return LEGACY[mode] || mode || 'custom'
}

/** Return a new sorted array per mode (input not mutated):
 *  custom=manual order (taskSort descending, createTime ascending as stable tiebreak) · created=newest first · difficulty=higher difficulty first */
export function sortByMode (arr, mode) {
  const m = normalizeSortMode(mode)
  const out = [...arr]
  if (m === 'custom') {
    out.sort((a, b) => b.taskSort - a.taskSort || a.createTime - b.createTime)
  } else if (m === 'created') {
    out.sort((a, b) => b.createTime - a.createTime)
  } else if (m === 'difficulty') {
    out.sort((a, b) => (b.difficulty || 0) - (a.difficulty || 0))
  }
  return out
}
