import { collectCascadeIds } from '../../store/category.js'
import { showUndoToast } from '../../utils/undoToast.js'

/** D6 (2026-09-21) F4+F5 rework of category delete — ONE shared exit for the sidebar rows and the
 *  manage-categories modal (the modal used to carry a verbatim copy that drifted):
 *  - the confirm-only gate is inverted to the app's undo-toast doctrine (act first, 5s undo), and
 *    the toast names the cascade: how many tasks moved to uncategorized and how many saved filters
 *    were purged (category/softDelete hard-cascaded those filters with no undo — B9);
 *  - the per-task reassignment loop is failure-isolated: a row update throwing no longer aborts the
 *    whole cascade — the rest continue and a partial-failure toast reports ok/total honestly;
 *  - undo restores the category flags (category/recover, incl. project-meta backups), the task
 *    assignments and re-puts the purged saved filters (idempotent by id).
 *  `ctx` needs: $store, $t, $message. Returns true when the delete ran. */
export async function deleteCategoryWithUndo (ctx, c) {
  const st0 = ctx.$store.state
  const victims = collectCascadeIds(st0.category, c.categoryId)
  // Shallow copies: these rows are the LIVE store objects, and the reassignment loop below writes
  // categoryId:0 onto them — without the copy the "pre-delete snapshot" the undo restores from
  // would already be overwritten (undo would patch categoryId:0, a silent no-op).
  const affectedTasks = st0.todo.todoList.filter(x => victims.includes(x.categoryId)).map(x => ({ ...x }))
  const victimKey = new Set(victims.map(String))
  const affectedFilters = (st0.filters.list || []).filter(f => f && f.conds && victimKey.has(String(f.conds.catId)))
  ctx.$store.commit('category/softDelete', c.categoryId)
  if (st0.category.projectIds.includes(c.categoryId)) ctx.$store.commit('category/setProject', { id: c.categoryId, flag: false })
  const failed = []
  for (const t of affectedTasks) {
    try {
      await ctx.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { categoryId: 0 } })
    } catch (e) { failed.push(t) }
  }
  if (failed.length) {
    ctx.$message.warning(ctx.$t('statsG.SideNav.delCatPartialFail', { ok: affectedTasks.length - failed.length, total: affectedTasks.length }))
  }
  // Clean up settings keys pointing at the dead category id: otherwise the todo box filtered by that category stays forever empty (showing 0 items even after data restore)
  const st = ctx.$store.state.settings
  // Review P1 (2026-09-22): test against the FULL cascade victim set, not just the root id — a folder
  // delete also tombstones its descendants, so a subcategory-targeted todoBoxCategoryId survived
  // pointing at a deleted id and the todo box stayed forever empty (0 items, even after undo).
  const reset = {}
  if (victimKey.has(String(st.todoBoxCategoryId))) reset.todoBoxCategoryId = -1
  if (victimKey.has(String(st.newTodoCategoryId))) reset.newTodoCategoryId = 0
  if (victimKey.has(String(st.calendarCategory))) reset.calendarCategory = 0
  const settingsReset = Object.keys(reset).length
  const preReset = { todoBoxCategoryId: st.todoBoxCategoryId, newTodoCategoryId: st.newTodoCategoryId, calendarCategory: st.calendarCategory }
  // Review P3 (2026-09-22): route through the settings/update ACTION (not the raw mutation) so the
  // reset mirrors to config.json / shortcuts like every other settings write — the raw commit used
  // to leave config.json pointing at the dead category id until the next unrelated settings change.
  if (settingsReset) await ctx.$store.dispatch('settings/update', reset)
  const undo = async () => {
    for (const vid of victims) ctx.$store.commit('category/recover', vid)
    // Review P2 (2026-09-22): re-check each task BEFORE restoring its snapshotted categoryId — the 5s
    // undo window allows concurrent user edits (task moved elsewhere, or soft-deleted). Stomping the
    // current categoryId with the stale snapshot would silently revert the user's move.
    for (const t of affectedTasks) {
      if (failed.some(f => f.taskId === t.taskId)) continue
      const cur = (ctx.$store.state.todo.todoList || []).find(x => x.taskId === t.taskId)
      if (!cur || cur.delete || cur.categoryId !== 0) continue
      try { await ctx.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { categoryId: t.categoryId } }) } catch (e) { /* best-effort */ }
    }
    for (const f of affectedFilters) {
      try { await ctx.$store.dispatch('filters/save', f) } catch (e) { /* best-effort */ }
    }
    if (settingsReset) await ctx.$store.dispatch('settings/update', preReset)
  }
  const summary = ctx.$t('statsG.SideNav.delCatUndone', {
    name: c.categoryName,
    tasks: affectedTasks.length,
    filters: affectedFilters.length
  })
  const h = window.Vue && window.Vue.h
  if (h && window.Vue) {
    showUndoToast(ctx.$message.bind(ctx), [
      summary + '　',
      h('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undo }, ctx.$t('statsJ.Confirm.undo'))
    ])
  }
  return true
}
