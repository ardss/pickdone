import { tt } from './core.js'
import { flyPaperPlane } from './paperPlane.js'
import { showUndoToast } from './undoToast.js'
/**
 * Unified entry point for complete/un-complete — all completion interactions (list checkbox, edit panel,
 * context menu, todo-box dot) share the same feedback semantics: on completion show a "completed + undo" toast (3s),
 * un-completing only announces. When a no-date task completes, completedAt = now, so it naturally counts toward today in "Achieved".
 * Optional fromEl: the row element that triggered completion — plays the "paper plane flies to Achieved" animation when enabled in settings (decorative, silently ignored on failure).
 */
/**
 * @param {{ store: any, message: any, todo: any, announce?: any, fromEl?: any }} _p
 */
export function toggleCompleteWithUndo ({ store, message, todo, announce, fromEl }) {
  const raw = store.state.todo.todoList.find(t => t.taskId === todo.taskId) ||
              store.state.todo.recycleList.find(t => t.taskId === todo.taskId) || todo
  const wasComplete = !!raw.complete
  const content = raw.taskContent || ''
  let fromPoint = null
  if (!wasComplete && fromEl && fromEl.getBoundingClientRect) {
    try {
      const r = fromEl.getBoundingClientRect()
      fromPoint = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    } catch { /* skip animation if position is unavailable */ }
  }
  const p = store.dispatch('todo/toggleComplete', raw)
  // dependency unlock feedback: when completion makes dependents ready, surface them once (advisory; dep feature is devMode-gated)
  Promise.resolve(p).then((merged) => {
    const names = merged && merged._unlocked
    if (!names || !names.length || !message) return
    message({ type: 'success', message: tt('statsA.core.unlocked', { list: names.join('、') }), duration: 4000 })
  }).catch(() => {})
  if (announce) announce(tt('statsA.core.' + (wasComplete ? 'undoneAnnounce' : 'doneAnnounce'), { c: content }))
  // Paper plane: after completion, fly from the original row position to the sidebar "Achieved" entry (can be disabled via settings/reduced-motion)
  if (fromPoint) Promise.resolve(p).then(() => flyPaperPlane(fromPoint, tt('statsE.DoneEntry.label'))).catch(() => {})
  if (message) {
    // Complete → "Undo" (un-complete); un-complete → "Restore completion". Symmetric in both directions, unified 5s duration (same as delete undo)
    const undo = () => {
      const cur = store.state.todo.todoList.find(t => t.taskId === todo.taskId)
      if (!cur) return
      store.dispatch('todo/toggleComplete', cur)
      if (announce) announce(tt('statsA.core.' + (wasComplete ? 'doneAnnounce' : 'undoneAnnounce'), { c: content }))
    }
    showUndoToast(message, [
      tt('statsA.core.' + (wasComplete ? 'undoneAnnounce' : 'doneAnnounce'), { c: content || tt('statsJ.TodoItem.untitled') }) + '　',
      // The action word is uniformly "Undo" across the whole chain, no direction variants ("Re-complete" reads awkwardly, finalized by users)
      window.Vue.h('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undo }, tt('statsA.core.undo'))
    ])
  }
  return p
}
