/**
 * Renderer UI fixes locked to the 2026-09-10 nav-gate doctrine (all experimental surfaces =
 * developerMode && their own module switch; the same-day projects-graduation attempt was
 * reverted by user verdict) plus the P1/P2 behavior fixes from the same review:
 *   - DayDeck accepts a pre-filtered tasks prop (project filter now works in card view)
 *   - Today view restores a gated-off 'deps' preference back to 'list'
 *   - Todo box batch delete diverts recurring tasks to the scope-confirm modal and routes the
 *     rest through the unified deleteWithUndo exit
 *   - Milestone entrance animation targets the just-added entry, not the latest-date one
 * Pure logic is extracted verbatim from the SFC script blocks (between the "[navgate-fix]
 * pure-start/end" markers) and exercised directly; template/CSS-only changes are locked in as
 * structural source assertions (visual behavior covered by the existing visual gate).
 * Run: node --test tests/unit-navgate-fix-ui.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Extract the marked pure-function block from an SFC script and evaluate it, returning its functions */
function pureFns (file, names) {
  const src = read(file)
  const m = src.match(/\/\/ \[navgate-fix\] pure-start[^\n]*\n([\s\S]*?)\/\/ \[navgate-fix\] pure-end/)
  assert.ok(m, `${file}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

/* ---------- #1 DayDeck: optional pre-filtered source list (project filter in card view) ---------- */

test('deckSource: only a real array overrides the store fallback (prop shape guard)', () => {
  const { deckSource } = pureFns('renderer/js/components/DayDeck.vue', ['deckSource'])
  const store = [{ taskId: 'a' }]
  const filtered = [{ taskId: 'b' }]
  assert.equal(deckSource(filtered, store), filtered, 'a valid filtered list is used as-is')
  assert.equal(deckSource(null, store), store, 'prop omitted -> store list (backward compatible)')
  assert.equal(deckSource(undefined, store), store)
  assert.equal(deckSource('nope', store), store, 'non-array prop value must not leak into filtering')
  assert.equal(deckSource(42, store), store)
  assert.deepEqual(deckSource([], store), [], 'an empty filter result is a legitimate scope, not a fallback')
})

test('DayDeck consumes the tasks prop; TodayView passes the project-filtered list', () => {
  const deck = read('renderer/js/components/DayDeck.vue')
  assert.ok(/tasks:\s*\{\s*type: Array as any,\s*default: null\s*\}/.test(deck), 'optional tasks prop declared')
  assert.ok(deck.includes('source () { return deckSource(this.tasks, this.$store.state.todo.todoList) }'), 'cards bucket the guarded source')
  assert.ok(!deck.includes('const list = this.$store.state.todo.todoList'), 'cards no longer read the store list directly')
  const today = read('renderer/js/views/TodayView.vue')
  assert.ok(today.includes('<pd-day-deck :tasks="deckTasks"/>'), 'deck branch receives the filtered list')
  assert.ok(today.includes('return this.fitProj(this.$store.state.todo.todoList)'), 'deckTasks applies the project filter')
})

/* ---------- #2 projects module gate: dropdown, row badge, goProject ---------- */

test('TodayView: project filter dropdown and row badges are gated on showProjectsModule', () => {
  const today = read('renderer/js/views/TodayView.vue')
  assert.ok(today.includes('v-if="settings.showProjectsModule && projects.length"'), 'dropdown hidden with the module off')
  assert.ok(today.includes(':project-badge="!!settings.showProjectsModule"'), 'badge prop rides the module switch')
  // Deep-linked ?project= must not arm an un-clearable filter either (no dropdown to reset it)
  assert.ok(/const valid = !!\(id && this\.settings\.showProjectsModule &&/.test(today), 'deep-link filter inert with the module off')
})

test('TodoItem: projCat resolver gates on showProjectsModule; goProject inherits the guard', () => {
  const item = read('renderer/js/components/TodoItem.vue')
  assert.ok(/projCat \(\) \{\s*\n\s*if \(!this\.\$store\.state\.settings\.showProjectsModule\) return null/.test(item),
    'badge resolution returns null when the module is off')
  // Regex, not a literal: CI runners check out CRLF (autocrlf) — a '\n'-only pattern is env-flaky
  assert.ok(/goProject \(\) \{\s*\n\s*if \(!this\.projCat\) return/.test(item), 'goProject still early-returns without a resolved project')
})

/* ---------- #3 deps two-layer gate in ProjectView and EditPanel ---------- */

test('ProjectView: deps tab button and pane both require developerMode && showDepsModule', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  const btn = src.match(/<button v-if="([^"]*)"[^>]*tab === 'deps'/)
  assert.ok(btn && btn[1] === 'settings.developerMode && settings.showDepsModule', 'tab button double-gated')
  const pane = src.match(/<div v-if="(tab === 'deps'[^"]*)"/)
  assert.ok(pane && pane[1] === "tab === 'deps' && settings.developerMode && settings.showDepsModule", 'tab pane double-gated')
})

test('EditPanel: devMode computed is the two-condition deps gate (matches TodayView paradigm)', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.ok(/devMode \(\) \{ const s = this\.\$store\.state\.settings; return !!s\.developerMode && !!s\.showDepsModule \}/.test(src),
    'devMode = developerMode && showDepsModule')
  assert.ok(src.includes('<div v-if="devMode" class="ep-cat-wrap">'), 'deps block still keyed on devMode')
})

/* ---------- #4 todo box batch delete through the unified exits ---------- */

test('splitBatchDelete: recurring instances divert to the scope modal, plain rows batch on', () => {
  const { splitBatchDelete } = pureFns('renderer/js/views/TodoBoxView.vue', ['splitBatchDelete'])
  const p1 = { taskId: 'p1' }
  const p2 = { taskId: 'p2' }
  const r1 = { taskId: 'r1', repeatId: 'rep1' }
  const r2 = { taskId: 'r2', repeatId: 'rep1' }
  const r3 = { taskId: 'r3', repeatId: 'rep2' }
  const out = splitBatchDelete([p1, r1, p2, r2, r3])
  assert.deepEqual(out.plain, [p1, p2], 'plain rows go through deleteWithUndo')
  assert.equal(out.repeatAsk, r1, 'only the first recurring row opens the scope modal this pass')
  assert.deepEqual(out.repeatRest, [r2, r3], 'extra recurring rows stay checked for the next pass')
})

test('splitBatchDelete: repeatId criterion matches TodoItem.isRepeat (string "null" is not a repeat)', () => {
  const { splitBatchDelete } = pureFns('renderer/js/views/TodoBoxView.vue', ['splitBatchDelete'])
  const legacyNull = { taskId: 'x', repeatId: 'null' }
  const out = splitBatchDelete([{ taskId: 'y', repeatId: null }, legacyNull, null])
  assert.deepEqual(out.plain.filter(Boolean).map(t => t.taskId), ['y', 'x'], 'null and "null" repeatIds are plain tasks')
  assert.equal(out.repeatAsk, null, 'no modal for a plain-only selection')
  assert.deepEqual(splitBatchDelete(null).plain, [], 'defensive: unset selection')
  assert.deepEqual(splitBatchDelete([]).repeatRest, [])
})

test('TodoBoxView: batchDelete uses the unified exits, hand-rolled undo removed', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  assert.ok(src.includes("for (const raw of plain) await deleteWithUndo(this, this.$store, raw)"), 'plain rows via deleteWithUndo')
  assert.ok(src.includes("this.$store.commit('ui/askRepeatDelete', repeatAsk.taskId)"), 'recurring rows via the scope-confirm modal')
  assert.ok(!src.includes('showUndoToast'), 'hand-rolled undo toast path removed (import included)')
  assert.ok(!src.includes("dispatch('todo/deleteTodo'"), 'no direct deleteTodo dispatch left in batch delete')
})

/* ---------- #5 today view mode restore honors the deps gate ---------- */

test('pickViewMode: residual deps preference falls back to list when the deps gate is off', () => {
  const { pickViewMode } = pureFns('renderer/js/views/TodayView.vue', ['pickViewMode'])
  assert.equal(pickViewMode('deps', false, false), 'list', 'gated-off deps must not leave the segment without an active state')
  assert.equal(pickViewMode('deps', true, false), 'list', 'deps wins over the matrix deep link, still gated')
  assert.equal(pickViewMode('deps', false, true), 'deps', 'gate on -> preference honored')
  assert.equal(pickViewMode(null, true, false), 'matrix', 'missing value: matrix deep link preserved')
  assert.equal(pickViewMode(null, false, false), 'list')
  assert.equal(pickViewMode('bogus', false, true), 'list', 'invalid value falls back to list')
  assert.equal(pickViewMode('deck', false, false), 'deck', 'ungated modes restore regardless of the deps gate')
  assert.equal(pickViewMode('matrix', false, false), 'matrix')
})

/* ---------- #6 all-empty today renders only the empty-state illustration ---------- */

test('TodayView: the today group is pushed conditionally (no 0-count header when all empty)', () => {
  const src = read('renderer/js/views/TodayView.vue')
  const m = src.match(/if \(undone\.length\) \{\s*\n\s*g\.push\(\{ key: 'today-today'/)
  assert.ok(m, 'today-today group follows the same conditional-push pattern as the selected-day branch')
})

/* ---------- #7 view-more menu: no dangling trailing separator ---------- */

test('ViewMoreMenu: the today menu ends with a real entry, not a separator', () => {
  const src = read('renderer/js/components/ViewMoreMenu.vue')
  const m = src.match(/'todo-list-today': \[([\s\S]*?)\],\r?\n/)
  assert.ok(m, 'today menu block found')
  const entries = m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('{') || l.startsWith('{ '))
  assert.ok(entries.length >= 2, 'menu still has entries')
  assert.ok(!entries[entries.length - 1].includes('sep: true'), 'last entry must not be a separator')
  assert.ok(entries[entries.length - 1].includes('checkFollowColor'), 'menu still ends with the color-follow toggle')
})

/* ---------- #8 date strip dim styling hits the real weekday class ---------- */

test('DayDateStrip: dim rule targets .ds-wd, dead opacity rule and .ds-week typo gone', () => {
  const src = read('renderer/js/components/DayDateStrip.vue')
  assert.ok(!src.includes('.ds-week'), 'the typo selector must be gone (DOM class is .ds-wd)')
  assert.ok(src.includes('.ds-day.dim:not(.sel) .ds-num, .ds-day.dim:not(.sel) .ds-wd { color: var(--text-3); }'),
    'weekday greys together with the day number')
  assert.ok(!/\.ds-day\.dim:not\(\.sel\)\s*\{\s*opacity:\s*1/.test(src), 'no-op opacity rule removed')
  // CSS hygiene: zero control characters anywhere in the component style block (same technique as
  // structure.test.mjs: backslash built via fromCharCode so no control chars appear in this source)
  const style = src.match(/<style>([\s\S]*)<\/style>/)
  assert.ok(style, 'style block present')
  const BS = String.fromCharCode(92)
  const CTRL = new RegExp('[' + BS + 'u0000-' + BS + 'u0008' + BS + 'u000B' + BS + 'u000C' + BS + 'u000E-' + BS + 'u001F]')
  assert.ok(!CTRL.test(style[1]), 'no control characters in CSS')
})

/* ---------- #9 milestone entrance animation targets the just-added entry ---------- */

test('resolveMsNewId: resolves by the pre-generated id even when it does not sort last', () => {
  const { resolveMsNewId } = pureFns('renderer/js/views/ProjectView.vue', ['resolveMsNewId'])
  // saveMilestones returns the list sorted by date: the new entry (id 'ms_new', earliest date) is first
  const saved = [{ id: 'ms_new' }, { id: 'ms_old_late' }]
  assert.equal(resolveMsNewId('ms_new', saved), 'ms_new', 'the new node is found by id, not as saved[saved.length-1]')
  assert.equal(resolveMsNewId('ms_ghost', saved), null, 'id dropped by the save -> no animation target')
  assert.equal(resolveMsNewId('ms_x', null), null, 'defensive: non-array save result')
  assert.equal(resolveMsNewId(undefined, saved), null)
})

test('ProjectView: addMilestone pre-generates the id; route param swap reloads project data', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  assert.ok(src.includes('const entry = { id: newMilestoneId(), title: title.trim(), date }'), 'entry id generated before saving')
  assert.ok(!src.includes('saved[saved.length - 1]'), 'last-of-saved heuristic removed')
  const watch = src.match(/'\$route\.params\.id' \(nval\) \{[\s\S]*?\r?\n {2}\}/)
  assert.ok(watch, 'route param watcher present')
  assert.ok(watch[0].includes('if (!nval) return'), 'guard against empty param')
  assert.ok(watch[0].includes('this.reloadMilestones()') && watch[0].includes('this.reloadDeadline()'),
    'reuses the created() load methods (milestones/deadline are only loaded there)')
})

test('milestones.js: newMilestoneId is the single id source for saveMilestones', () => {
  const src = read('renderer/js/utils/milestones.js')
  assert.ok(src.includes('export function newMilestoneId ()'), 'generator exported')
  assert.ok(src.includes('id: m.id || newMilestoneId()'), 'saveMilestones keeps caller-supplied ids, generates otherwise')
})
