/**
 * D17-DOM4 renderer fixes — regression guards (source-anchor + extracted-behavior idiom).
 * Fixes covered:
 *   [F1] TodoGroups prune grace follows settings.expiredUncompletedTodoRange (was a fixed 7d
 *        that killed the collapse toggles of 8-30-day-old expired groups; mounted behavior
 *        tests live in tests/unit/components/todogroups-fold-behavior.test.mjs)
 *   [F2] CalendarView createAt + container keydown addTodo carry a .catch error toast (tbCreate pattern)
 *   [F3] TodoBoxView "?" tip popover: click trigger + focusable reference (was hover-only)
 *   [F4] moveDay/postpone toast announces the real destination date (movedTo with {d})
 *   [F5] Space activation: TodoGroups/CompletedView group headers, DayDateStrip ds-label, MatrixGrid row
 *   [F6] edit-panel role helpers (EpSubtasks/EpTags/EpTomato) + EditPanel deadline clear keydown
 *   [F7] ViewMoreMenu: sort items are menuitemradio in a role=group; items activate on Space too
 *   [F8] ChartCard onUpgrade falls back to window.open when the openExternal bridge is missing
 * Run: node --test tests/unit/renderer/d17-dom4-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------- [F1] prune grace follows the active expired window ---------- */

test('[F1] TodoGroups toggle derives the prune cutoff from expiredUncompletedTodoRange', () => {
  const src = read('renderer/js/components/TodoGroups.vue')
  assert.match(src, /import \{ dayjs, rangeDays \} from '\.\.\/utils\/core\.js'/, 'rangeDays is imported (same enum parser the store/views use)')
  assert.match(src, /rangeDays\(this\.\$store\.state\.settings\.expiredUncompletedTodoRange, 30\)/, 'cutoff uses the SAME window the today view renders (30d fallback)')
  assert.ok(!/dayShift\(\+dayjs\(\)\.startOf\('day'\), -7\)/.test(src), 'the fixed 7-day grace is gone')
  // pure prune block markers still intact (verbatim extraction contract)
  assert.match(src, /\[component-fixes\] pure-start/)
  assert.match(src, /\[component-fixes\] pure-end/)
})

test('[F1] pruneExpiredFoldKeys verbatim: drops only expired-* keys strictly before the cutoff', () => {
  const src = read('renderer/js/components/TodoGroups.vue')
  const m = src.match(/function pruneExpiredFoldKeys \(list, cutoff\) \{[\s\S]*?\n\}/)
  assert.ok(m, 'pure prune function found')
  const fn = new Function(m[0] + '\nreturn pruneExpiredFoldKeys')()
  assert.deepEqual(fn(['expired-100', 'today', 'day-sel'], 200), ['today', 'day-sel'], 'expired key before cutoff pruned')
  assert.deepEqual(fn(['expired-200', 'expired-300'], 200), ['expired-200', 'expired-300'], 'keys at/after cutoff survive')
  assert.deepEqual(fn(null, 200), [], 'null list tolerated')
})

/* ---------- [F2] CalendarView addTodo failure paths surface a toast ---------- */

test('[F2] createAt and the container keydown proxy both carry the tbCreate-style .catch', () => {
  const src = read('renderer/js/views/CalendarView.vue')
  // createAt: .then chain ends with a .catch (return keeps the promise chain for callers)
  assert.match(src, /createAt \(ts\) \{[\s\S]*?\.catch\(e => \{ console\.error\('\[calendar\] createAt addTodo failed:', e\); this\.\$message\.error\(this\.\$t\('statsD\.QuickAdd\.createFailed'\)\) \}\)/,
    'createAt addTodo failure shows the createFailed toast')
  // [maint/d23 FIX-3b] the mounted() container keydown proxy DELEGATES to createAt (identical
  // payload + it inherits the shared double-submit guard), so the failure toast contract is
  // carried by createAt on its behalf
  assert.match(src, /this\.createAt\(\+dayjs\(cell\.dataset\.date\)\)/,
    'cell keydown delegates to createAt, which owns the createFailed toast')
})

test('[F2] createAt behavior: rejected addTodo surfaces $message.error and does not reject unhandled', async () => {
  const src = read('renderer/js/views/CalendarView.vue')
  const m = src.match(/createAt \(ts\) \{([\s\S]*?)\n {4}\},/)
  assert.ok(m, 'createAt method found')
  const errors = []
  const commits = []
  const vm = {
    $store: { dispatch: () => Promise.reject(new Error('ipc down')), commit: (k, v) => commits.push(k) },
    $message: { error: msg => errors.push(msg), info: () => {} },
    $t: k => k
  }
  const createAt = new Function('return async function createAt (ts) {' + m[1] + '}')()
  await createAt.call(vm, 123)
  assert.equal(commits.length, 0, 'no editor opened when the dispatch fails')
  assert.deepEqual(errors, ['statsD.QuickAdd.createFailed'], 'error toast shown')
})

/* ---------- [F3] TodoBoxView "?" tip reachable by keyboard/touch ---------- */

test('[F3] tip popover migrated to the CompletedView fixed pattern (click trigger + role=button)', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  const m = src.match(/<el-popover placement="top-start" width="300" trigger="(\w+)"/)
  assert.equal(m && m[1], 'click', 'tip popover trigger is click (was hover-only, keyboard/touch unreachable)')
  assert.match(src, /class="icon-append tip-icon dd-q" role="button" tabindex="0"/, 'reference is focusable with button semantics')
  assert.match(src, /@keydown="onTipKey"/, 'Space/Enter activation bound')
  assert.match(src, /onTipKey: roleButtonActivate\(function \(e\) \{ this\.tipTrigger\(e\) \}\)/, 'routes through the shared ARIA button helper')
})

