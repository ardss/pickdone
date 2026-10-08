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
  // [d23 P2] failure honesty: the completion announce used to fire SYNCHRONOUSLY while
  // `.catch(() => {})` swallowed rejections — the user heard "completed" (and got the undo
  // toast) for a write that never landed, with the checkbox still unchecked. The announce
  // (and the dependency-unlock feedback) now fire only AFTER the dispatch resolves; a
  // rejection surfaces the shared actionFailedMsg toast (same shape as the undo path's
  // d21-A2 rejection handler below). The undo toast stays synchronous on purpose: it is the
  // immediate click affordance (hover-pause owns its lifetime), not a success report —
  // moving it post-resolve broke perceived responsiveness without fixing any state.
  Promise.resolve(p).then((merged) => {
    if (announce) announce(tt('statsA.core.' + (wasComplete ? 'undoneAnnounce' : 'doneAnnounce'), { c: content }))
    // dependency unlock feedback: when completion makes dependents ready, surface them once (advisory; dep feature is devMode-gated)
    const names = merged && merged._unlocked
    if (names && names.length && message) message({ type: 'success', message: tt('statsA.core.unlocked', { list: names.join('、') }), duration: 4000 })
  }, (e) => {
    try { console.error('[completeAction] completion failed:', e) } catch { /* console may be gone */ }
    if (message) {
      try { message({ type: 'error', message: tt('statsH.main.actionFailedMsg') + ((e && e.message) || ''), duration: 3000 }) } catch { /* toast must not throw */ }
    }
  })
  // Paper plane: after completion, fly from the original row position to the sidebar "Achieved" entry (can be disabled via settings/reduced-motion)
  if (fromPoint) Promise.resolve(p).then(() => flyPaperPlane(fromPoint, tt('statsJ.DoneEntry.label'))).catch(() => {})
  if (message) {
    // Complete → "Undo" (un-complete); un-complete → "Restore completion". Symmetric in both directions, unified 5s duration (same as delete undo)
    const undo = () => {
      const cur = store.state.todo.todoList.find(t => t.taskId === todo.taskId)
      if (!cur) return
      // [d21-A2] the undo dispatch used to be fire-and-forget: the "restored" success toast fired
      // unconditionally even when the write rejected. Observe the promise — success feedback (and
      // the stale-toast closeAll) only after it RESOLVES; on rejection surface the shared
      // actionFailedMsg pattern (same shape as confirm.js restoreAndToast's moveFailToast path).
      Promise.resolve(store.dispatch('todo/toggleComplete', cur)).then(() => {
        if (announce) announce(tt('statsA.core.' + (wasComplete ? 'doneAnnounce' : 'undoneAnnounce'), { c: content }))
        // [uiux-2026-10-01 J2 P3] The undo is the feedback moment this toast exists for: leaving the
        // stale "已完成：… 撤销" toast on screen read as if the click never registered (and invited a
        // second click on a dead control). Close the undo toast and confirm the revert with the
        // mirrored announce copy — same visible-confirmation contract as moveWithUndo's closeAll.
        const doneText = tt('statsA.core.' + (wasComplete ? 'doneAnnounce' : 'undoneAnnounce'), { c: content || tt('statsJ.TodoItem.untitled') })
        try { message.closeAll() } catch { /* mock or already closed */ }
        message({ type: 'success', message: doneText, duration: 2000 })
      }, (e) => {
        try { console.error('[completeAction] undo failed:', e) } catch { /* console may be gone */ }
        try { message({ type: 'error', message: tt('statsH.main.actionFailedMsg') + ((e && e.message) || ''), duration: 3000 }) } catch { /* toast must not throw */ }
      })
    }
    showUndoToast(message, [
      tt('statsA.core.' + (wasComplete ? 'undoneAnnounce' : 'doneAnnounce'), { c: content || tt('statsJ.TodoItem.untitled') }) + '　',
      // The action word is uniformly "Undo" across the whole chain, no direction variants ("Re-complete" reads awkwardly, finalized by users)
      window.Vue.h('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undo }, tt('statsA.core.undo'))
    ])
  }
  return p
}
