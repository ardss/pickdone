'use strict'

/**
 * Saved-view (smart list) filter core — single source shared by three layers:
 *   - src/main/db.js        (conds normalization/parsing at the storage boundary)
 *   - cli/lib.js            (applyViewConds: applies conds to a task pool, with a `done` override)
 *   - renderer/js/views/FilterView.vue (the App's view page, same matcher)
 * Previously each layer hand-rolled its own copy of the whitelist + the dateMode window
 * math and the three copies could drift silently (consolidated 2026-09-24, D4 contract
 * single-source wave — pure relocation, semantics byte-identical to the old copies).
 *
 * Pure functions over plain objects; no clock access (today0/weekEnd are injected by the
 * caller so each layer keeps its own "now" convention — dayjs startOf('day')/endOf('isoWeek')
 * in the CLI, utils/todayBounds.js + utils/weekGrid.js in the renderer).
 */

/** dateMode whitelist — an unknown dateMode must degrade to 'all', never throw */
export const FILTER_DATE_MODES = new Set(['all', 'today', 'week', 'overdue', 'none'])

/** Filter-condition normalization: whitelist validation for dateMode/catId/priority, falling back
 *  on invalid values (an unknown dateMode makes filtering silently degrade to "all") */
export function normConds (c) {
  const v = c && typeof c === 'object' ? c : {}
  const intOf = x => (Number.isFinite(x) && Number.isInteger(x) ? x : -1)
  return {
    catId: intOf(v.catId),
    priority: intOf(v.priority),
    dateMode: FILTER_DATE_MODES.has(v.dateMode) ? v.dateMode : 'all'
  }
}

/** Filter-condition JSON parsing (non-objects become empty conditions) */
export function parseConds (s) {
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? normConds(v) : normConds(null) } catch { return normConds(null) }
}

/**
 * Does one task pass a saved view's conds? — undone only, catId/priority equality
 * (-1 = off), dateMode today/isoWeek/overdue/none windows.
 * @param {object} t task row ({delete, complete, categoryId, priority, dayStart})
 * @param {object} c normalized conds ({catId, priority, dateMode})
 * @param {object} win {today0, weekEnd} — the day window boundaries (ms epoch)
 * @param {object} [opts] {done=false} — an explicit done flag owns the completion filter:
 *   false (default) drops completed tasks (FilterView parity); true skips the completion
 *   check entirely (the caller already fetched with an explicit completion flag).
 */
export function matchesViewConds (t, c, win, { done = false } = {}) {
  const conds = c || {}
  const { today0, weekEnd } = win || {}
  if (t.delete) return false
  if (done === false && t.complete) return false
  if (conds.catId != null && conds.catId !== -1 && (t.categoryId || 0) !== conds.catId) return false
  if (conds.priority != null && conds.priority !== -1 && (t.priority || 0) !== conds.priority) return false
  if (conds.dateMode && conds.dateMode !== 'all') {
    const d = t.dayStart || 0
    if (conds.dateMode === 'today' && d !== today0) return false
    if (conds.dateMode === 'week' && !(d >= today0 && d <= weekEnd)) return false
    if (conds.dateMode === 'overdue' && !(d && d < today0)) return false
    if (conds.dateMode === 'none' && d !== 0) return false
  }
  return true
}
