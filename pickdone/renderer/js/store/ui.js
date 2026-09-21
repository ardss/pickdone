import { parseSubtasks, parseJSONSafe, tt } from '../utils/core.js'
import { commit as commitCommand } from "../utils/commandBus.js"
import { showUndoToast } from '../utils/undoToast.js'
/** UI module — right-side editor/dialog control (mirrors the reference ui module semantics) */

/* D6-F1 (2026-09-21): calendar inline create commits an "(untitled)" task BEFORE opening the edit
 * panel — Esc / outside-click used to leave the nameless orphan on the board. Shared cleanup body
 * for closeEditCleanup / collapseEditCleanup: when the panel was editing THE inline-created task and
 * its content is still empty (a title typed in the final instants lands via EditPanel's unmount
 * flushSave — hence the one-macrotask grace wait), soft-delete it with the standard undo toast.
 * Strictly flag-scoped: a user-opened empty task is NEVER touched. */
async function cleanupInlineCreated ({ state, rootState, dispatch }, createdId) {
  state.inlineCreatedTaskId = ''
  await new Promise(r => setTimeout(r, 60))
  const t = ((rootState.todo && rootState.todo.todoList) || []).find(x => x.taskId === createdId)
  if (!t || t.delete) return
  if ((t.taskContent || '').trim()) return
  try {
    await dispatch('todo/deleteTodo', t, { root: true })
    const h = window.Vue && window.Vue.h
    const msg = window.ElementPlus && window.ElementPlus.ElMessage
    const undo = () => {
      const cur = rootState.todo.recycleList.find(x => x.taskId === createdId)
      if (cur) dispatch('todo/updateTodoFields', { taskId: createdId, patch: { delete: false, deletedAt: 0, status: 'update' } }, { root: true })
    }
    if (h && msg && window.Vue) {
      showUndoToast(msg, [
        tt('statsJ.Confirm.deleted') + '：' + tt('statsJ.TodoItem.untitled') + '　',
        h('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undo }, tt('statsJ.Confirm.undo'))
      ])
    }
  } catch (e) { /* orphan cleanup is best-effort: never block the close flow */ }
}
export default {
  namespaced: true,
  state: () => ({
    rightSidebarTodoEdit: {
      visible: false,
      collapsed: false,
      taskId: '',
      title: '',
      desc: '',
      dateTs: 0,
      remindTs: 0,
      reminderOffsets: [],
      reminderExtra: [],
      categoryId: 0,
      repeatId: null,
      sublist: [],
      todoImageList: [],
      fileList: []
    },
    activeNav: 'today',
    // Cross-highlight: task id currently hovered on the DayRail fact lane (list rows highlight in return); '' = none
    hoverTaskId: '',
    // Empty tags created by the user via "New Tag" in the sidebar (the tag itself is still derived from the body's #xxx; only the placeholder is stored here)
    userTags: [],
    showSettingsModal: false,
    showFeedbackModal: false,
    showRepeatModalFor: null,   // taskId
    showRepeatDeleteConfirm: null,
    contextMenu: { visible: false, x: 0, y: 0, items: [] },
    tomatoPanelVisible: false,
    tomatoAbandonVisible: false, // Abandon-focus dialog: rendered by a separate layout layer (do not nest it inside the tomato bar, to avoid the positioning degrading into a small box)
    tomatoFocusRecordVisible: false,
    tomatoRecordAddVisible: false,
    // Tomato ledger posting details: taskId of the ledger currently viewed ('' = closed). Actual count = sum of records; changing the actual = posting (add/remove/modify vouchers)
    accountTaskId: '',
    daySelectedTs: 0,
    isLocked: false,
    // D6-F1: taskId of the task created-empty by the calendar inline-create flow (createAt/tbCreate/
    // grid Enter). Cleared by any user-initiated openEdit; consumed by closeEditCleanup.
    inlineCreatedTaskId: '',
    // Auto-update transient state (mirror of updater:event broadcasts, not persisted): badge only recognizes ready
    updateStatus: 'idle',
    updateReady: false
  }),
  mutations: {
    setUpdateState (s, d) { s.updateStatus = (d && d.status) || 'idle'; s.updateReady = s.updateStatus === 'ready' },
    setHoverTask (s, id) { s.hoverTaskId = id || '' },
    openEdit (s, todo) {
      if (!todo) return
      // D6-F1: a user-initiated open (row click / event click) retargets the panel — the inline-create
      // flag must not leak onto the newly opened task
      s.inlineCreatedTaskId = ''
      // 只留被消费的字段(visible/collapsed/taskId;EditPanel hydrate 自任务行)——
      // 原双套字段名(新 title/desc/... + 旧 todoContent/...)写了全仓零读,2026-09-04 三轮扫荡清退
      // 新命名字段集为 EditPanel.hydrate 的数据源(this.e 整包快照,title/desc/dateTs/remindTs/子任务/图片/附件全被消费);
      // 只清退真正零读的旧命名集(todoContent/todoDescription/todoDateTs/reminderTime/difficulty,2026-09-04 三轮扫荡)
      s.rightSidebarTodoEdit = {
        visible: true,
        collapsed: false,
        taskId: todo.taskId,
        title: todo.taskContent || '',
        desc: todo.taskDescribe || '',
        dateTs: todo.todoTime || 0,
        remindTs: todo.reminderTime || 0,
        reminderOffsets: Array.isArray(todo.reminderOffsets) ? todo.reminderOffsets.slice() : [],
        reminderExtra: Array.isArray(todo.reminderExtra) ? todo.reminderExtra.slice() : [],
        categoryId: todo.categoryId || 0,
        repeatId: todo.repeatId || null,
        sublist: parseSubtasks(todo.subtasks),
        todoImageList: parseJSONSafe(todo.image) || [],
        fileList: parseJSONSafe(todo.files) || []
      }
    },
    closeEdit (s) { s.rightSidebarTodoEdit.visible = false; s.rightSidebarTodoEdit.taskId = null },
    // D6-F1: mark the panel's current task as inline-created-empty (calendar createAt/tbCreate/grid Enter)
    markInlineCreate (s, taskId) { s.inlineCreatedTaskId = taskId || '' },
    // Collapse (edit state is preserved; the thin strip on the right edge can expand it again); selecting any task (openEdit) auto-expands
    collapseEdit (s) { s.rightSidebarTodoEdit.collapsed = true },
    expandEdit (s) { s.rightSidebarTodoEdit.collapsed = false },
    patchEdit (s, p) { Object.assign(s.rightSidebarTodoEdit, p) },
    setNav (s, k) { s.activeNav = k },
    setUserTags (s, list) { s.userTags = list || [] },
    toggleTomatoPanel (s, v) { s.tomatoPanelVisible = v == null ? !s.tomatoPanelVisible : v },
    openTomatoAbandon (s) { s.tomatoAbandonVisible = true },
    closeTomatoAbandon (s) { s.tomatoAbandonVisible = false },
    toggleTomatoFocusRecord (s, v) { s.tomatoFocusRecordVisible = v == null ? !s.tomatoFocusRecordVisible : v },
    toggleTomatoRecordAdd (s, v) { s.tomatoRecordAddVisible = v == null ? !s.tomatoRecordAddVisible : v },
    openTaskAccount (s, taskId) { s.accountTaskId = taskId || '' },
    setDaySelected (s, ts) { s.daySelectedTs = ts },
    toggleSettings (s, v) { s.showSettingsModal = v == null ? !s.showSettingsModal : v },
    closeFeedback (s) { s.showFeedbackModal = false },
    askRepeatDelete (s, taskIdOrnull) { s.showRepeatDeleteConfirm = taskIdOrnull },
    askRepeatEdit (s, taskIdOrNull) { s.showRepeatModalFor = taskIdOrNull },
    openMenu (s, { x, y, items }) { s.contextMenu = { visible: true, x, y, items } },
    closeMenu (s) { s.contextMenu.visible = false },
    setLocked (s, v) { s.isLocked = v }
  },
  actions: {
    // D6-F1: close the edit panel; when it was editing the inline-created calendar task and the task
    // is STILL unnamed, soft-delete it (undoable) instead of leaving an "(untitled)" orphan
    async closeEditCleanup ({ state, rootState, commit, dispatch }) {
      const createdId = state.inlineCreatedTaskId
      const wasInline = !!(createdId && state.rightSidebarTodoEdit.visible && state.rightSidebarTodoEdit.taskId === createdId)
      commit('closeEdit')
      if (wasInline) await cleanupInlineCreated({ state, rootState, dispatch }, createdId)
    },
    // D6-F1: outside-click / collapse-button path — a normal collapse keeps editing state, but an
    // unnamed inline-created orphan must not survive it: close + clean up instead
    async collapseEditCleanup ({ state, commit, dispatch, rootState }) {
      const createdId = state.inlineCreatedTaskId
      const wasInline = !!(createdId && state.rightSidebarTodoEdit.visible && state.rightSidebarTodoEdit.taskId === createdId)
      if (!wasInline) { commit('collapseEdit'); return }
      commit('closeEdit') // orphan cleanup closes the panel (collapse would leave a zombie editor)
      await cleanupInlineCreated({ state, rootState, dispatch }, createdId)
    },
    // Round-1 P0 (2026-09-21): placeholder-tag ('userTags' meta) persistence lives HERE in the
    // store, not in the side-nav children — the w5 architecture guard bans dbCall in
    // SnManageTagsModal (lifecycle side effects stay out of the split children). Rename/delete of
    // a placeholder tag must update this meta key or the placeholder silently survives.
    renameUserTag ({ state, commit }, { from, to }) {
      const list = (state.userTags || []).map(x => (x === from ? to : x))
      commit('setUserTags', list)
      try { commitCommand("meta", "put", ['userTags', JSON.stringify(list)]).catch(() => {}) } catch (e) { /* best-effort */ }
    },
    removeUserTag ({ state, commit }, name) {
      const list = (state.userTags || []).filter(x => x !== name)
      commit('setUserTags', list)
      try { commitCommand("meta", "put", ['userTags', JSON.stringify(list)]).catch(() => {}) } catch (e) { /* best-effort */ }
    }
  }
}
