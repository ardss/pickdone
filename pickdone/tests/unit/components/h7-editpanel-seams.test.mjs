/**
 * H7 EditPanel family seam fixes — regression tests (node:test, no Vue mount).
 * Round 7 A2 seam sweep after the S4 split: EpReminders reset-on-task-switch +
 * undo guards, EpSubtasks stable row keys, EpDependencies popover persistence +
 * ARIA, EditPanel Esc priority order.
 *
 * Run: node --test tests/unit/components/h7-editpanel-seams.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const PARENT = read('renderer/js/components/EditPanel.vue')
const REMINDERS = read('renderer/js/components/edit-panel/EpReminders.vue')
const SUBTASKS = read('renderer/js/components/edit-panel/EpSubtasks.vue')
const DEPS = read('renderer/js/components/edit-panel/EpDependencies.vue')

/** Extract the "[h7-fixes] pure-start ... pure-end" block from a source file and evaluate it. */
function extractPure (src, file) {
  const s = src.indexOf('[h7-fixes] pure-start')
  assert.ok(s >= 0, `pure block not found in ${file}`)
  const codeStart = src.indexOf('*/', s) + 2
  const codeEnd = src.indexOf('[h7-fixes] pure-end')
  const exports = {}
  // eslint-disable-next-line no-new-func
  new Function('exports', src.slice(codeStart, codeEnd) + '\nObject.assign(exports, { clampInsertIndex, sameTask })')(exports)
  return exports
}

/* ---------------- 1. [P1] EpReminders resets on cross-task switch ---------------- */

