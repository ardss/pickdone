/**
 * [maint-0924] renderer UX round — source anchors for the 16 findings (direction A).
 * Pure logic lives in utils/cross-day-move.test.mjs; this file locks the wiring in place.
 * Run: node --test tests/unit/renderer/maint-0924-ux.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('A1 TodoBoxView: batchToday builds per-row patches via the shared crossDayMovePatch', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  assert.match(src, /import \{ crossDayMovePatch, crossDayRevertPatch \} from '\.\.\/utils\/crossDayMove\.js'/)
  assert.match(src, /crossDayMovePatch\(raw, ts, startOf\)/, 'per-row patch through the shared builder')
  assert.ok(!/patch: \{ dayStart: ts, todoTime: ts \}/.test(src), 'hard todoTime=today-00:00 wipe stays deleted')
  assert.match(src, /crossDayRevertPatch\(raw, patch\)/, 'undo snapshot built from the same rules')
})

test('A2 DayDeck: onDrop shifts todoTime AND reminderTime via the shared patch builder', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /import \{ crossDayMovePatch, crossDayRevertPatch \} from '\.\.\/utils\/crossDayMove\.js'/)
  assert.match(src, /crossDayMovePatch\(t, ts, startOf\)/)
  assert.match(src, /crossDayRevertPatch\(t, patch\)/)
  assert.ok(!/patch\.todoTime = ts\b/.test(src), 'old day-anchored todoTime=ts hard write stays deleted')
})

test('A3 MatrixGrid: Ctrl+1..4 keyboard quadrant moves reuse the moveQuadrant moveWithUndo exit', () => {
  const src = read('renderer/js/components/MatrixGrid.vue')
  for (const n of [1, 2, 3, 4]) assert.match(src, new RegExp(`@keydown\\.ctrl\\.${n}\\.prevent="kbdQuadrant\\(t, ${n - 1}\\)"`))
  assert.match(src, /kbdQuadrant \(t, qi\) \{[\s\S]*?QUADRANTS\[qi\]/, 'kbd path resolves the same QUADRANTS table')
  assert.match(src, /dropOn \(q\) \{[\s\S]*?this\.moveQuadrant\(t, q\)/, 'drag path funnels into moveQuadrant')
  assert.match(src, /moveQuadrant \(t, q\) \{[\s\S]*?moveWithUndo\(this/, 'both paths share the moveWithUndo exit')
  assert.match(src, /aria-keyshortcuts="Control\+1 Control\+2 Control\+3 Control\+4"/, 'shortcuts announced to AT')
  assert.match(src, /kbdHint/, 'title carries the keyboard hint key')
})

test('A4 TodoItem: sort-blocked toast uses the dedicated sortIgnored key (not the pin copy)', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  assert.match(src, /statsH\.main\.sortIgnored/)
  assert.ok(!/pinIgnoredSort/.test(src), 'pin copy must not be reused for reordering')
  for (const loc of ['zh-CN-H.js', 'en-US-H.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /sortIgnored: /)
})

test('A5 TodoItem: subtask toggle announces the result to screen readers', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  assert.match(src, /toggleSub \(s\) \{[\s\S]*?\$announce\(this\.\$t\(s\.checked \? 'statsE\.TodoItem\.subCheckedAnnounce' : 'statsE\.TodoItem\.subUncheckedAnnounce'/)
  for (const loc of ['zh-CN-E.js', 'en-US-E.js']) {
    assert.match(read('renderer/js/i18n/locales/' + loc), /subCheckedAnnounce/)
    assert.match(read('renderer/js/i18n/locales/' + loc), /subUncheckedAnnounce/)
  }
})

test('A6 TodoBoxView: batchToday/batchCat guarded by batchBusy; busy disables the batch bar', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  assert.match(src, /batchBusy: false/, 'lock declared reactive')
  const todayFn = src.slice(src.indexOf('async batchToday ()'), src.indexOf('async batchCat ('))
  const catFn = src.slice(src.indexOf('async batchCat ('), src.indexOf('async batchDelete ('))
  for (const [name, fn] of [['batchToday', todayFn], ['batchCat', catFn]]) {
    assert.match(fn, /if \(this\.batchBusy\) return/, name + ' re-entrancy guard')
    assert.match(fn, /finally \{ this\.batchBusy = false \}/, name + ' always releases the lock')
  }
  const bar = src.slice(src.indexOf('class="tb-batch-bar"'), src.indexOf('</transition>'))
  const disabled = bar.match(/:disabled="batchBusy"/g) || []
  assert.ok(disabled.length >= 3, 'today / move-to-cat / delete buttons disabled while busy')
})

test('A7 EditPanel: Esc close returns focus like collapse()', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.match(src, /ui\/closeEditCleanup'\)[\s\S]{0,120}this\.refocusRow\(st\.taskId\)/, 'Esc path refocuses the edited row')
  const collapseFn = src.slice(src.indexOf('collapse () {'), src.indexOf('refocusRow (id)'))
  assert.match(collapseFn, /this\.refocusRow\(/, 'collapse() funnels through the same helper')
  assert.match(src, /refocusRow \(id\) \{[\s\S]*?findTaskRowEl\(id\)/, 'helper targets the task row (shared Vue2/Vue3-aware locator)')
})

test('A8 TodoBoxView: dd-menus handle ArrowUp/Down cycling and Escape close', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  const menus = src.match(/@keydown="ddMenuKey\(\$event, '(popSort|popOrder|popCat)'\)"/g) || []
  assert.equal(menus.length, 3, 'all three dd-menus wired')
  const fn = src.slice(src.indexOf('ddMenuKey (e, popRef)'), src.indexOf('estOf (t)'))
  assert.match(fn, /ArrowDown/, 'arrow-down cycling')
  assert.match(fn, /ArrowUp/, 'arrow-up cycling')
  assert.match(fn, /Escape/, 'escape closes')
  assert.match(fn, /typeof pop\.hide === 'function'/, 'popover hidden via its own API')
  assert.match(fn, /dropdown-select__label/, 'focus returned to the trigger')
})

test('A9 tomato: phase flips announce; TomatoBar status region is a live region', () => {
  const storeSrc = read('renderer/js/store/tomato.js')
  assert.match(storeSrc, /announceUi\('statsH\.tomato\.focusToRestAnnounce', \{ n: s\.restTime \}\)/, 'focus done -> rest N minutes')
  assert.match(storeSrc, /announceUi\('statsH\.tomato\.restOverAnnounce'\)/, 'rest over -> ready')
  const barSrc = read('renderer/js/components/TomatoBar.vue')
  assert.match(barSrc, /class="tomato-timer__status" aria-live="polite"/)
  for (const loc of ['zh-CN-H.js', 'en-US-H.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /focusToRestAnnounce/)
})

test('A10 ProjectView: deadline prompt validates the date live under the input', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  assert.match(src, /inputValidator: v => \(parseMilestoneDate\(v\) \? true : this\.\$t\('statsB\.ProjectView\.badDate'\)\)/)
  assert.match(src, /statsB\.ProjectView\.dateFmtHint/, 'format hint appended to the prompt body')
  for (const loc of ['zh-CN-B.js', 'en-US-B.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /dateFmtHint/)
})

test('A11 HabitView: empty rename warns and stays in edit mode', () => {
  const src = read('renderer/js/views/HabitView.vue')
  const fn = src.slice(src.indexOf('saveRename (h) {'), src.indexOf('// Check-in is a one-click'))
  assert.match(fn, /if \(!n\) \{ this\.\$message\.warning\(this\.\$t\('statsE\.HabitView\.renameEmpty'\)\); return \}/)
  assert.ok(fn.indexOf('this.editingId = null') > fn.indexOf('if (!n)'), 'early return keeps editingId (editor stays open)')
  for (const loc of ['zh-CN-E.js', 'en-US-E.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /renameEmpty/)
})

test('A12 HabitView: habit/moment creation gives success feedback', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.match(src, /addedToast/, 'habit created toast key referenced')
  assert.match(src, /momentAddedToast/, 'moment added toast key referenced')
  for (const loc of ['zh-CN-B.js', 'en-US-B.js']) {
    assert.match(read('renderer/js/i18n/locales/' + loc), /addedToast/)
    assert.match(read('renderer/js/i18n/locales/' + loc), /momentAddedToast/)
  }
})

test('A13 ProjectView: reschedule with nothing overdue says so', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  assert.match(src, /this\.\$message\.info\(this\.\$t\('statsB\.ProjectView\.noOverdue'\)\)/)
  for (const loc of ['zh-CN-B.js', 'en-US-B.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /noOverdue/)
})

test('A14 DayDeck: local day flips announce the new center day', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /deckDayAnnounce/, 'announce key referenced')
  assert.match(src, /_flipLocal = true/, 'local flips (arrows/swipe/side-card) marked')
  const watcher = src.slice(src.indexOf('front (idx) {'), src.indexOf("'$store.state.ui.daySelectedTs'"))
  assert.match(watcher, /_flipLocal/, 'watcher announces only local flips')
  for (const loc of ['zh-CN-E.js', 'en-US-E.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /deckDayAnnounce/)
})

test('A15 TodoItem: row demoted to focusable container; title carries role=button', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const head = src.slice(src.indexOf('<div class="td-item"'), src.indexOf('<span class="td-check"'))
  assert.doesNotMatch(head, /role="button"/, 'row must not re-advertise role=button')
  assert.match(head, /tabindex="0"/, 'row stays focusable for the shortcut keys')
  const body = src.slice(src.indexOf('<div class="td-body"'), src.indexOf('<div class="td-meta"'))
  assert.match(body, /class="td-title"[^>]*role="button"/)
  assert.match(body, /:aria-label="\$t\('statsE\.TodoItem\.openTaskAria'/)
})

test('A16 TodoBoxView: batch selection count is a polite live region', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  assert.match(src, /<span aria-live="polite">\{\{ \$t\('statsC\.TodoBox\.selectedCount'/)
})