/* ---------- [F4] postpone toast announces the real destination ---------- */

test('[F4] TodoItem.moveDay and taskMenu postpone use movedTo with the actual target date', () => {
  const item = read('renderer/js/components/TodoItem.vue')
  assert.match(item, /offset === 1 \? this\.\$t\('statsJ\.TodoItem\.movedTo', \{ d: dayjs\(target\)\.format\(FMT\.cnDate\) \}\) : this\.\$t\('statsJ\.TodoItem\.movedToToday'\)/,
    'TodoItem postpone toast carries the real destination date (movedToTomorrow was false for non-overdue tasks)')
  const menu = read('renderer/js/utils/taskMenu.js')
  assert.match(menu, /offset === 0 \? 'statsJ\.TodoItem\.movedToToday' : 'statsJ\.TodoItem\.movedTo', \{ d: dayjs\(target\)\.format\(FMT\.cnDate\) \}\)/,
    'taskMenu postpone toast carries the real destination date')
})

/* ---------- [F5] Space activation on role=button rows/headers ---------- */

const spaceSites = [
  ['renderer/js/components/TodoGroups.vue', /@click="toggle\(g\.key\)" @keydown="onHeadKey\(g\.key, \$event\)"/, 'group collapse header'],
  ['renderer/js/components/TodoGroups.vue', /onHeadKey \(key, e\) \{ roleButtonActivate\(\(\) => \{ this\.toggle\(key\) \}\)\.call\(this, e\) \}/, 'TodoGroups header helper'],
  ['renderer/js/views/CompletedView.vue', /@click="toggleCol\(g\.key\)" @keydown="onHeadKey\(g\.key, \$event\)"/, 'completed group header'],
  ['renderer/js/views/CompletedView.vue', /onHeadKey \(key, e\) \{ roleButtonActivate\(\(\) => \{ this\.toggleCol\(key\) \}\)\.call\(this, e\) \}/, 'CompletedView header helper'],
  ['renderer/js/components/DayDateStrip.vue', /@click\.stop="showCal=!showCal" @keydown="onLabelKey"/, 'ds-label date trigger'],
  ['renderer/js/components/DayDateStrip.vue', /onLabelKey: roleButtonActivate\(function \(\) \{ this\.showCal = !this\.showCal \}\)/, 'DayDateStrip label helper'],
  ['renderer/js/components/MatrixGrid.vue', /@click="openEdit\(t\)" @keydown="onRowKey\(t, \$event\)"/, 'matrix task row'],
  ['renderer/js/components/MatrixGrid.vue', /roleButtonActivate\(function \(\) \{ this\.openEdit\(t\) \}\)\.call\(this, e\)/, 'MatrixGrid row helper']
]
for (const [file, re, what] of spaceSites) {
  test(`[F5] ${path.basename(file)}: ${what} routes through roleButtonActivate (Enter+Space)`, () => {
    assert.match(read(file), re)
  })
}

/* ---------- [F6] edit-panel role-helper migrations ---------- */

const epSites = [
  ['renderer/js/components/edit-panel/EpSubtasks.vue', /@click\.stop="toggleSub\(s\)" @keydown="onCheckKey\(s, \$event\)"/, 'subtask check'],
  ['renderer/js/components/edit-panel/EpSubtasks.vue', /@keydown="onTextKey\(i, \$event\)"/, 'subtask text (rename)'],
  ['renderer/js/components/edit-panel/EpSubtasks.vue', /@click\.stop="delSub\(i\)" @keydown="onDelKey\(i, \$event\)"/, 'subtask delete'],
  ['renderer/js/components/edit-panel/EpSubtasks.vue', /@keydown="onMoveKey\(i, -1, \$event\)"/, 'subtask move up'],
  ['renderer/js/components/edit-panel/EpSubtasks.vue', /@keydown="onMoveKey\(i, 1, \$event\)"/, 'subtask move down'],
  ['renderer/js/components/edit-panel/EpTags.vue', /@click\.stop="\$emit\('remove', t\)" @keydown="onRemoveKey\(t, \$event\)"/, 'tag remove'],
  ['renderer/js/components/edit-panel/EpTomato.vue', /@click\.stop="\$emit\('open'\)" @keydown="onSegKey"/, 'tomato actual segment'],
  ['renderer/js/components/EditPanel.vue', /@click\.stop="fieldPatch\('deadlineTs',0\)" @keydown="onDeadlineClearKey"/, 'deadline clear (had NO keydown)']
]
for (const [file, re, what] of epSites) {
  test(`[F6] ${path.basename(file)}: ${what} uses the role helper keydown binding`, () => {
    assert.match(read(file), re)
  })
}

