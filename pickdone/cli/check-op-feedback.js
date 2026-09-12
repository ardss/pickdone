#!/usr/bin/env node
/**
 * Change-operation feedback consistency gate (systematically closed out 2026-09-01).
 * Background: after the 7b0c5a7 closeout, newly extracted shared menu/linkage paths again showed "bare dispatch without undo", proving
 * manual inventory will always miss something — this gate blocks it mechanically: views/components must not bypass the utils unified outlets to mutate task data directly.
 *
 * Three-layer rule (see sop/ and the utils/confirm.js header comment for details):
 *   可逆操作 → moveWithUndo / batchMoveWithUndo / deleteWithUndo / toggleCompleteWithUndo / showUndoToast
 *   Irreversible operations → $confirm / openTomatoAbandon / askRepeatDelete
 *   Drag and drop → silent exemption (handler may only be triggered by dragging)
 *
 * 规则：
 *   R1a Completion must go through the unified outlet — any dispatch('todo/toggleComplete') in components|views fails
 *      (completion semantics include toast/announce/subtask linkage; completeAction.js is the single outlet).
 *   R1b Delete allowlist — dispatch('todo/deleteTodo') is reserved for specially approved files (batch/repeat-scope) that carry their own confirm+undo.
 *   R2 updateTodoFields is allowlist-based — any new file outside the allowlist fails; new files must first be mapped onto
 *      the three-layer rule before being allowlisted (each entry carries a semantic comment).
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SCAN_DIRS = ['renderer/js/components', 'renderer/js/views']

// R1b: files allowed to dispatch todo/deleteTodo directly (each documents its confirm+undo coverage)
const DELETE_ALLOWLIST = [
  'TodoBoxView.vue', // batch delete: $confirm + snapshot ids + batch restore undo
  'RepeatDeleteModal.vue', // repeat-task scope dialog (this one / whole series): the dialog itself is the confirm box + 5s undo
]

// R2: files allowed to dispatch todo/updateTodoFields directly (each entry documents why it
// qualifies under the three-layer rule; new files must go through the same review, not copy-paste)
const UPDATE_FIELDS_ALLOWLIST = [
  'DepView.vue', // dependency linking (moveWithUndo undo exit; the edge is drawn by dragging one card onto another)
  'SnManageCategoriesModal.vue', // manage-categories dialog: rename/limit edits (dialog has confirm flows for destructive ops)
  'SnManageTagsModal.vue', // manage-tags dialog: rename/delete rewrites #tags with confirm flows
  'TodoItem.vue', // drag across days (hand-written undo toast) + subtask check persistence (inline visible state)
  'MatrixGrid.vue', // four-quadrant drag to swap cells (drag exemption)
  'DayDeck.vue', // card-stack drag to change day (moveWithUndo)
  'CalendarView.vue', // event drag / page-flip compensation / time-block drag (all moveWithUndo or drag exemption + toast)
  'EditPanel.vue', // edit panel autosave (queued debounce, save echoes back)
  'RecycleBinView.vue', // recycle-bin restore (restore is itself an undo of delete, with success toast)
  'TodoBoxView.vue', // batch move-to-today / recategorize (batchMoveWithUndo) + restore (confirm-box context)
  'SideNav.vue', // category delete with batch detachment / tag rename-delete (all backed by $confirm)
  'RepeatDeleteModal.vue', // repeat-task scope confirm dialog (the dialog is the confirm box, with undo)
  'CategoryView.vue', // expired move-to-today (rescheduleExpired+batchMoveWithUndo; only the revertOf callback here)
  'TagView.vue', // same as CategoryView (only the revertOf callback)
  'ProjectView.vue', // same as CategoryView (only the revertOf callback)
]

const hits = []
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) continue
  const walkSfc = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walkSfc(p, out)
      else if (name.endsWith('.js') || name.endsWith('.vue')) out.push({ dir, name, p })
    }
    return out
  }
  for (const { dir: d0, name, p } of walkSfc(abs)) {
    const rel = d0 === dir ? dir + '/' + name : dir + '/' + path.relative(abs, p).split(path.sep).join('/')
    const src = fs.readFileSync(p, 'utf8')
    // R1a: completion must go through toggleCompleteWithUndo (zero tolerance)
    if (/dispatch\(\s*['"]todo\/toggleComplete['"]/.test(src)) {
      hits.push(`${rel}  [R1a 完成绕过统一出口 → toggleCompleteWithUndo(completeAction.js)]`)
    }
    // R1b: delete allowlist
    if (/dispatch\(\s*['"]todo\/deleteTodo['"]/.test(src) && !DELETE_ALLOWLIST.includes(name)) {
      hits.push(`${rel}  [R1b 删除绕过统一出口 → deleteWithUndo(confirm.js),特批进 DELETE_ALLOWLIST]`)
    }
    // R2: updateTodoFields allowlist
    if (/dispatch\(\s*['"]todo\/updateTodoFields['"]/.test(src) && !UPDATE_FIELDS_ALLOWLIST.includes(name)) {
      hits.push(`${rel}  [R2 updateTodoFields 不在白名单 → 先对号三层规范(撤销出口/确认框/拖拽豁免),再进 check-op-feedback.js UPDATE_FIELDS_ALLOWLIST]`)
    }
  }
}

if (hits.length) {
  console.error('✗ 变更操作反馈一致性检查失败，' + hits.length + ' 处：')
  for (const h of hits) console.error('  ' + h)
  console.error('\n规范：可逆操作走 utils 撤销出口(confirm.js/completeAction.js/undoToast.js)；不可逆走确认框；拖拽豁免须 handler 仅由拖拽触发。')
  process.exit(1)
}
console.log('✓ 变更操作反馈一致性检查通过（R1 完成/删除统一出口 + R2 updateTodoFields 白名单）')
