/**
 * D4 maintenance round (renderer components/views/main/logger) — regression guards.
 * Pure logic is extracted from the source via [component-fixes]/[logger-fixes] pure markers;
 * template/CSS/route fixes are locked in as structural source assertions.
 * Run: node --test tests/unit/renderer/d4-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

function pureFns (file, names, marker) {
  const src = read(file)
  const re = new RegExp('\\[' + (marker || 'component-fixes') + '\\] pure-start[^\\n]*\\n([\\s\\S]*?)\\[' + (marker || 'component-fixes') + '\\] pure-end')
  const m = src.match(re)
  assert.ok(m, `${file}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

/* ---------- #1 SnManageCategoriesModal: Space double-toggle removed ---------- */

test('SnManageCategoriesModal: no local @keydown.space on the role="button" count toggle', () => {
  const src = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  assert.ok(!src.includes('@keydown.space='), 'local Space binding must stay deleted (global Space handler clicks role-bearing elements; double-toggle regression 701b0ba class)')
  assert.match(src, /class="cat-mgr-count" role="button" tabindex="0"/, 'click + tabindex kept for global Space activation')
})

/* ---------- #2 EpDependencies: cycle-closing candidates filtered out ---------- */

test('EpDependencies: allDepCandidates excludes candidates that would close a cycle', async () => {
  const src = read('renderer/js/components/edit-panel/EpDependencies.vue')
  assert.match(src, /import \{ wouldCycle \} from '\.\.\/\.\.\/utils\/deps\.js'/, 'wouldCycle imported from utils/deps.js')
  assert.match(src, /wouldCycle\(this\.\$store\.state\.todo\.todoList, self, this\.depPreds\.concat\(t\.taskId\)\)/, 'candidate filter uses the store write-time guard')

  // Behavioral check against the real util (core.js touches window at import time)
  globalThis.window = globalThis.window || {}
  const { wouldCycle } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/deps.js')))
  const list = [
    { taskId: 'a', delete: false, complete: false, taskContent: 'A', predecessors: '[]' },
    { taskId: 'b', delete: false, complete: false, taskContent: 'B', predecessors: '["a"]' }
  ]
  // editing a, adding b as its predecessor closes a→b→a: wouldCycle must flag it
  assert.equal(wouldCycle(list, 'a', ['b']), true)
  assert.equal(wouldCycle(list, 'a', []), false)
})

test('EpDependencies: cycle filter removed from candidates list (pure simulation of the component filter)', async () => {
  // Reproduce the component's filter chain verbatim against a tiny store snapshot
  const { wouldCycle } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/deps.js')))
  const todoList = [
    { taskId: 'self', delete: false, complete: false, taskContent: 'Self', predecessors: '[]' },
    { taskId: 'ok', delete: false, complete: false, taskContent: 'Ok', predecessors: '[]' },
    { taskId: 'closer', delete: false, complete: false, taskContent: 'Closer', predecessors: '["self"]' }
  ]
  const task = { taskId: 'self', predecessors: '[]' }
  const depPreds = JSON.parse(task.predecessors || '[]')
  const self = task.taskId
  const have = new Set(depPreds)
  const candidates = todoList
    .filter(t => !t.delete && !t.complete && t.taskId !== self && !have.has(t.taskId) && t.taskContent)
    .filter(t => !self || !wouldCycle(todoList, self, depPreds.concat(t.taskId)))
  assert.deepEqual(candidates.map(c => c.taskId), ['ok'], 'cycle-closing "closer" must not be offered')
})

/* ---------- #3 IME guards on 4 inputs ---------- */

const IME = 'isComposing || e.keyCode === 229'

