/** Unified exit for delete-type confirmations/undo: shared by all "move to recycle bin" entries; copy and grace period have a single source (via tt(), works without component context) */
import { tt } from './core.js'
import { showUndoToast } from './undoToast.js'

/**
 * Delete to recycle bin (undoable): low-friction path — no confirmation dialog; after deletion shows a 5-second undo toast.
 * Repeating tasks automatically go through the dedicated confirmation modal (this one only / entire series); all entries are unified, must not bypass it.
 * Pre-action confirmation dialogs are reserved for irreversible scenarios only (permanent delete / empty recycle bin).
 * Returns true if deleted, false if not (including the case of diverting to the repeat-scope confirmation modal).
 */
export function deleteWithUndo (vm, store, task) {
  if (!task) return Promise.resolve(false)
  // Repeating task: must ask about scope before deletion (same criterion as TodoItem.isRepeat: repeatId is a valid repeatId)
  if (task.repeatId && task.repeatId !== 'null') {
    store.commit('ui/askRepeatDelete', task.taskId)
    return Promise.resolve(false)
  }
  return store.dispatch('todo/deleteTodo', task).then(() => {
    const undo = () => {
      const cur = store.state.todo.recycleList.find(t => t.taskId === task.taskId)
      if (!cur) return
      store.dispatch('todo/updateTodoFields', { taskId: task.taskId, patch: { delete: false, deletedAt: 0, status: 'update' } })
      vm.$message.success(tt('statsJ.Confirm.restored'))
    }
    // Must use the component instance $message (EP 2.x): the old window.ELEMENT.Message is the element-ui (Vue2) global,
    // which doesn't exist in this stack — it once caused the undo toast to silently never appear on all delete paths
    if (vm.$message && window.Vue) {
      showUndoToast(vm.$message.bind(vm), [
        tt('statsJ.Confirm.deleted') + '：' + (task.taskContent || tt('statsJ.TodoItem.untitled')) + '　',
        window.Vue.h('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undo }, tt('statsJ.Confirm.undo'))
      ])
    }
    return true
  }).catch(() => false)
}

/** Unified undo exit for irreversible removals inside the edit panel (tags/subtasks/reminder rows/attachments):
 *  shares the same 5-second undo toast as deleteWithUndo, avoiding "silent, unrecoverable deletion inside the panel".
 *  Usage: removeWithUndo(this, () => { ...perform removal... }, () => { ...restore... }) */
export function removeWithUndo (vm, doRemove, undo) {
  doRemove()
  if (!vm.$message || !window.Vue) return
  showUndoToast(vm.$message.bind(vm), [
    tt('statsJ.Confirm.removed') + '　',
    window.Vue.h('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undo }, tt('statsJ.Confirm.undo'))
  ])
}

/** Unified exit for rescheduling (drag / move to today/tomorrow / calendar eventDrop): applies the change + "Moved to X + Undo" toast.
 *  apply/revert are dispatched by the caller as patches, keeping the data channel consistent with this place. */
export function moveWithUndo (vm, { label, apply, revert }) {
  apply()
  if (!vm.$message || !window.Vue) return
  showUndoToast(vm.$message.bind(vm), [
    label + '　',
    window.Vue.h('a', {
      style: { color: 'var(--brand)', cursor: 'pointer' },
      onClick: () => { revert(); vm.$message.closeAll() }
    }, tt('statsJ.TodoItem.undoMove'))
  ])
}

/** Batch-move exit with undo: snap = original-value snapshot array; revertOf(item) restores one entry.
 *  One-click revert restores the whole group (same undo layer as batch delete); label is the success text. */
export function batchMoveWithUndo (vm, { label, snap, revertOf }) {
  if (!vm.$message || !window.Vue || !snap.length) return
  showUndoToast(vm.$message.bind(vm), [
    label + '　',
    window.Vue.h('a', {
      style: { color: 'var(--brand)', cursor: 'pointer' },
      onClick: () => { for (const s of snap) revertOf(s); vm.$message.closeAll() }
    }, tt('statsJ.TodoItem.undoMove'))
  ])
}


/** Unified triple confirmation for emptying the recycle bin (warning → keyword → second confirmation). The recycle-bin page and settings page used to have one vs. three confirmations; strength is now aligned.
 *  resolve = fully confirmed; reject = canceled at any step / keyword mismatch (callers can just catch). */
export function confirmRecycleClear (vm, n) {
  const tt = k => vm.$t(k)
  return vm.$confirm(tt('statsC.RecycleBin.clearConfirm'), tt('statsC.RecycleBin.dangerAction'), {
    type: 'error',
    confirmButtonText: tt('statsC.RecycleBin.continueText')
  }).then(() => vm.$prompt(
    tt('statsC.RecycleBin.clearKeywordPrompt', { n, kw: tt('statsC.RecycleBin.clearKeyword') }),
    tt('statsC.RecycleBin.dangerAction'),
    { confirmButtonText: tt('statsC.RecycleBin.continueText'), cancelButtonText: tt('statsC.RecycleBin.cancelText') }
  )).then(({ value }) => {
    if (String(value || '').trim() !== tt('statsC.RecycleBin.clearKeyword')) {
      vm.$message.warning(tt('statsC.RecycleBin.clearKeywordMismatch'))
      return Promise.reject(new Error('keyword-mismatch'))
    }
    return vm.$confirm(tt('statsC.RecycleBin.clearFinalConfirm', { n }), tt('statsC.RecycleBin.dangerAction'), {
      type: 'error',
      confirmButtonText: tt('statsC.RecycleBin.continueText')
    })
  })
}
