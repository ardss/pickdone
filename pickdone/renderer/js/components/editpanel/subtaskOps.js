/**
 * W21 split (2026-10-30): subtask-list mechanics pulled out of EditPanel.vue.
 * The subList STATE, addSub/delSub/moveSub/renameSub (undo indexOf anchors) and the save
 * pipeline stay in the host; only the sortable-drag setup and the toggle linkage move here.
 * Pure `vm`-taking functions (same convention as edit-panel/repeat.js / attachments.js).
 */
import { subsCompleteTarget } from '../../utils/core.js'

/**
 * Subtask drag sorting (sortablejs library; Up/Down buttons kept as a keyboard-accessible
 * fallback). The panel body is under v-if="e", so the nodes do not exist at mounted time --
 * called after hydrate; old instances become invalid when nodes are replaced, destroy before
 * rebuilding. Moved verbatim from EditPanel.initSubSortable (W21 split).
 */
export function initSubSortable (vm) {
  if (vm._sortable) { try { vm._sortable.destroy() } catch (err) { /* already destroyed with the node */ } vm._sortable = null }
  vm.$nextTick(() => {
    const el = vm.$el && vm.$el.querySelector('.ep-subs')
    if (!el || !window.Sortable) return
    vm._sortable = window.Sortable.create(el, {
      handle: '.ep-sub-drag',
      animation: 150,
      onEnd: (evt) => {
        const { oldIndex, newIndex } = evt
        if (oldIndex === newIndex || oldIndex == null || newIndex == null) return
        const item = vm.subList.splice(oldIndex, 1)[0]
        vm.subList.splice(newIndex, 0, item)
        vm.markDirty('subtasks')
        vm.queueSave({})
      }
    })
  })
}

/**
 * Subtask <-> parent linkage (consistent with the list page's TodoItem behavior) — moved
 * verbatim from EditPanel.toggleSub (W21 split).
 */
export function toggleSub (vm, s) {
  s.checked = !s.checked; vm.markDirty('subtasks'); vm.queueSave({})
  if (vm.task) {
    const target = subsCompleteTarget(vm.subList, vm.task.complete)
    if (target !== null) vm.toggleComplete()
  }
}
