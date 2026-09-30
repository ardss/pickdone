/**
 * D12 renderer component fixes — regression tests (node:test, no Vue mount).
 * Same seam style as h7-editpanel-seams: source anchors + extracted pure blocks.
 *
 * Covered: R2 EpSubtasks inline rename emit + EditPanel wiring,
 *          R5 EpReminders null-time row retention, R7/R8 TodoGroupBlock gear label +
 *          focus-within reveal, R12 SnTagPanel '+N more' overflow row,
 *          R13 ViewMoreMenu focus return on every close path,
 *          Fault-4 WeatherWidget shape sequence token, Fault-16 shape-cache eviction.
 *
 * Run: node --test tests/unit/components/d12-renderer-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const PARENT = read('renderer/js/components/EditPanel.vue')
const SUBTASKS = read('renderer/js/components/edit-panel/EpSubtasks.vue')
const REMINDERS = read('renderer/js/components/edit-panel/EpReminders.vue')
const GROUP = read('renderer/js/components/TodoGroupBlock.vue')
const TAGPANEL = read('renderer/js/components/side-nav/SnTagPanel.vue')
const SIDENAV = read('renderer/js/components/SideNav.vue')
const VIEWMORE = read('renderer/js/components/ViewMoreMenu.vue')
const WEATHER = read('renderer/js/components/WeatherWidget.vue')
const TAGS = read('renderer/js/components/edit-panel/EpTags.vue')
const EN_E = read('renderer/js/i18n/locales/en-US-E.js')
const ZH_E = read('renderer/js/i18n/locales/zh-CN-E.js')

/** Extract the "[d12-fixes] pure-start ... pure-end" block from a source file and evaluate it. */
function extractPure (src, file, names) {
  const s = src.indexOf('[d12-fixes] pure-start')
  assert.ok(s >= 0, `pure block not found in ${file}`)
  const codeStart = src.indexOf('*/', s) + 2
  const codeEnd = src.indexOf('[d12-fixes] pure-end')
  const exports = {}
  // eslint-disable-next-line no-new-func
  new Function('exports', src.slice(codeStart, codeEnd) + `\nObject.assign(exports, { ${names.join(', ')} })`)(exports)
  return exports
}

/* ---------------- R2: EpSubtasks inline rename + EditPanel wiring ---------------- */

test('R2: EpSubtasks declares the rename emit and renders an inline rename editor', () => {
  assert.match(SUBTASKS, /emits: \['add', 'toggle', 'remove', 'move', 'rename'\]/)
  assert.match(SUBTASKS, /@dblclick="startRename\(i\)"/)
  assert.match(SUBTASKS, /@keydown\.enter\.prevent\.stop="commitRename\(i\)"/)
  assert.match(SUBTASKS, /@blur="commitRename\(i\)"/)
})

test('R2: commitRename emits rename with (index, trimmed text) and is re-entrancy safe', () => {
  const commit = SUBTASKS.slice(SUBTASKS.indexOf('commitRename (i)'))
  assert.match(commit, /if \(this\.renameIndex !== i\) return/, 'blur after Enter commit is a no-op')
  assert.match(commit, /this\.\$emit\('rename', i, text\)/)
})

test('R2: EditPanel binds @rename and routes it through the unified save pipeline', () => {
  assert.match(PARENT, /@rename="renameSub"/)
  const fn = PARENT.slice(PARENT.indexOf('renameSub (i, text)'))
  assert.match(fn, /sub\.text = t/)
  assert.match(fn, /markDirty\('subtasks'\); this\.queueSave\(\{\}\)/)
})

/* ---------------- R15: EpTags Enter-only commit (no @blur commit) ---------------- */