test('IME guards present (and keydown-based) on the four fixed inputs', () => {
  const cat = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  const tags = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  const habit = read('renderer/js/views/HabitView.vue')

  for (const [name, src, tmpl] of [
    ['SnManageCategoriesModal rename', cat, 'sn-cat-edit'],
    ['SnManageTagsModal rename', tags, 'sn-cat-edit'],
    ['HabitView addHabit', habit, 'habit-add-input'],
    ['HabitView rename', habit, 'habit-rename']
  ]) {
    assert.ok(src.includes(IME), `${name}: composition guard missing`)
    assert.ok(!new RegExp(`input[^>]*${tmpl}[^>]*@keyup\\.enter`).test(src), `${name}: must not use keyup.enter`)
  }
  assert.match(cat, /@keydown\.enter\.prevent="e => \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; saveMgrEdit\(c\) \}"/)
  assert.match(tags, /@keydown\.enter\.prevent="e => \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; renameTag\(t\) \}"/)
  assert.match(habit, /@keydown\.enter\.prevent="e => \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; addHabit\(\) \}"/, 'addHabit also gains .prevent matching siblings')
  assert.match(habit, /@keydown\.enter\.prevent="e => \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; saveRename\(h\) \}"/)
})

/* ---------- #4 + #5 SettingsShortcutsTab: Meta modifier + blur-race guard ---------- */

