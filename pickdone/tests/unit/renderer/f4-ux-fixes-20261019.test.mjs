/**
 * F4 ux-fix batch (2026-10-19) — regression tests, source-contract style (same seam as the
 * d-wave / f3 series; behavior tests where the module imports cleanly under Node).
 *
 * Covered:
 *   F4-1  layout.vue: a $route watcher zeroes the persistent .main-scroll scrollTop (per-view
 *         scroll no longer inherits across route switches).
 *   F4-2  CompletedView: group fold state persists through the shared settings ledger
 *         (foldedTodoList, same store path TodoGroups uses) instead of component-local data.
 *   F4-3  CompletedView: the non-scoped global `.todo-box-list-item__tools{opacity:1}` leak is
 *         gone while the .row-btn hover/focus reveal rules stay.
 *   F4-4  TodoBoxView: the .btn--dark variants get an html[data-theme="dark"] override.
 *   F4-5  TodoGroupBlock: the .--color3 title gets an html[data-theme="dark"] override.
 *   F4-6  DepView: the grip reveals on .depv-task:focus-within (keyboard parity with hover).
 *   F4-7  QuickAdd placeholder hints the core input syntax in both locales ("任务"/task, not 事件).
 *   F4-8  FeedbackModal: submit() resets submitting in a finally block (failure path un-sticks
 *         the button).
 *   F4-9  completeAction: undo has an in-flight re-entry guard (behavior test with a fake store).
 *   F4-10 QuickAdd createLines snapshots effDate before the loop (payload + toast same snapshot).
 *   F4-11 DayRail: the data() localStorage read is try-wrapped (default false);
 *         store/index.js: onboardingToursSeen LS parse has its own try with a corrupt-value
 *         reset to {} (merge no longer permanently skipped on bad JSON).
 *
 * Run: node --test tests/unit/renderer/f4-ux-fixes-20261019.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const LAYOUT = read('renderer/js/layout.vue')
const COMPLETED = read('renderer/js/views/CompletedView.vue')
const TODOBOX = read('renderer/js/views/TodoBoxView.vue')
const GROUPBLOCK = read('renderer/js/components/TodoGroupBlock.vue')
const DEPVIEW = read('renderer/js/components/DepView.vue')
const QUICKADD = read('renderer/js/components/QuickAdd.vue')
const FEEDBACK = read('renderer/js/components/FeedbackModal.vue')
const DAYRAIL = read('renderer/js/components/DayRail.vue')
const STORE_INDEX = read('renderer/js/store/index.js')
const ZH_D = read('renderer/js/i18n/locales/zh-CN-D.js')
const EN_D = read('renderer/js/i18n/locales/en-US-D.js')

test('F4-1 layout.vue zeroes .main-scroll scrollTop on route change', () => {
  const watch = LAYOUT.slice(LAYOUT.indexOf('watch: {'))
  assert.match(watch, /\$route \(\)/, 'watcher on $route missing')
  assert.match(watch, /\.main-scroll/, 'watches the persistent scroll container')
  assert.match(watch, /scrollTop = 0/, 'resets scrollTop')
})

test('F4-2 CompletedView folds persist via settings.foldedTodoList', () => {
  assert.match(COMPLETED, /\$store\.state\.settings\.foldedTodoList/, 'reads the shared settings ledger')
  assert.match(COMPLETED, /commit\('settings\/updateSettings', \{ foldedTodoList/, 'writes through the shared settings commit')
  assert.ok(!COMPLETED.includes('this.collapsedMap') && !/collapsedMap\s*:/.test(COMPLETED), 'component-local collapsedMap data is gone')
})

test('F4-3 CompletedView leaks no global tools selector, keeps row-btn reveals', () => {
  assert.ok(!/__tools\{opacity:1\}/.test(COMPLETED), 'global leak selector must be gone')
  assert.match(COMPLETED, /\.done-row-orig:hover \.row-btn\{opacity:1\}/, 'hover reveal kept')
  assert.match(COMPLETED, /\.done-row-orig:focus-within \.row-btn\{opacity:1\}/, 'focus-within reveal kept')
})

test('F4-4 TodoBoxView .btn--dark has dark-theme overrides', () => {
  assert.match(TODOBOX, /html\[data-theme="dark"\] \.todo-box-list \.todo-box-list-item__tools \.btn--dark\{color:var\(--text-2\)\}/)
  assert.match(TODOBOX, /html\[data-theme="dark"\] \.todo-box-list \.todo-box-list-item__tools \.btn--dark:hover\{color:var\(--text-1\)\}/)
})

test('F4-5 TodoGroupBlock .--color3 has a dark-theme override', () => {
  assert.match(GROUPBLOCK, /html\[data-theme="dark"\] \.todo-list-item-group--color3 \.todo-list-item-group__title\{color:var\(--text-2\)\}/)
})

test('F4-6 DepView grip reveals on focus-within', () => {
  assert.match(DEPVIEW, /\.depv-task:focus-within \.depv-task__grip \{ opacity: 1; \}/)
})

test('F4-7 QuickAdd placeholder hints the input syntax in both locales', () => {
  const zh = ZH_D.match(/"placeholder": "([^"]+)"/)
  const en = EN_D.match(/"placeholder": "([^"]+)"/)
  assert.ok(zh, 'zh placeholder key present')
  assert.match(zh[1], /试试「明天下午3点 交报告 #工作」/, 'zh hints date + content + tag syntax')
  assert.ok(!zh[1].includes('事件'), 'zh no longer misuses 事件')
  assert.ok(en, 'en placeholder key present')
  assert.ok(EN_D.includes('tomorrow 3pm send report #work'), 'en hints the syntax example')
})

test('F4-8 FeedbackModal submit resets the submitting flag in finally', () => {
  const submit = FEEDBACK.slice(FEEDBACK.indexOf('async submit ()'), FEEDBACK.indexOf('async submit ()') + 2600)
  assert.match(submit, /finally \{\s*[\s\S]*?this\.submitting = false/, 'finally resets submitting')
})

test('F4-9 completeAction undo has a re-entry guard (behavior)', async () => {
  await import('../../setup.mjs')
  const { toggleCompleteWithUndo } = await import('../../../renderer/js/utils/completeAction.js')
  globalThis.window.Vue = { h: (t, p, c) => ({ t, p, c: Array.isArray(p) ? p : c }) }
  // undoToast.js installs hover-pause key listeners on document — shim it (removed below)
  const docShim = { addEventListener () {}, removeEventListener () {} }
  const hadDoc = globalThis.document !== undefined
  const prevDoc = globalThis.document
  globalThis.document = docShim

  const todo = { taskId: 'u1', complete: true, taskContent: 'guard me' }
  let gate
  const undoDispatches = []
  const store = {
    state: { todo: { todoList: [todo], recycleList: [] } },
    dispatch (type, t) {
      // J17 (journey-audit round 2) re-aimed the undo dispatch from todo/toggleComplete to the
      // todo/updateTodoFields snapshot revert — count the dispatch type the undo actually sends.
      if (type === 'todo/updateTodoFields') undoDispatches.push(t)
      if (undoDispatches.length === 1) {
        // first undo stays in flight until we release it
        return new Promise(res => { gate = res })
      }
      return Promise.resolve({})
    }
  }
  const toasts = []
  const message = m => { toasts.push(m) }
  message.closeAll = () => {}

  toggleCompleteWithUndo({ store, message, todo })
  undoDispatches.length = 0 // drop the INITIAL completion dispatch; count undo dispatches only
  // showUndoToast wraps the children in h('span', children): [text, undoVnode]
  const toastChildren = toasts[0].message.c
  const undoFn = toastChildren[1].p.onClick

  undoFn()
  undoFn() // double-click while the first dispatch is in flight — must be ignored
  assert.equal(undoDispatches.length, 1, 're-entrant click while in flight is dropped')
  gate({})
  await new Promise(r => setTimeout(r, 0))
  undoFn() // after settle, a genuine second revert goes through
  await new Promise(r => setTimeout(r, 0))
  assert.equal(undoDispatches.length, 2, 'post-settle click dispatches again')
  if (hadDoc) globalThis.document = prevDoc; else delete globalThis.document
})

test('F4-10 QuickAdd createLines snapshots the date before the loop', () => {
  const start = QUICKADD.indexOf('async createLines')
  const fn = QUICKADD.slice(start, QUICKADD.indexOf('} catch (err) {', start))
  // [w21] the snapshot is the MANUAL chip (pickedDate), not effDate: effDate folds in the
  // draft's NL-parsed date, and pasted lines never inherit NL parsing (createLines contract)
  assert.match(fn, /const effDate = this\.pickedDate/, 'pre-loop snapshot exists (manual chip only)')
  const afterSnap = fn.slice(fn.indexOf('const effDate = this.pickedDate') + 'const effDate = this.pickedDate'.length)
  assert.match(fn, /pickedDate: effDate/, 'payload uses the snapshot')
  assert.match(fn, /let d = effDate/, 'toast reports the same snapshot')
  assert.ok(!/this\.effDate/.test(afterSnap), 'no live re-reads after the snapshot')
  assert.ok(!/this\.effDate/.test(fn), 'pasted lines never touch effDate (no NL-date leak)')
})

test('F4-11a DayRail wraps the data() LS read in try', () => {
  // method-form data() with a try-wrapped LS read (the IIFE arrow shape broke the structure
  // gate's declared-identifier parser — focusInputMax read as an undeclared template binding)
  assert.match(DAYRAIL, /let rc = false; try \{ rc = localStorage\.getItem\('dayRailCollapsed'\) === '1' \} catch \(e\)/)
})

test('F4-11b store/index.js parses the tours LS with its own try + corrupt reset', () => {
  assert.match(STORE_INDEX, /let cur = \{\}/, 'parse lives in its own try with a reset default')
  assert.match(STORE_INDEX, /catch \(e\) \{ cur = \{\} \}/, 'bad JSON resets to {} instead of skipping the merge forever')
  // the merge loop and the LS write must sit in a SECOND try separate from the parse
  const seg = STORE_INDEX.slice(STORE_INDEX.indexOf('let cur = {}'), STORE_INDEX.indexOf('wave2 P2: restore'))
  assert.equal((seg.match(/try \{/g) || []).length, 2, 'two isolated try blocks (parse / merge+write)')
})