test('R15: the tag input no longer commits on blur — Enter is the only commit path', () => {
  assert.doesNotMatch(TAGS, /@blur="addTag"/, 'blur must not fire addTag (surprise commit on click-away/IME)')
  assert.match(TAGS, /@keydown\.enter\.prevent="onTagEnter"/)
  // the IME guard stays on the Enter path
  assert.match(TAGS, /onTagEnter \(e\) \{\s*\n\s*if \(e\.isComposing \|\| e\.keyCode === 229\) return/)
})

/* ---------------- R5: EpReminders null-time row retention ---------------- */

test('R5: an all-null commit does not close the editor while rows are still being edited', () => {
  // Without the fix the body is `if (!list.length) { this.clearRemind(); return }` — clearing the
  // time picker on the only row closed the popover and dropped the uncommitted row.
  const commit = REMINDERS.slice(REMINDERS.indexOf('commitReminders ()'))
  assert.match(commit, /if \(!list\.length\) \{\s*\n\s*if \(!this\.remindRows\.length\) this\.clearRemind\(\)/)
  assert.doesNotMatch(commit, /if \(!list\.length\) \{ this\.clearRemind\(\); return \}/)
})

/* ---------------- R7/R8: TodoGroupBlock gear label + focus-within ---------------- */

test('R7: gear button carries an accessible label, not just a hover title', () => {
  assert.match(GROUP, /:aria-label="\$t\('statsE\.TodoGroupBlock\.groupSettingsAria'\)"/)
  assert.match(EN_E, /"groupSettingsAria": "Open this group's view settings"/)
  assert.match(ZH_E, /"groupSettingsAria": "打开本组视图设置"/)
})

test('R8: header-append buttons are revealed on focus-within, matching hover', () => {
  assert.match(GROUP, /\.todo-list-item-group__header-container:focus-within \.todo-list-item-group__header-append\{opacity:1\}/)
})

/* ---------------- R12: SnTagPanel '+N more' overflow ---------------- */

test('R12: SnTagPanel renders a +N overflow row past the 10-tag cap and emits more', () => {
  assert.match(TAGPANEL, /v-if="tags\.length > 10"/)
  assert.match(TAGPANEL, /tags\.length - 10/)
  assert.match(TAGPANEL, /emits: \['more'\]/)
  assert.match(TAGPANEL, /\$emit\('more'\)/)
  // shard contract (w5-sidenav-split): side-nav keys stay in statsG.SideNav — the row reuses
  // the existing manageTagTitle key instead of minting a new one
  assert.match(TAGPANEL, /\$t\('statsG\.SideNav\.manageTagTitle'\)/)
})

test('R12: SideNav wires the overflow row to the manage-tags modal', () => {
  assert.match(SIDENAV, /<sn-tag-panel v-if="showTagPanel" @more="tagMgrVisible = true"\/>/)
})

/* ---------------- R13: ViewMoreMenu focus return on every close path ---------------- */

test('R13: a single closeMenu path returns focus to the trigger; all close paths use it', () => {
  assert.match(VIEWMORE, /closeMenu \(\) \{/)
  const close = VIEWMORE.slice(VIEWMORE.indexOf('closeMenu ()'))
  assert.match(close, /const btn = this\.\$el && this\.\$el\.querySelector\('\.view-more-btn'\)/)
  assert.match(close, /if \(btn\) btn\.focus\(\)/)
  // Escape, item click, outside mousedown — every closer goes through closeMenu
  assert.match(VIEWMORE, /e\.key === 'Escape'[\s\S]{0,80}this\.closeMenu\(\)/)
  assert.match(VIEWMORE, /this\.closeMenu\(\)\s*\n\s*\},\s*\n\s*onDocDown/)
  assert.match(VIEWMORE, /!e\.target\.closest\('\.view-more-btn'\)\) this\.closeMenu\(\)/)
  // the trigger-click toggle keeps its own close (focus already sits on the button)
  assert.match(VIEWMORE, /if \(this\.open\) \{ this\.open = false; return \}/)
})

/* ---------------- Fault-4: WeatherWidget shape sequence token ---------------- */

test('Fault-4: loadCityShape stamps a sequence token and only the latest load assigns shape', () => {
  const fn = WEATHER.slice(WEATHER.indexOf('async loadCityShape (city)'))
  assert.match(fn, /const seq = this\._shapeSeq = \(this\._shapeSeq \|\| 0\) \+ 1/)
  assert.match(fn, /if \(seq === this\._shapeSeq\) this\.shape = s/)
  // reset() invalidates in-flight loads too
  const reset = WEATHER.slice(WEATHER.indexOf('reset () {'), WEATHER.indexOf('async loadCityShape'))
  assert.match(reset, /this\._shapeSeq = \(this\._shapeSeq \|\| 0\) \+ 1/)
})

/* ---------------- Fault-16: shape cache eviction ---------------- */

test('Fault-16: eviction planner keeps the newest `max` entries and plans the rest for deletion', () => {
  const { planShapeCacheEviction } = extractPure(WEATHER, 'WeatherWidget.vue', ['planShapeCacheEviction'])
  const entries = Array.from({ length: 45 }, (_, i) => ({ key: 'geoShape-v2-c' + i, at: 1000 + i }))
  const doomed = planShapeCacheEviction(entries, 40)
  assert.equal(doomed.length, 5, 'exactly the overflow is evicted')
  assert.deepEqual([...doomed].sort(), ['geoShape-v2-c0', 'geoShape-v2-c1', 'geoShape-v2-c2', 'geoShape-v2-c3', 'geoShape-v2-c4'],
    'the OLDEST entries (lowest at) are evicted, newest kept')
  assert.deepEqual(planShapeCacheEviction(entries.slice(0, 40), 40), [], 'at the cap nothing is evicted')
  assert.deepEqual(planShapeCacheEviction([{ key: 'k', at: 0 }, null, {}], 40), [], 'malformed entries never crash the planner')
})