test('h7: EpReminders has a reset() that collapses the popover and clears rows', () => {
  assert.match(REMINDERS, /reset \(\) \{[\s\S]*?this\.remindOpen = false[\s\S]*?this\.remindRows = \[\]/)
})

test('h7: EpReminders watches task.taskId to trigger the reset (panel stays open across hydrate)', () => {
  assert.match(REMINDERS, /watch: \{[\s\S]*?'task\.taskId' \(\) \{ this\.reset\(\) \}/)
})

test('h7: EditPanel hydrate() replaces the task object (so the child watcher fires on switch)', () => {
  assert.match(PARENT, /this\.e = JSON\.parse\(JSON\.stringify\(s\)\)/)
})

/* ---------------- 2. [P2] undo must not cross tasks ---------------- */

test('h7: pure helpers — sameTask rejects empty/changed task ids', () => {
  const { sameTask } = extractPure(REMINDERS, 'EpReminders.vue')
  assert.equal(sameTask('t1', 't1'), true)
  assert.equal(sameTask('t2', 't1'), false)
  assert.equal(sameTask(null, 't1'), false)
  assert.equal(sameTask(undefined, 't1'), false)
})

test('h7: EpReminders.removeRemindRow undo captures the taskId and bails on mismatch', () => {
  assert.match(REMINDERS, /removeRemindRow \(i\) \{[\s\S]*?const tid = this\.task && this\.task\.taskId/)
  const undo = REMINDERS.slice(REMINDERS.indexOf('removeRemindRow'))
  assert.match(undo, /if \(!sameTask\(this\.task && this\.task\.taskId, tid\)\) return/)
})

/* ---------------- 3. [P2] undo re-insert uses a clamped index ---------------- */

test('h7: pure helpers — clampInsertIndex keeps the re-insert inside the current list', () => {
  const { clampInsertIndex } = extractPure(REMINDERS, 'EpReminders.vue')
  assert.equal(clampInsertIndex(3, 1), 1)
  assert.equal(clampInsertIndex(1, 5), 1) // captured index beyond current length
  assert.equal(clampInsertIndex(2, -1), 0)
  assert.equal(clampInsertIndex(0, 0), 0)
})

test('h7: EpReminders.removeRemindRow undo splices with the clamped index, not the stale one', () => {
  const undo = REMINDERS.slice(REMINDERS.indexOf('removeRemindRow'))
  assert.match(undo, /splice\(clampInsertIndex\(this\.remindRows\.length, i\), 0, row\)/)
  assert.doesNotMatch(undo, /splice\(i, 0, row\)/)
})

/* ---------------- 4. [P2] EpSubtasks stable row keys ---------------- */

test('h7: EpSubtasks rows key off the stable _key (index only as legacy fallback), not bare :key="i"', () => {
  assert.match(SUBTASKS, /:key="s\._key != null \? s\._key : s\.text \+ '_' \+ i"/)
  assert.doesNotMatch(SUBTASKS, /:key="i"/)
})

test('h7: EditPanel mints _key on hydrate and addSub; serializes subtasks with _key stripped', () => {
  assert.match(PARENT, /for \(const sub of this\.subList\) \{ if \(sub && sub\._key == null\) sub\._key = \+\+this\._subKeySeq \}/)
  assert.match(PARENT, /this\.subList\.push\(\{ text, checked: false, _key: \+\+this\._subKeySeq \}\)/)
  // _key is render-only: it must never leak into the persisted subtasks JSON
  assert.match(PARENT, /subtasks: JSON\.stringify\(this\.subList\.map\(\(\{ _key, \.\.\.rest \}\) => rest\)\)/)
})

/* ---------------- 5. [P2] EpDependencies stays expanded after addPred ---------------- */

test('h7: addPred no longer force-collapses the popover (symmetric with rmPred)', () => {
  const addPred = DEPS.slice(DEPS.indexOf('addPred (id)'), DEPS.indexOf('rmPred (id)'))
  assert.ok(!addPred.includes('this.depOpen = false'), 'addPred must not close the popover')
})

test('h7: rmPred also keeps the popover open (multi-select symmetry)', () => {
  const rmPred = DEPS.slice(DEPS.indexOf('rmPred (id)'))
  assert.ok(!rmPred.includes('this.depOpen = false'), 'rmPred must not close the popover')
})

/* ---------------- 6. [P2] EpDependencies ARIA: group, not listbox/option ---------------- */

test('h7: deps popover is a group; rows no longer masquerade as listbox options', () => {
  assert.match(DEPS, /class="ep-cat-pop" role="group"/)
  assert.doesNotMatch(DEPS, /role="listbox"/)
  assert.doesNotMatch(DEPS, /role="option"/)
  // candidate rows stay keyboard-operable as buttons
  assert.match(DEPS, /class="ep-cat-opt" role="button"/)
})

/* ---------------- 7. [P2] EditPanel Esc priority: inner popovers -> preview -> panel ---------------- */

test('h7: Esc closes the inner popovers first, then the image preview, then the panel', () => {
  const handler = PARENT.slice(PARENT.indexOf("this._onKeydown = (e) =>"), PARENT.indexOf("window.addEventListener('keydown', this._onKeydown)"))
  const idxCat = handler.indexOf('this.catOpen = false')
  const idxRemind = handler.indexOf('remindOpen = false')
  const idxDep = handler.indexOf('depOpen = false')
  const idxPreview = handler.indexOf('this.previewImg = null')
  const idxPanel = handler.indexOf("commit('ui/closeEdit')")
  for (const [name, idx] of [['catOpen', idxCat], ['remindOpen', idxRemind], ['depOpen', idxDep]]) {
    assert.ok(idx >= 0, `Esc handler must close ${name}`)
    assert.ok(idx < idxPreview, `${name} must close before the image preview`)
  }
  assert.ok(idxCat < idxRemind && idxRemind < idxDep, 'inner popovers checked before the preview')
  assert.ok(idxPreview >= 0 && idxPreview < idxPanel, 'preview closes before the panel')
})

test('h7: EditPanel holds refs for the reminder/dependency children (Esc + future ref control)', () => {
  assert.match(PARENT, /<ep-reminders ref="remindBlock"/)
  assert.match(PARENT, /<ep-dependencies ref="depBlock"/)
})