test('[F6] checkbox sites use roleCheckboxActivate; button sites use roleButtonActivate', () => {
  const subs = read('renderer/js/components/edit-panel/EpSubtasks.vue')
  assert.match(subs, /onCheckKey \(s, e\) \{\s*\n\s*roleCheckboxActivate/, 'subtask check = checkbox pattern (Enter+Space, stopped)')
  assert.match(subs, /import \{ roleButtonActivate, roleCheckboxActivate \} from '\.\.\/\.\.\/utils\/roleButtonKey\.js'/)
  const ep = read('renderer/js/components/EditPanel.vue')
  assert.match(ep, /onDeadlineClearKey: roleButtonActivate\(function \(\) \{ this\.fieldPatch\('deadlineTs', 0\) \}, \{ stop: true \}\)/)
})

/* ---------- [F7] ViewMoreMenu: menuitemradio group + Space activation ---------- */

test('[F7] sort items render as menuitemradio inside a role=group; items activate on Enter+Space', () => {
  const src = read('renderer/js/components/ViewMoreMenu.vue')
  assert.match(src, /role="group" :aria-label="\$t\('viewMore\.sortGroup'\)"/, 'sort options wrapped in a labelled group')
  assert.match(src, /role="menuitemradio" tabindex="0"/, 'sort entries are menuitemradio (was menuitemcheckbox)')
  assert.match(src, /sortItems \(\) \{ return this\.items\.filter\(it => it\.group === 'sort'\) \}/, 'sort items split out of the flat list')
  assert.match(src, /otherItems \(\) \{ return this\.items\.filter\(it => it\.group !== 'sort'\) \}/)
  assert.match(src, /onItemKey \(it, e\) \{ roleButtonActivate\(\(\) => \{ this\.click\(it\) \}, \{ stop: true \}\)\.call\(this, e\) \}/, 'items activate on Space too')
  assert.ok(!/@keydown\.enter\.prevent\.stop="click\(it\)"/.test(src), 'old Enter-only binding replaced')
})

test('[F7] locale parity: viewMore.sortGroup exists in en and zh', () => {
  assert.match(read('renderer/js/i18n/en-US.js'), /"sortGroup": "Sort order"/)
  assert.match(read('renderer/js/i18n/zh-CN.js'), /"sortGroup": "排序方式"/)
})

/* ---------- [F8] ChartCard upgrade CTA fallback ---------- */

test('[F8] onUpgrade uses openExternal when present, window.open fallback otherwise, honest warning if blocked', async () => {
  const src = read('renderer/js/views/statistics/ChartCard.vue')
  assert.match(src, /window\.open\(url, '_blank', 'noopener'\)/, 'window.open fallback (popup-guarded)')
  const m = src.match(/onUpgrade \(\) \{([\s\S]*?)\n {4}\},/)
  assert.ok(m, 'onUpgrade found')
  const warnings = []
  const mkVm = api => ({
    $message: { warning: w => warnings.push(w), error: () => {} },
    $t: (k, p) => k + ':' + (p && p.url || '')
  })
  const onUpgrade = new Function('return function onUpgrade () {' + m[1] + '}')()
  // bridge present -> IPC path only
  globalThis.window.todoAPI = { openExternal: (...a) => { globalThis.__oe = a } }
  await onUpgrade.call(mkVm())
  assert.deepEqual(globalThis.__oe, ['https://pickdone.app'], 'bridge path used')
  assert.equal(warnings.length, 0)
  // bridge missing -> window.open fallback
  delete globalThis.window.todoAPI
  let opened = null
  globalThis.window.open = (u, t, f) => { opened = [u, t, f]; return {} }
  await onUpgrade.call(mkVm())
  assert.deepEqual(opened, ['https://pickdone.app', '_blank', 'noopener'], 'fallback opens a new tab')
  assert.equal(warnings.length, 0)
  // popup blocked -> honest warning toast (no silent no-op)
  globalThis.window.open = () => null
  await onUpgrade.call(mkVm())
  assert.equal(warnings.length, 1, 'blocked popup warns instead of dying silently')
  delete globalThis.window.open
  delete globalThis.__oe
})

test('[F8] locale parity: statsA.ChartCard.openExternalFallback exists in en and zh', () => {
  assert.match(read('renderer/js/i18n/locales/en-US-A.js'), /openExternalFallback: 'Popup blocked — open \{url\} manually'/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-A.js'), /openExternalFallback: '弹窗被拦截，请手动打开 \{url\}'/)
})
