/* Saved-views sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Saved views (smart lists): the same SQLite `filters` table the App's FilterModal writes / FilterView consumes. */
const { matchesViewConds } = require('../shared/filter-core.mjs') // D4 2026-09-24: saved-view matcher single source with db.js / FilterView.vue (require(esm))

module.exports = ({ open, commit, audit, CliError, dayjs, resolveCategory }) => {
  /* conds contract is pinned by db.js normConds (both ends' read path): { catId: -1|categoryId, priority: -1|N, dateMode: 'all'|'today'|'week'|'overdue'|'none' }
     with -1/'all' = condition off. Any other key would be stripped on read, so the CLI maps flags onto exactly this shape. */
  function viewsList () { return open().call('filterList') }

  function resolveView (input) {
    const rows = viewsList()
    const byId = rows.find(v => String(v.id) === String(input))
    if (byId) return byId
    const hits = rows.filter(v => v.name === input)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new CliError(`view "${input}" is ambiguous (${hits.length} saved views share this name); use the view id (view list --json)`, 'AMBIGUOUS_MATCH')
    throw new CliError(`view not found: "${input}" (view list to browse)`, 'VIEW_NOT_FOUND')
  }

  /** English one-line conds summary (the same conditions the App's FilterView header shows) */
  function viewCondsSummary (conds) {
    const c = conds || {}
    const parts = []
    if (c.catId != null && c.catId !== -1) {
      const cat = open().call('getAllCategories').find(x => x.categoryId === c.catId)
      parts.push(cat ? 'cat:' + cat.categoryName : 'cat #' + c.catId)
    }
    if (c.priority != null && c.priority !== -1) parts.push('priority ' + c.priority)
    if (c.dateMode && c.dateMode !== 'all') parts.push(c.dateMode)
    return parts.join(' · ') || 'all undone tasks'
  }

  /** Create a saved view from CLI flags (duplicate names rejected). The conds shape always carries all
   *  three keys — that IS the renderer's parseConds output shape (-1/'all' = off). */
  function viewAdd (name, { category, priority, overdue, nodate } = {}) {
    const clean = String(name || '').trim()
    if (!clean) throw new CliError('view add needs a name', 'USAGE')
    if (viewsList().some(v => v.name === clean)) throw new CliError(`view "${clean}" already exists (view list to browse)`, 'VIEW_EXISTS')
    const conds = { catId: -1, priority: -1, dateMode: 'all' }
    if (category != null && category !== true) conds.catId = resolveCategory(category)
    if (priority != null && priority !== true) {
      const p = parseInt(priority, 10)
      if (!(p >= 0 && p <= 3) || String(p) !== String(priority).trim()) throw new CliError('--priority accepts 0-3 (got "' + priority + '")', 'USAGE')
      conds.priority = p
    }
    const modes = [overdue ? 'overdue' : null, nodate ? 'none' : null].filter(Boolean)
    if (modes.length > 1) throw new CliError('--overdue and --nodate are mutually exclusive (both set the date condition)', 'USAGE')
    if (modes.length) conds.dateMode = modes[0]
    const id = commit('filter', 'put', { name: clean, conds, sort: 0 })
    audit.record({ action: 'view.add', targets: [], changes: [{ after: { id, name: clean, conds } }], note: 'saved view created (same filters table as the App smart lists)' })
    return { id, name: clean, conds, sort: 0 }
  }

  /** Remove a saved view by name or id */
  function viewRm (input) {
    const v = resolveView(input)
    commit('filter', 'delete', v.id)
    audit.record({ action: 'view.rm', targets: [], changes: [{ before: { id: v.id, name: v.name, conds: v.conds } }], note: 'saved view removed' })
    return { id: v.id, name: v.name }
  }

  /** Apply a saved view's conds to a task pool — mirrors renderer FilterView.list exactly:
   *  undone only, catId/priority equality (-1 = off), dateMode today/isoWeek/overdue/none windows.
   *  opts.done override (review P1 2026-09-12): an explicit `list --view X --done/--undone` owns the completion
   *  filter — default false keeps the FilterView undone-only parity, true skips the complete check (the fetch
   *  already filtered by the explicit flag) so done tasks are no longer silently dropped. */
  function applyViewConds (conds, tasks, { done = false } = {}) {
    const today0 = +dayjs().startOf('day')
    const weekEnd = +dayjs().endOf('isoWeek') // isoWeek plugin extended explicitly in cli/lib.js
    // D4 2026-09-24: the matcher moved to shared/filter-core.mjs (single source with db.js conds
    // parsing and the renderer's FilterView.list); the `done` override contract is unchanged.
    return tasks.filter(t => matchesViewConds(t, conds, { today0, weekEnd }, { done }))
  }

  /** listTodos fetch options for a saved view: push the view's dateMode/category down into the QUERY so the
   *  row cap can no longer truncate away matching tasks before applyViewConds runs (review P1 2026-09-10:
   *  a 200-cap fetch filtered afterwards hid valid rows for >cap libraries). applyViewConds stays as the
   *  authoritative post-filter so the semantics remain byte-identical to the app's FilterView.
   *  D19-DOM2 (#11): cap raised 500 → 5000 — a view matching >500 tasks was truncated while the App's
   *  FilterView shows all of them. The bound stays finite deliberately (memory tradeoff: applyViewConds
   *  post-filters the full mapped set in JS, so 5000 rows is the accepted worst case). */
  function viewFetchOpts (conds) {
    const c = conds || {}
    const mode = c.dateMode
    return {
      range: mode === 'today' || mode === 'week' || mode === 'overdue' ? mode : null,
      noDate: mode === 'none',
      done: false, // views are undone-only (FilterView parity, same as applyViewConds)
      category: c.catId != null && c.catId !== -1 ? c.catId : null,
      limit: 5000 // fetch max; user --limit narrows AFTER applyViewConds
    }
  }

  return { viewsList, resolveView, viewCondsSummary, viewAdd, viewRm, applyViewConds, viewFetchOpts }
}
