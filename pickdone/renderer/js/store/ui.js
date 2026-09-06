import { parseSubtasks, parseJSONSafe } from '../utils/core.js'
/** UI module — right-side editor/dialog control (mirrors the reference ui module semantics) */
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
    // Auto-update transient state (mirror of updater:event broadcasts, not persisted): badge only recognizes ready
    updateStatus: 'idle',
    updateReady: false
  }),
  mutations: {
    setUpdateState (s, d) { s.updateStatus = (d && d.status) || 'idle'; s.updateReady = s.updateStatus === 'ready' },
    setHoverTask (s, id) { s.hoverTaskId = id || '' },
    openEdit (s, todo) {
      if (!todo) return
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
  }
}
