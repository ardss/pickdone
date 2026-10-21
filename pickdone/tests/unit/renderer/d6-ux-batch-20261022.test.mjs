/**
 * D6 ux-fix batch (2026-10-22) — regression tests (source-contract anchors + scheduler
 * behavior, same seam as the d5/d10/f5 series).
 *
 * Covered:
 *   D6-1  [P2] notification click locates the task: fire()'s click handler passes todo.taskId
 *         into focusMainFromNotification, which after the lock-aware focus pushes
 *         'reminder-open-task' {taskId} to the main window (behavior-tested via a fake
 *         window-ref target); preload wraps the channel with the standard disposer contract
 *         (onReminderOpenTask); the renderer (Onboarding.vue, mounted with the main shell
 *         layout) routes dated → todo-list-today / undated → todo-list-todo-box and opens
 *         ui/openEdit, ignoring the push while ui.isLocked.
 *   D6-2  [P3] taskMenu: the pomodoro item uses 'timer' — it shared 'clock' with
 *         postpone-to-tomorrow (two different actions, one glyph).
 *   D6-3  [P3] EpSubtasks rename text carries the dblclick-rename tooltip via a NEW
 *         statsJ.EditPanel.dblclickRenameTip key (zh+en paired; the existing key lives in
 *         statsG.SideNav — cross-shard borrowing is not this file's convention).
 *   D6-4  [P3] TodoItem.onDragStart: non-custom sort sets dropEffect='none', raises the
 *         dragSortBlocked flag and toasts sortIgnored ONCE at drag start; onDragOver offers
 *         no move affordance and _writeSort suppresses the drop-time duplicate toast;
 *         onDragEnd always resets the flag.
 *   D6-5  [P3] SearchView empty state: #action button runs clearAndRescan = resetFilter +
 *         clearQ + input refocus; key statsC.Search.clearAndRescan in both shards.
 *   D6-6  [P3] Onboarding Esc: step>0 steps back; step 0 confirms (escSkipConfirm) before
 *         finish — no more silent skip of the whole wizard.
 *   D6-7  [P3] TodoBoxView genuinely-empty state (not the initError state): #action button
 *         summons QuickAdd via the todo:focus-quickadd channel; key statsC.TodoBox.emptyCreate.
 *
 * Run: node --test tests/unit/renderer/d6-ux-batch-20261022.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const SCHEDULER = read('src/main/scheduler.js')
const PRELOAD = read('src/preload/index.js')
const TASKMENU = read('renderer/js/utils/taskMenu.js')
const EPSUB = read('renderer/js/components/edit-panel/EpSubtasks.vue')
const TODOITEM = read('renderer/js/components/TodoItem.vue')
const SEARCH = read('renderer/js/views/SearchView.vue')
const ONBOARD = read('renderer/js/components/Onboarding.vue')
const TODOBOX = read('renderer/js/views/TodoBoxView.vue')
const EN_J = read('renderer/js/i18n/locales/en-US-J.js')
const ZH_J = read('renderer/js/i18n/locales/zh-CN-J.js')
const EN_C = read('renderer/js/i18n/locales/en-US-C.js')
const ZH_C = read('renderer/js/i18n/locales/zh-CN-C.js')
const EN_N = read('renderer/js/i18n/locales/en-US-N.js')
const ZH_N = read('renderer/js/i18n/locales/zh-CN-N.js')

test('D6-1 fire() click handler passes todo.taskId; focusMainFromNotification forwards it', () => {
  assert.match(SCHEDULER, /n\.on\('click', \(\) => \{[\s\S]*?focusMainFromNotification\(todo\.taskId\)/,
    'notification click must carry the taskId')
  assert.match(SCHEDULER, /function focusMainFromNotification \(taskId\)/)
  assert.match(SCHEDULER, /pushOpenTask\(taskId\)/)
})

test('D6-1 focusMainFromNotification(taskId) pushes reminder-open-task to the live main window', () => {
  const require = createRequire(import.meta.url)
  const windowRef = require('../../../src/main/window-ref.js')
  const scheduler = require('../../../src/main/scheduler.js')
  const sent = []
  const fakeWin = { isDestroyed: () => false, show () {}, focus () {}, webContents: { send: (ch, p) => sent.push([ch, p]) } }
  try {
    windowRef.setMainWindow(fakeWin)
    scheduler.focusMainFromNotification('task-abc')
    assert.deepEqual(sent, [['reminder-open-task', { taskId: 'task-abc' }]], 'push carries the taskId')
    // no taskId (legacy callers) → focus only, no push
    sent.length = 0
    scheduler.focusMainFromNotification()
    assert.deepEqual(sent, [])
    // destroyed window → no push, no throw
    sent.length = 0
    windowRef.setMainWindow({ isDestroyed: () => true, show () {}, focus () {}, webContents: { send: () => sent.push('x') } })
    assert.doesNotThrow(() => scheduler.focusMainFromNotification('task-abc'))
    assert.deepEqual(sent, [])
  } finally {
    windowRef.setMainWindow(null)
  }
})

test('D6-1 preload wraps reminder-open-task with the standard disposer contract; renderer routes + lock-guard', () => {
  assert.match(PRELOAD, /onReminderOpenTask: fn => \{[\s\S]*?ipcRenderer\.on\('reminder-open-task', h\)[\s\S]*?return \(\) => ipcRenderer\.removeListener\('reminder-open-task', h\)/,
    'same wrapper/disposer shape as onShortcutConflict')
  assert.match(ONBOARD, /onReminderOpenTask/, 'renderer subscribes (Onboarding mounts with the main shell layout)')
  const locate = ONBOARD.slice(ONBOARD.indexOf('locateFromNotification'), ONBOARD.indexOf('onEsc ()'))
  assert.match(locate, /if \(st\.ui\.isLocked\) return/, 'locked app: the push must not reveal data')
  assert.match(locate, /todo\.todoList\.find\(x => x\.taskId === taskId\)/)
  assert.match(locate, /t\.dayStart \? 'todo-list-today' : 'todo-list-todo-box'/)
  assert.match(locate, /commit\('ui\/openEdit', t\)/)
})

test("D6-2 taskMenu pomodoro item uses 'timer' (no longer shares 'clock' with postpone)", () => {
  const tomato = TASKMENU.slice(TASKMENU.indexOf('c.tomato && !t.complete'), TASKMENU.indexOf('if (c.tomato) {'))
  assert.match(tomato, /icon: 'timer'/, "pomodoro focus icon must be 'timer'")
  assert.ok(!/icon: 'clock'/.test(tomato), "pomodoro focus must not reuse 'clock'")
  // postpone keeps its clock icon
  assert.match(TASKMENU, /icon: 'clock', label: vm\.\$t\('statsE\.TodoItem\.postponeToTomorrow'\)/)
  // backfill moved off 'timer' to 'plus' (pomodoro owns the glyph; old store-fixes anchors updated)
  assert.match(TASKMENU, /icon: 'plus',\r?\n {6}label: vm\.\$t\('statsG\.DayRail\.manualAdd'\)/)
  assert.equal((TASKMENU.match(/icon: 'timer'/g) || []).length, 1, "exactly one 'timer' item in the menu")
})

test('D6-3 EpSubtasks rename text carries the tooltip; statsJ.EditPanel.dblclickRenameTip in both shards', () => {
  assert.match(EPSUB, /:title="\$t\('statsJ\.EditPanel\.dblclickRenameTip'\)"/)
  assert.match(ZH_J, /'statsJ\.EditPanel\.dblclickRenameTip': '双击可重命名'/)
  assert.match(EN_J, /'statsJ\.EditPanel\.dblclickRenameTip': 'Double-click to rename'/)
})

test('D6-4 TodoItem dragstart announces the non-custom-sort ignore once; drop-time duplicate suppressed', () => {
  const dragstart = TODOITEM.slice(TODOITEM.indexOf('onDragStart (e) {'), TODOITEM.indexOf('onDragOver (e) {'))
  assert.match(dragstart, /normalizeSortMode\(this\.\$store\.state\.settings\.sortMode\) !== 'custom'/)
  assert.match(dragstart, /e\.dataTransfer\.dropEffect = 'none'/, 'drag START signals a non-reorderable drag')
  assert.match(dragstart, /dragSortBlocked = true/)
  assert.match(dragstart, /statsH\.main\.sortIgnored/, 'toast fires once at dragstart, reusing the existing key')
  // dragover offers no move affordance while blocked
  const dragover = TODOITEM.slice(TODOITEM.indexOf('onDragOver (e) {'), TODOITEM.indexOf('onDragLeave ('))
  assert.match(dragover, /if \(dragSortBlocked\) \{ e\.dataTransfer\.dropEffect = 'none'; return \}/)
  // _writeSort suppresses the drop-time duplicate; keyboard path still announces
  const writeSort = TODOITEM.slice(TODOITEM.indexOf('_writeSort (list) {'), TODOITEM.indexOf('keyboardMove (dir)'))
  assert.match(writeSort, /if \(!dragSortBlocked && this\.\$message\)/)
  // flag always resets at dragend (fires after drop too)
  assert.match(TODOITEM, /onDragEnd \(\) \{[^\n]*dragSortBlocked = false \}/)
})

test('D6-5 SearchView empty state offers clear-and-rescan (filters + keyword, then refocus)', () => {
  assert.match(SEARCH, /<template #action><button type="button" class="mini primary" @click="clearAndRescan">\{\{ \$t\('statsC\.Search\.clearAndRescan'\) \}\}<\/button><\/template>/)
  const fn = SEARCH.slice(SEARCH.indexOf('clearAndRescan () {'))
  assert.match(fn, /this\.resetFilter\(\)/)
  assert.match(fn, /this\.clearQ\(\)/)
  assert.match(fn, /\$refs\.inp && this\.\$refs\.inp\.focus\(\)/)
  assert.match(ZH_C, /clearAndRescan: '清除筛选并重搜'/)
  assert.match(EN_C, /clearAndRescan: 'Clear filters and search again'/)
})

test('D6-6 Onboarding Esc steps back mid-wizard; step 0 confirms before skipping', () => {
  assert.ok(!/@keydown\.esc="finish"/.test(ONBOARD), 'Esc must no longer silently finish the wizard')
  assert.match(ONBOARD, /@keydown\.esc="onEsc"/)
  const onEsc = ONBOARD.slice(ONBOARD.indexOf('onEsc () {'), ONBOARD.indexOf('pickLocale ('))
  assert.match(onEsc, /if \(this\.step > 0\) \{ this\.prev\(\); return \}/)
  assert.match(onEsc, /this\.\$confirm\(this\.\$t\('onboarding\.escSkipConfirm'\)/)
  assert.match(onEsc, /\.then\(\(\) => this\.finish\(\)\)\.catch\(\(\) => \{\}\)/)
  assert.match(ZH_N, /escSkipConfirm: '跳过初始设置？未完成的选项将保持默认'/)
  assert.match(EN_N, /escSkipConfirm: 'Skip initial setup\? Unfinished choices keep their defaults'/)
})

test('D6-7 TodoBox genuinely-empty state offers the QuickAdd create entry (error state keeps retry)', () => {
  assert.match(TODOBOX, /<template v-if="initError" #action><button type="button" class="mini primary" @click="retryInit">/)
  assert.match(TODOBOX, /<template v-else #action><button type="button" class="mini primary" @click="openQuickAdd">\{\{ \$t\('statsC\.TodoBox\.emptyCreate'\) \}\}<\/button><\/template>/)
  const fn = TODOBOX.slice(TODOBOX.indexOf('openQuickAdd () {'))
  assert.match(fn, /document\.querySelector\('\.qa-wrap'\)/)
  assert.match(fn, /new CustomEvent\('todo:focus-quickadd'\)/, 'same summon channel as main.js focusQuickAdd')
  assert.match(fn, /router\.push\(\{ name: 'todo-list-today' \}\)/, 'fallback route when the bar is not mounted')
  assert.match(ZH_C, /emptyCreate: '去新建任务'/)
  assert.match(EN_C, /emptyCreate: 'Create a task'/)
})