test('captureCombo: metaKey is recorded as cmd (Cmd+X no longer recorded as x)', () => {
  const { captureCombo } = pureFns('renderer/js/components/settings/SettingsShortcutsTab.vue', ['captureCombo'])
  assert.equal(captureCombo({ ctrlKey: true, altKey: false, shiftKey: false, metaKey: true }, 'x'), 'ctrl+cmd+x')
  assert.equal(captureCombo({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: true }, 'x'), 'cmd+x')
  assert.equal(captureCombo({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: false }, ' '), 'ctrl+alt+shift+space')
  assert.equal(captureCombo({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, 'delete'), 'delete')
})

test('formatShortcutText: stored cmd token renders as the command glyph', () => {
  const { formatShortcutText } = pureFns('renderer/js/components/settings/SettingsShortcutsTab.vue', ['formatShortcutText'])
  assert.equal(formatShortcutText('cmd+x'), '⌘+x')
  assert.equal(formatShortcutText('ctrl+cmd+x'), 'ctrl+⌘+x')
  assert.equal(formatShortcutText('ctrl+shift+x'), 'ctrl+shift+x')
  assert.equal(formatShortcutText(''), '')
})

test('shouldBlockCaptureStart: blur-stop followed by an unfocused stray click in the same tick is blocked', () => {
  const { shouldBlockCaptureStart } = pureFns('renderer/js/components/settings/SettingsShortcutsTab.vue', ['shouldBlockCaptureStart'])
  const now = 1000
  // no recent blur → never block
  assert.equal(shouldBlockCaptureStart({ now, lastBlurAt: 0, hasFocus: false }), false)
  // legit re-click: the capture button itself has focus → never block
  assert.equal(shouldBlockCaptureStart({ now, lastBlurAt: now, hasFocus: true }), false)
  // stray click right after a blur stop → block
  assert.equal(shouldBlockCaptureStart({ now, lastBlurAt: now, hasFocus: false }), true)
  // within the guard window → block
  assert.equal(shouldBlockCaptureStart({ now, lastBlurAt: now - 100, hasFocus: false }), true)
  // window elapsed → allow
  assert.equal(shouldBlockCaptureStart({ now, lastBlurAt: now - 500, hasFocus: false }), false)
})

test('SettingsShortcutsTab source: metaKey handled, guard wired in startCapture, blur records timestamp', () => {
  const src = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
  assert.match(src, /if \(e\.metaKey\) parts\.push\('cmd'\)/, 'handleCaptureKey must push cmd')
  assert.match(src, /shouldBlockCaptureStart\(\{ now: Date\.now\(\), lastBlurAt: this\._lastBlurStopAt/)
  assert.match(src, /onCaptureBlur \(\) \{ this\._lastBlurStopAt = Date\.now\(\); this\.stopCapture\(\) \}/)
})

/* ---------- #6 StatisticsView: #c9ced6 light-gray blocks replaced with tokens ---------- */

test('StatisticsView: unit-unfilled/rest segments no longer hardcode #c9ced6', () => {
  const src = read('renderer/js/views/StatisticsView.vue')
  assert.ok(!src.includes('#c9ced6') || /var\(--line-strong, #c9ced6\)/.test(src), 'hex only allowed as token fallback')
  assert.match(src, /\.tl-seg\.rest \{ background: var\(--line-strong\)/)
  assert.match(src, /linear-gradient\(to right, var\(--brand\) var\(--ff\), var\(--line-strong\) var\(--ff\)\)/)
  assert.match(src, /\.tl-chip--rest \{ background: var\(--line-strong\)/)
})

/* ---------- #7 CalendarView .work chip dark override ---------- */

test('CalendarView: dark-mode override for the调休 work chip exists with translucent brand tones', () => {
  const src = read('renderer/js/views/CalendarView.vue')
  assert.match(src, /html\[data-theme="dark"\] \.fc \.fc-daygrid-day-number \.work\{[^}]*rgba\(15, 157, 143/)
})

/* ---------- #8 placeholder token replaces hardcoded #8a9099 ---------- */

test('SideNav and EpSubtasks placeholders use var(--text-4) like EditPanel', () => {
  assert.ok(!read('renderer/js/components/SideNav.vue').includes('#8a9099'))
  assert.ok(!read('renderer/js/components/edit-panel/EpSubtasks.vue').includes('#8a9099'))
  assert.match(read('renderer/js/components/SideNav.vue'), /\.sn-search input::placeholder \{ color: var\(--text-4\)/)
  assert.match(read('renderer/js/components/edit-panel/EpSubtasks.vue'), /\.ep-addsub-input::placeholder \{ color: var\(--text-4\)/)
  assert.match(read('renderer/js/components/EditPanel.vue'), /var\(--text-4\)/, 'EditPanel reference pattern still present')
})

/* ---------- #9 TodoBoxView dropdown options have roles ---------- */

test('TodoBoxView: sort/order/category menu items are role=option with aria-selected inside role=listbox', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  const listboxes = src.match(/<ul class="dd-menu" role="listbox"/g) || []
  assert.equal(listboxes.length, 3, 'all three dd-menus are listboxes')
  const options = src.match(/role="option"/g) || []
  assert.equal(options.length, 4, 'option roles on every item (two v-for rows + the all-cats row)')
  assert.match(src, /:aria-selected="m\.value === settings\.todoBoxSortMethod \? 'true' : 'false'"/)
  assert.match(src, /:aria-selected="o\.value === settings\.todoBoxSortOrder \? 'true' : 'false'"/)
  assert.match(src, /:aria-selected="c\.categoryId === settings\.todoBoxCategoryId \? 'true' : 'false'"/)
  assert.match(src, /:aria-selected="settings\.todoBoxCategoryId === -1 \? 'true' : 'false'"/)
})

/* ---------- #10 DayDateStrip: calendar popover focuses first control on open ---------- */

test('DayDateStrip: showCal watcher focuses the first popover control (Esc reachable from anywhere)', () => {
  const src = read('renderer/js/components/DayDateStrip.vue')
  assert.match(src, /watch: \{[\s\S]*?showCal \(v\) \{[\s\S]*?first\.focus\(\)/, 'showCal watcher must focus the first button on open')
})

/* ---------- #11 RepeatModal: setMeta failure surfaces a warning toast ---------- */

test('RepeatModal: setMeta failure warns via $message.warning with symmetric i18n keys', () => {
  const src = read('renderer/js/components/RepeatModal.vue')
  assert.match(src, /this\.\$message\.warning\(this\.\$t\('statsD\.RepeatModal\.ruleSaveFailed'\)\)/)
  const zh = read('renderer/js/i18n/locales/zh-CN-D.js')
  const en = read('renderer/js/i18n/locales/en-US-D.js')
  assert.match(zh, /"ruleSaveFailed": "重复规则保存失败，自动续期可能不生效"/)
  assert.match(en, /"ruleSaveFailed": "Failed to save the repeat rule; auto-renewal may not take effect"/)
})

/* ---------- #12 TomatoFocusRecordModal gridlines theme-aware ---------- */

test('TomatoFocusRecordModal: timeline gridlines use var(--line), not rgba(0,0,0,.06)', () => {
  const src = read('renderer/js/components/TomatoFocusRecordModal.vue')
  assert.ok(!src.includes('rgba(0, 0, 0, .06)'), 'hardcoded light-only gridline removed')
  assert.match(src, /\.tfr-timeline__grid i \{ position: absolute; top: 0; bottom: 0; width: 1px; background: var\(--line\)/)
})

/* ---------- #13 main.js switchToRecentTodos routing ---------- */

test('main.js: switchToRecentTodos routes to todo-list-today-x, distinct from switchToDaytodo', () => {
  const src = read('renderer/js/main.js')
  assert.match(src, /case 'switchToDaytodo': router\.push\(\{ name: 'todo-list-today' \}\)/)
  assert.match(src, /case 'switchToRecentTodos': router\.push\(\{ name: 'todo-list-today-x' \}\)/)
  const router = read('renderer/js/router.js')
  assert.match(router, /name: 'todo-list-today-x'/, 'target route exists in router.js')
})

/* ---------- #14 main.js trailing-reload timer cancelled on the direct path ---------- */

test('main.js: direct _reloadExternal path clears the pending trailing reload timer', () => {
  const src = read('renderer/js/main.js')
  const m = src.match(/_todosChangedTimer = setTimeout\(\(\) => \{[\s\S]*?\n[ ]{4}\}, 500\)/)
  assert.ok(m, 'onTodosChanged block found')
  const block = m[0].split('\r').join('')
  const tailPath = block.indexOf('clearTimeout(_todosChangedTail)\n        _todosChangedTail = setTimeout')
  const directPath = block.indexOf('clearTimeout(_todosChangedTail)\n      _reloadExternal()')
  assert.ok(tailPath > -1, 'trailing path schedules the tail timer')
  assert.ok(directPath > tailPath, 'direct path must clearTimeout(_todosChangedTail) before _reloadExternal()')
})

/* ---------- #15 logger: failed sends are re-queued with a cap ---------- */

test('requeueWithCap: failed entries go back in front, oldest dropped beyond cap', () => {
  const { requeueWithCap } = pureFns('renderer/js/utils/logger.js', ['requeueWithCap'], 'logger-fixes')
  assert.deepEqual(requeueWithCap(['b', 'c'], ['x', 'a-failed'], 10), ['x', 'a-failed', 'b', 'c'])
  assert.deepEqual(requeueWithCap(['b', 'c', 'd'], ['f1', 'f2'], 3), ['b', 'c', 'd'], 'cap keeps the newest entries; oldest of the merged batch is dropped')
  assert.deepEqual(requeueWithCap([], ['only'], 5), ['only'])
  assert.deepEqual(requeueWithCap(['a'], [], 5), ['a'])
})

test('logger flush: rejected sendToMain promise re-queues entries for the next successful flush', async () => {
  const loggerPath = path.join(ROOT, 'renderer/js/utils/logger.js')
  const sent = []
  let failNext = true
  globalThis.window = {
    todoAPI: {
      logWrite: entries => {
        if (failNext) { failNext = false; return Promise.reject(new Error('bridge down')) }
        sent.push(...entries)
        return Promise.resolve(true)
      }
    }
  }
  try {
    const mod = await import(pathToFileURL(loggerPath))
    const { logger } = mod
    logger.error('boom-one')
    logger.error('boom-two')
    // buffered (threshold is 20): explicit flush hits the failing bridge
    logger.flush()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(sent.length, 0, 'first flush fails — nothing delivered yet')
    // second flush delivers the re-queued batch: nothing was lost
    logger.flush()
    await new Promise(r => setTimeout(r, 10))
    const msgs = sent.map(e => e.msg)
    assert.deepEqual(msgs, ['boom-one', 'boom-two'], 'failed batch re-queued and delivered on retry')
    assert.equal(mod.logger.flush.toString().includes('requeue'), true)
  } finally {
    delete globalThis.window
  }
})
