/* UX fixes round (2026-10-09):
 * [1] MatrixGrid quadrants accept cross-view drops: when no internal dragId exists, dropOn must
 *     read e.dataTransfer 'text/plain' and resolve the task from the store (mirrors DayRail.onDrop),
 *     instead of silently no-oping on the armed dragover highlight.
 * [2] the dead "holiday badges" toggle (showHolidayMarkers — no consumer, rendering never
 *     implemented) is removed from the calendar ⋮ menu (ViewMoreMenu).
 * [3] RepeatModal: a rule expanding to zero instances (all weekdays unchecked / no monthly dates)
 *     must keep Generate disabled with an inline warn, and generate() must refuse before persisting
 *     the rule (which used to overwrite saved defaults and toast 已生成 0 个).
 * [4] SettingsModal hardware-acceleration label carries a restart-required tooltip (hwAccelRestartTip).
 * [5] QuickAdd .qa-cal trigger gets @click.stop="openCal" (Space/mouse reachability for the
 *     hidden el-date-picker input).
 * [6] SettingsModal.renameUser early-returns on an unchanged name (no false "updated" toast on blur).
 * [7] HabitView empty-name warning uses habitNameRequired (the old copy mentioned a nonexistent
 *     date field); key present in BOTH locales.
 * [8] TomatoBar.showRecordList always opens the records modal (the tfr-empty state with manual-add
 *     is the teaching surface); the empty-ledger info-toast guard is gone.
 * [9] TomatoFocusRecordModal manual rest slider/input accept :min="0" (pure-focus backfill).
 * [10] TomatoFocusRecordModal saveAdd rejects a TODAY record whose interval (start + focus) ends
 *      in the future, reusing the invalidStartTime toast.
 * [11] CalendarView month-pop is a focusable role=dialog with @keydown.esc and focus-first on
 *      open (parity with the morePop sibling).
 * [12] TaskAccountModal row-switch auto-commit (saveEdit(true)) uses the quieter autoSaved toast;
 *      the explicit save button keeps the full saved success toast.
 * Run: node --test tests/unit/components/ux-fixes-round-2026-10-09.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const matrix = read('renderer/js/components/MatrixGrid.vue')
const menu = read('renderer/js/components/ViewMoreMenu.vue')
const repeat = read('renderer/js/components/RepeatModal.vue')
const settings = read('renderer/js/components/SettingsModal.vue')
const quickAdd = read('renderer/js/components/QuickAdd.vue')
const tomatoBar = read('renderer/js/components/TomatoBar.vue')
const tfrm = read('renderer/js/components/TomatoFocusRecordModal.vue')
const taskAccount = read('renderer/js/components/TaskAccountModal.vue')
const calendar = read('renderer/js/views/CalendarView.vue')
const habit = read('renderer/js/views/HabitView.vue')
const zhD = read('renderer/js/i18n/locales/zh-CN-D.js')
const enD = read('renderer/js/i18n/locales/en-US-D.js')
const zhE = read('renderer/js/i18n/locales/zh-CN-E.js')
const enE = read('renderer/js/i18n/locales/en-US-E.js')
const zhB = read('renderer/js/i18n/locales/zh-CN-B.js')
const enB = read('renderer/js/i18n/locales/en-US-B.js')
const zhK = read('renderer/js/i18n/locales/zh-CN-K.js')
const enK = read('renderer/js/i18n/locales/en-US-K.js')

test('[1] MatrixGrid dropOn reads cross-view text/plain drops and resolves from the store', () => {
  const fn = matrix.match(/dropOn \(q, e\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'dropOn(q, e) found (template passes $event)')
  assert.match(matrix, /@drop\.prevent="dropOn\(q, \$event\)"/)
  assert.match(fn[0], /e\.dataTransfer\.getData\('text\/plain'\)/)
  assert.match(fn[0], /this\.\$store\.state\.todo\.todoList\.find/)
  assert.match(fn[0], /String\(x\.taskId\) === droppedId/)
})

test('[2] dead holiday-badges toggle removed from the calendar menu', () => {
  assert.ok(!menu.includes('holidayBadgesMenuItem'), 'menu entry deleted')
  assert.ok(!/toggle: 'showHolidayMarkers'/.test(menu), 'toggle binding deleted')
})

test('[3] RepeatModal blocks zero-instance Generate (button disable + inline warn + generate guard)', () => {
  const gen = repeat.match(/generate \(\) \{[\s\S]*?\n {4}\},/)
  assert.match(repeat, /previewCount === 0/, 'Generate disabled when preview is 0')
  assert.match(repeat, /v-else-if="effectiveDates\.length === 0"/, 'inline warn for zero dates')
  assert.match(repeat, /rm-base-warn[\s\S]*?noDates/, 'warn uses the noDates key')
  assert.match(gen[0], /if \(this\.effectiveDates\.length === 0\) return/, 'generate() early-returns before persistence')
  for (const [loc, src] of [['zh-CN', zhD], ['en-US', enD]]) assert.match(src, /"noDates": "(?!")/, `${loc} has RepeatModal.noDates`)
})

test('[4] hardware-acceleration label carries the restart-required tooltip', () => {
  assert.match(settings, /:title="\$t\('statsE\.SettingsModal\.hwAccelRestartTip'\)"/)
  for (const [loc, src] of [['zh-CN', zhE], ['en-US', enE]]) assert.match(src, /"hwAccelRestartTip": "(?!")/, `${loc} has hwAccelRestartTip`)
})

test('[5] QuickAdd .qa-cal opens the picker on mouse click too', () => {
  const tag = quickAdd.match(/<span class="qa-cal"[\s\S]*?>/)[0]
  assert.match(tag, /@click\.stop="openCal"/)
})

test('[6] renameUser same-value guard (no false updated toast on blur)', () => {
  const fn = settings.match(/renameUser \(v\) \{[\s\S]*?\n {4}\},/)
  assert.match(fn[0], /name === String\(u\.userName \|\| ''\)/)
  assert.match(fn[0], /return/)
  assert.match(fn[0], /patchUser/, 'still commits on a real change')
})

test('[7] habit empty-name warning names the habit name field (key in both locales)', () => {
  const addHabit = habit.match(/addHabit \(\) \{[\s\S]*?\r?\n {4}\},/)
  assert.ok(addHabit, 'addHabit found')
  assert.match(addHabit[0], /statsB\.HabitView\.habitNameRequired/)
  assert.ok(!addHabit[0].includes('nameAndDateRequired'), 'old wrong-field copy no longer used in addHabit')
  assert.match(zhB, /habitNameRequired: '请填写习惯名称'/)
  assert.match(enB, /"habitNameRequired": "Please enter a habit name"/)
})

test('[8] TomatoBar records button always opens the modal (empty state is the teaching surface)', () => {
  const fn = tomatoBar.match(/showRecordList \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'showRecordList found')
  assert.ok(!fn[0].includes('noHarvestMsg'), 'empty-ledger toast guard removed')
  assert.match(fn[0], /toggleTomatoFocusRecord', true/)
})

test('[9] manual rest slider/input allow restDuration 0', () => {
  assert.match(tfrm, /v-model="addForm\.resetTime" :min="0" :max="30" style="flex:1"/, 'slider min=0')
  assert.match(tfrm, /v-model="addForm\.resetTime" :min="0" :max="30" size="small"/, 'input-number min=0')
})

test('[10] saveAdd rejects a today record ending in the future (invalidStartTime toast)', () => {
  const save = tfrm.match(/const end = f\.startTs \+ f\.focusTime \* 60000[\s\S]*?this\.addSaving = true/)
  assert.ok(save, 'future guard sits before the persist block')
  assert.match(save[0], /sameDay && end > now/)
  assert.match(save[0], /invalidStartTime/)
})

test('[11] calendar month-pop: Esc close + focus on open (morePop parity)', () => {
  const pop = calendar.match(/<div v-if="monthPop"[^\n]*/)[0]
  assert.match(pop, /@keydown\.esc/)
  assert.match(pop, /ref="monthPopEl"/)
  assert.match(pop, /tabindex="-1"/)
  const open = calendar.match(/toggleMonthPop \(\) \{[\s\S]*?\r?\n {4}\},/)[0]
  assert.match(open, /\$refs\.monthPopEl/)
  assert.match(open, /el\.focus\(\)/)
})

test('[12] row-switch auto-commit uses the quieter autoSaved announce', () => {
  const commit = taskAccount.match(/commitDraft \(d, auto\) \{[\s\S]*?\n {4}\},/)
  assert.ok(commit, 'commitDraft carries the auto flag')
  assert.match(commit[0], /if \(auto\) this\.\$message\.info\(this\.\$t\('statsK\.TomatoAccount\.autoSaved'\)\)/)
  assert.match(commit[0], /else this\.\$message\.success\(this\.\$t\('statsK\.TomatoAccount\.saved'\)\)/)
  assert.match(taskAccount, /this\.saveEdit\(true\)/, 'row-switch path passes auto=true')
  assert.match(taskAccount, /@click="saveEdit"/, 'explicit button keeps the full toast path')
  assert.match(zhK, /autoSaved: '已自动保存'/)
  assert.match(enK, /autoSaved: 'Saved automatically'/)
})
