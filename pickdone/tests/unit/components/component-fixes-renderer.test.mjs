/**
 * Renderer component-domain fixes (2026-09 batch) — regression guards.
 * Pure logic is extracted verbatim from the .vue script blocks (between the
 * "[component-fixes] pure-start/end" markers) and exercised directly; template/CSS/a11y
 * fixes are locked in as structural source assertions (visual-only, covered by visual gate).
 * Run: node --test tests/component-fixes-renderer.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Extract the marked pure-function block from an SFC script and evaluate it, returning its functions */
function pureFns (file, names) {
  const src = read(file)
  const m = src.match(/\/\/ \[component-fixes\] pure-start[^\n]*\n([\s\S]*?)\/\/ \[component-fixes\] pure-end/)
  assert.ok(m, `${file}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

/* ---------- #13 TodoGroups: expired fold-key pruning ---------- */

test('pruneExpiredFoldKeys: drops expired-<ts> keys from before today, keeps the rest', () => {
  const { pruneExpiredFoldKeys } = pureFns('renderer/js/components/TodoGroups.vue', ['pruneExpiredFoldKeys'])
  const today0 = 1000000000000 // 2001-09-09, fixed anchor
  const yesterday = today0 - 86400000
  const tomorrow = today0 + 86400000
  assert.deepEqual(
    pruneExpiredFoldKeys([`expired-${yesterday}`, 'today-today', 'day-done', `expired-${tomorrow}`], today0),
    ['today-today', 'day-done', `expired-${tomorrow}`] // future/typo-free keys survive, yesterday's is dead weight
  )
  assert.deepEqual(pruneExpiredFoldKeys([`expired-${yesterday}`], today0), [])
  assert.deepEqual(pruneExpiredFoldKeys([], today0), [])
  assert.deepEqual(pruneExpiredFoldKeys(undefined, today0), []) // defensive: unset settings value
})

test('pruneExpiredFoldKeys: boundary — a key exactly at today start is not expired', () => {
  const { pruneExpiredFoldKeys } = pureFns('renderer/js/components/TodoGroups.vue', ['pruneExpiredFoldKeys'])
  const today0 = 1700000000000
  assert.deepEqual(pruneExpiredFoldKeys([`expired-${today0}`], today0), [`expired-${today0}`])
})

/* ---------- #9 DayDateStrip: week-start-aware calendar grid ---------- */

test('calGridOffset: Monday start maps Mon..Sun to 0..6, Sunday start maps Sun..Sat to 0..6', () => {
  const { calGridOffset } = pureFns('renderer/js/components/DayDateStrip.vue', ['calGridOffset'])
  for (let dow = 0; dow < 7; dow++) {
    assert.equal(calGridOffset(dow, false), (dow + 6) % 7, `mon-start dow=${dow}`)
    assert.equal(calGridOffset(dow, true), dow, `sun-start dow=${dow}`)
  }
  // The case that used to be impossible in the popover: the 1st falls on Sunday with Monday start -> 6 leading blanks
  assert.equal(calGridOffset(0, false), 6)
})

test('weekHeaderOrder: header columns rotate with the week start, staying in sync with calCells', () => {
  const { weekHeaderOrder } = pureFns('renderer/js/components/DayDateStrip.vue', ['weekHeaderOrder'])
  assert.deepEqual(weekHeaderOrder(false), [1, 2, 3, 4, 5, 6, 0]) // Mon..Sun
  assert.deepEqual(weekHeaderOrder(true), [0, 1, 2, 3, 4, 5, 6]) // Sun..Sat
})

/* ---------- structural locks for template/CSS/a11y fixes (visual-only) ---------- */

test('EditPanel: Esc exemption list covers all top-level overlays', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const m = src.match(/if \(ui\.showSettingsModal[\s\S]*?\) return/)
  assert.ok(m, 'exemption condition not found')
  for (const key of ['showRepeatDeleteConfirm', 'accountTaskId', 'tomatoAbandonVisible', 'tomatoFocusRecordVisible']) {
    assert.ok(m[0].includes(key), `missing Esc exemption: ${key}`)
  }
})

test('EditPanel: deadline clear button has an aria-label (parity with reminder clear)', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const m = src.match(/<b v-if="e&&e\.deadlineTs"[^>]*>/)
  assert.ok(m && m[0].includes(':aria-label="$t(\'statsJ.EditPanel.clearDueDate\')"'), 'deadline clear lacks aria-label')
})

test('TomatoBar: work (give-up) button uses the brand teal family, no brick red left', () => {
  const src = read('renderer/js/components/TomatoBar.vue')
  assert.ok(!src.includes('#bd401e'), 'brick red #bd401e must be gone')
  assert.ok(src.includes('.tomato-timer__play--work { background-color: #0c8172; }'), 'work state must match the brand teal of the default play state')
  assert.ok(!/番茄无暂停语义[\s\S]*cursor:\s*pointer/.test(src), 'timer text must not advertise pause')
  const time = src.match(/\.tomato-timer__time \{[\s\S]*?\}/)[0]
  assert.ok(!time.includes('cursor: pointer'), 'timer time block must not claim clickability')
  assert.ok(time.includes('pointer-events: none'), 'timer time must ignore pointer events')
})

test('HabitView: habit name is wired to startRename; frequency form validates before commit', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.ok(src.includes('class="habit-name" role="button"') && src.includes('@click="startRename(h)"'), 'habit-name must enter rename mode on click')
  assert.ok(src.includes("freqWeekdaysRequired"), 'empty-weekdays warning key used')
  assert.ok(src.includes('Math.min(30, Math.max(2,'), 'intervalN clamped to 2-30')
})

test('TaskAccountModal: edit form exposes the abandoned toggle (saveEdit already honors it)', () => {
  const src = read('renderer/js/components/TaskAccountModal.vue')
  const edit = src.match(/class="ta-edit"[\s\S]*?class="ta-btns"/)
  assert.ok(edit && edit[0].includes('draft.abandoned = !!v'), 'ta-edit form must bind the abandoned switch')
})

test('TodoItem: move announce is a standalone sentence, no donePrefix concatenation', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  assert.ok(!src.includes("donePrefix') + (dir"), 'donePrefix must not be prepended to move announce')
  assert.ok(src.includes("dir > 0 ? 'statsJ.TodoItem.moveDownAnnounce' : 'statsJ.TodoItem.moveUpAnnounce'"), 'standalone move keys used')
})

test('SearchView: silent 200-cap now renders an explicit truncation notice', () => {
  const src = read('renderer/js/views/SearchView.vue')
  assert.ok(src.includes('search-truncated') && src.includes('truncatedNotice'), 'truncation notice row must render when capped')
})

test('SideNav: clearing search navigates deterministically (replace to source view), never $router.back()', () => {
  const src = read('renderer/js/components/SideNav.vue')
  assert.ok(src.includes('_returnFromSearch') && src.includes('$router.replace(r)'), 'deterministic replace navigation present')
  assert.ok(!src.includes('todo-list-search\') this.$router.back()'), '$router.back() exit removed')
})

test('MatrixGrid: quadrant drop goes through moveWithUndo with a three-field snapshot', () => {
  const src = read('renderer/js/components/MatrixGrid.vue')
  assert.ok(src.includes('moveWithUndo(this,') , 'dropOn must use moveWithUndo')
  assert.ok(src.includes('important: t.important || 0, urgent: t.urgent || 0, priority: t.priority'), 'revert snapshot covers important/urgent/priority')
  assert.ok(!/dropOn[\s\S]*updateTodoFields[\s\S]*patch:\s*\{ important: q\.important/.test(src.split('moveWithUndo')[0]), 'no direct silent update left in dropOn')
})

test('a11y: role="checkbox" elements must NOT bind @keydown.space — the global main.js capture handler covers Space, and a per-element binding would double-toggle and cancel out', () => {
  // 2026-09-09 release review: main.js document-level capture listener (role=checkbox/button/switch/...)
  // already activates Space via t.click(); preventDefault does not stop propagation, so an element-local
  // @keydown.space handler fires a SECOND toggle — the two cancel out and keyboard checking appears dead.
  // Real <button>s (SideNav sections) may keep theirs: the global handler skips the BUTTON tag and the
  // preventDefault cancels the native keyup activation, so exactly one toggle remains.
  const files = [
    'renderer/js/components/TodoItem.vue',
    'renderer/js/components/DayDeck.vue',
    'renderer/js/components/DepView.vue',
    'renderer/js/components/DayRail.vue',
    'renderer/js/components/EditPanel.vue',
    'renderer/js/components/MatrixGrid.vue',
    'renderer/js/views/RecycleBinView.vue',
    'renderer/js/views/TodoBoxView.vue',
    'renderer/js/views/FilterView.vue',
    'renderer/js/views/HabitView.vue'
  ]
  const bad = []
  for (const f of files) {
    const src = read(f)
    const re = /<(?:span|div)[^>]*role="checkbox"[\s\S]*?>/g
    let m
    while ((m = re.exec(src))) {
      if (m[0].includes('@keydown.space')) bad.push(`${f}: ${m[0].slice(0, 80)}...`)
    }
    assert.ok(src.includes('role="checkbox"'), `${f} should still declare role=checkbox entries (sanity)`)
  }
  assert.deepEqual(bad, [], 'role=checkbox tags must not bind local @keydown.space (double toggle):\n' + bad.join('\n'))
  // The global handler itself must stay in place — it is the single Space activation path now
  const mainjs = read('renderer/js/main.js')
  assert.ok(mainjs.includes("role === 'checkbox'") && mainjs.includes("t.click()"), 'main.js global Space activation handler must remain')
})

test('a11y: TodoBoxView batch check is keyboard-focusable', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  const m = src.match(/<span v-if="batchMode" class="tb-batch-check"[^>]*>/)
  assert.ok(m && m[0].includes('tabindex="0"'), 'batch check must have tabindex="0"')
})

test('i18n: new keys exist in both languages', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  const load = async f => (await import(pathToFileURL(path.join(dir, f)).href)).default
  // shards may hold keys flat (dotted literal keys) or nested — compare on the flattened key set
  const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flat(v, `${pre}${k}.`) : [`${pre}${k}`])
  const pairs = [
    ['statsE.HabitView.freqWeekdaysRequired', 'zh-CN-E.js', 'en-US-E.js'],
    ['statsE.HabitView.freqIntervalClamped', 'zh-CN-E.js', 'en-US-E.js'],
    ['statsE.HabitView.renameTip', 'zh-CN-E.js', 'en-US-E.js'],
    ['statsE.SearchView.truncatedNotice', 'zh-CN-E.js', 'en-US-E.js'],
    ['statsJ.TodoItem.movedToQuadrant', 'zh-CN-J.js', 'en-US-J.js']
  ]
  for (const [key, zh, en] of pairs) {
    const zhKeys = flat(await load(zh))
    const enKeys = flat(await load(en))
    assert.ok(zhKeys.includes(key), `${key} missing in ${zh}`)
    assert.ok(enKeys.includes(key), `${key} missing in ${en}`)
  }
})
