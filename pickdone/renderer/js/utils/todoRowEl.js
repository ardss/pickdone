/** Shared todo-row DOM locator (2026-09-25).
 *
 *  Extracted from EditPanel.refocusRow + main.js's shortcut selectedTaskId(): both need to find
 *  the list row element for a task id. The old EditPanel fallback walked `el.__vue__` only — a
 *  Vue2-ism; this app boots with Vue3 createApp (main.js), where the instance hangs off
 *  `el.__vueParentComponent.ctx`. Both channels are probed here, plus the data-attribute
 *  fast path. */
export function findTaskRowEl (id) {
  if (id == null || typeof document === 'undefined') return null
  const direct = document.querySelector(
    '.td-item[data-task-id="' + id + '"], .td-item[data-id="' + id + '"], .td-item[data-taskid="' + id + '"]')
  if (direct) return direct
  const rows = document.querySelectorAll('.td-item')
  for (const r of rows) {
    const v2 = r.__vue__
    if (v2 && v2.todo && String(v2.todo.taskId) === String(id)) return r
    const v3 = r.__vueParentComponent && r.__vueParentComponent.ctx
    if (v3 && v3.todo && String(v3.todo.taskId) === String(id)) return r
  }
  return null
}
