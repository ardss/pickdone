/** Shared project-page open door (list, board, timeline, handoff).
 * Project-v2 membership is authoritative. A category is NEVER substituted for an
 * explicit project link. Numeric legacy routes remain supported during transition.
 */
export async function openProjectTask (store, projectOrCategoryId, taskId) {
  const scope = String(projectOrCategoryId || '')
  const find = () => {
    if (scope.startsWith('prj_')) {
      const links = (store.state.projectV2 || {}).taskProjects || {}
      return (store.state.todo.todoList || []).find(t =>
        t && !t.delete && t.taskId === taskId && links[t.taskId] === scope)
    }
    return store.getters['todo/byCategory'](projectOrCategoryId).find(t => t.taskId === taskId)
  }
  let raw = find()
  if (!raw) {
    try { await store.dispatch('todo/init') } catch { /* preserve original cache verdict */ }
    raw = find()
  }
  if (raw) store.commit('ui/openEdit', raw)
  return !!raw
}
